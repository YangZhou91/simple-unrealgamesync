use crate::error::AppError;
use crate::models::{ChangelistEntry, SyncEvent, WorkspaceConfig};
use crate::services::process_manager::ProcessManager;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri_plugin_log::log::{info, warn};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Windows CREATE_NO_WINDOW flag to prevent console window popup.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Apply Windows-specific flags to hide console windows.
#[cfg(target_os = "windows")]
fn command_no_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn command_no_window(_cmd: &mut Command) {}

/// Windows ERROR_SHARING_VIOLATION (os error 32).
/// Occurs when antivirus, search indexer, or another process momentarily locks
/// the executable or a related file during CreateProcess.
const ERROR_SHARING_VIOLATION: i32 = 32;

/// Maximum number of retry attempts for transient spawn errors (os error 32).
const SPAWN_RETRY_ATTEMPTS: u32 = 3;

/// Delay between retry attempts for transient spawn errors.
const SPAWN_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

/// Check if an io::Error is a Windows sharing violation (os error 32).
fn is_sharing_violation(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(ERROR_SHARING_VIOLATION)
}

/// Execute a `.output()` call on a Command with retry logic for transient
/// Windows sharing violations (os error 32). Retries up to SPAWN_RETRY_ATTEMPTS
/// times with SPAWN_RETRY_DELAY between attempts. Non-sharing-violation errors
/// propagate immediately.
async fn output_with_retry(cmd: &mut Command) -> std::io::Result<std::process::Output> {
    let mut attempts = 0;
    loop {
        match cmd.output().await {
            Ok(output) => return Ok(output),
            Err(e) if is_sharing_violation(&e) && attempts < SPAWN_RETRY_ATTEMPTS => {
                attempts += 1;
                warn!(
                    "[spawn] os error 32 (sharing violation) on attempt {}/{}, retrying in {}ms",
                    attempts,
                    SPAWN_RETRY_ATTEMPTS,
                    SPAWN_RETRY_DELAY.as_millis()
                );
                tokio::time::sleep(SPAWN_RETRY_DELAY).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Execute a `.spawn()` call on a Command with retry logic for transient
/// Windows sharing violations (os error 32).
async fn spawn_with_retry(cmd: &mut Command) -> std::io::Result<tokio::process::Child> {
    let mut attempts = 0;
    loop {
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e) if is_sharing_violation(&e) && attempts < SPAWN_RETRY_ATTEMPTS => {
                attempts += 1;
                warn!(
                    "[spawn] os error 32 (sharing violation) on attempt {}/{}, retrying in {}ms",
                    attempts,
                    SPAWN_RETRY_ATTEMPTS,
                    SPAWN_RETRY_DELAY.as_millis()
                );
                tokio::time::sleep(SPAWN_RETRY_DELAY).await;
            }
            Err(e) => return Err(e),
        }
    }
}

pub struct SyncOptions {
    pub target_cl: Option<String>,
    pub parallel_threads: u32,
    pub exclusions: Vec<String>,
    /// Internal CL snapshot captured from `p4 changes -m1` at dry-run time.
    /// Used to pin the sync (`@CL` suffix) for normal updates (target_cl=None)
    /// WITHOUT enabling full-sync scope (workspace_root_scope / forceSync stay off).
    /// Explicit CL / rollback (target_cl=Some) ignores this. None on capture failure.
    pub pin_cl: Option<String>,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            target_cl: None,
            parallel_threads: 4,
            exclusions: Vec::new(),
            pin_cl: None,
        }
    }
}

pub fn validate_target_cl(cl: &str) -> Result<(), AppError> {
    if cl.chars().all(|c| c.is_ascii_digit()) && !cl.is_empty() {
        Ok(())
    } else {
        Err(AppError::Process(format!(
            "Invalid changelist number: '{}'. Must be numeric.",
            cl
        )))
    }
}

pub fn validate_exclusion_path(path: &str) -> Result<(), AppError> {
    if path.is_empty() {
        return Err(AppError::Process("Exclusion path cannot be empty".into()));
    }
    // Reject path traversal via ".."
    if path
        .split(|c: char| c == '/' || c == '\\')
        .any(|component| component == "..")
    {
        return Err(AppError::Process(format!(
            "Invalid exclusion path: '{}'. Path traversal ('..') is not allowed.",
            path
        )));
    }
    // Reject absolute paths (Windows drive letters, leading slash/backslash)
    if path.starts_with('/') || path.starts_with('\\') || path.contains(':') {
        return Err(AppError::Process(format!(
            "Invalid exclusion path: '{}'. Must be a relative path under the project directory.",
            path
        )));
    }
    Ok(())
}

/// Check which exclusion paths do NOT exist under the workspace's project directory.
/// Returns a list of paths that don't exist on disk.
pub fn check_exclusion_paths_exist(
    root_path: &str,
    project_dir: &str,
    exclusions: &[String],
) -> Vec<String> {
    let root = Path::new(root_path);
    let candidates = [
        root.join(format!("UnrealEngine/{}", project_dir)),
        root.join(project_dir),
    ];
    let default_path = root.join(project_dir);
    let project_path = candidates
        .iter()
        .find(|p| p.exists())
        .unwrap_or(&default_path);

    exclusions
        .iter()
        .filter(|ex| {
            // Check if the path segment exists under the project dir
            // For "Binaries" -> check <project>/Binaries/
            // For "Content/Developers" -> check <project>/Content/Developers/
            let full_path = project_path.join(ex.replace('\\', "/"));
            !full_path.exists()
        })
        .cloned()
        .collect()
}

pub fn resolve_non_excluded_paths(
    root_path: &str,
    project_dir: &str,
    exclusions: &[String],
    workspace_root_scope: bool,
) -> Vec<String> {
    if exclusions.is_empty() && !workspace_root_scope {
        return vec!["//...".to_string()];
    }

    // Project dir may be at root/<project>/ or root/UnrealEngine/<project>/ depending on client view
    let root = Path::new(root_path);
    let project_candidates = [
        root.join(format!("UnrealEngine/{}", project_dir)),
        root.join(project_dir),
    ];

    let default_path = root.join(project_dir);
    let project_path = project_candidates
        .iter()
        .find(|p| {
            p.exists()
                && std::fs::read_dir(p)
                    .map(|mut d| d.next().is_some())
                    .unwrap_or(false)
        })
        .unwrap_or(&default_path);

    // Build the relative project prefix for p4 sync paths
    let project_rel = project_path
        .strip_prefix(root)
        .unwrap_or(Path::new(project_dir))
        .to_string_lossy()
        .replace('\\', "/");

    let mut paths = Vec::new();
    if let Ok(entries) = std::fs::read_dir(project_path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            // Fully excluded top-level directory (e.g. "Binaries", "Intermediate")
            if exclusions.contains(&name) {
                continue;
            }

            // Check for nested exclusions (e.g. "Content/Developers", "Content/TestData")
            let nested_exclusions: Vec<&String> = exclusions
                .iter()
                .filter(|e| e.starts_with(&format!("{}/", name)))
                .collect();

            if nested_exclusions.is_empty() {
                // No nested exclusions — include whole directory
                paths.push(format!("{}/{}/...", project_rel, name));
            } else {
                // Has nested exclusions — list children, skip excluded sub-paths
                let child_dir = project_path.join(&name);
                if let Ok(child_entries) = std::fs::read_dir(&child_dir) {
                    for child_entry in child_entries.flatten() {
                        let child_name = child_entry.file_name().to_string_lossy().to_string();
                        let full_child = format!("{}/{}", name, child_name);
                        if !exclusions.contains(&full_child) {
                            paths.push(format!("{}/{}/{}/...", project_rel, name, child_name));
                        }
                    }
                }
            }
        }
    }

    // Workspace-root scope: also resolve UnrealEngine/ paths (per D-03, D-04, D-06)
    if workspace_root_scope {
        let ue_dir = root.join("UnrealEngine");
        if ue_dir.exists() {
            if let Ok(ue_entries) = std::fs::read_dir(&ue_dir) {
                for ue_entry in ue_entries.flatten() {
                    let ue_name = ue_entry.file_name().to_string_lossy().to_string();

                    if ue_name == "Engine" {
                        // Enumerate Engine children, skip Binaries (hardcoded exclusion per D-06)
                        let engine_dir = ue_dir.join("Engine");
                        if let Ok(engine_entries) = std::fs::read_dir(&engine_dir) {
                            for eng_entry in engine_entries.flatten() {
                                let eng_name = eng_entry.file_name().to_string_lossy().to_string();
                                if eng_name == "Binaries" {
                                    continue;
                                }
                                paths.push(format!("UnrealEngine/Engine/{}/...", eng_name));
                            }
                        }
                    } else {
                        paths.push(format!("UnrealEngine/{}/...", ue_name));
                    }
                }
            }
        }
    }

    // Fallback: if no paths resolved (directory doesn't exist), use default
    if paths.is_empty() {
        vec!["//...".to_string()]
    } else {
        paths
    }
}

pub fn build_p4_sync_args(
    options: &SyncOptions,
    root_path: &str,
    project_dir: &str,
    target_cl: &Option<String>,
    pin_cl: &Option<String>,
) -> Vec<String> {
    let mut args = vec!["sync".to_string()];

    if options.parallel_threads > 1 {
        args.push(format!("--parallel=threads={}", options.parallel_threads));
    }

    // Scope is gated by the EXPLICIT target_cl only. pin_cl must NOT flip
    // workspace_root_scope — otherwise a lightweight project-only update would
    // silently become a full Engine sync and trigger forceSync. Decoupled by design.
    let workspace_root_scope = target_cl.is_some();
    let paths =
        resolve_non_excluded_paths(root_path, project_dir, &options.exclusions, workspace_root_scope);
    // Effective CL: explicit target_cl wins; otherwise fall back to pin_cl (the
    // dry-run snapshot) so the actual sync is bounded to the same CL the dry-run
    // previewed — keeping dry-run and real-sync file sets identical (no overrun).
    let effective_cl = target_cl.as_ref().or(pin_cl.as_ref());
    let cl_suffix = match effective_cl {
        Some(cl) => format!("@{}", cl),
        None => String::new(),
    };

    for path in &paths {
        args.push(format!("{}{}", path, cl_suffix));
    }

    args
}

/// Build p4 sync -f args for Engine subtree (Source, Shaders, Config).
/// Force sync re-evaluates all files under Engine after normal sync, restoring
/// git-modified files to depot state. No --parallel, no -I, no -n.
pub fn build_force_sync_args() -> Vec<String> {
    vec![
        "sync".to_string(),
        "-f".to_string(),
        "UnrealEngine/Engine/Source/...".to_string(),
        "UnrealEngine/Engine/Shaders/...".to_string(),
        "UnrealEngine/Engine/Config/...".to_string(),
    ]
}

struct ActiveBehindCheck {
    id: u64,
    token: CancellationToken,
}

pub struct P4Executor {
    active_behind_check: Mutex<Option<ActiveBehindCheck>>,
    next_behind_check_id: AtomicU64,
}

impl P4Executor {
    pub fn new() -> Self {
        Self {
            active_behind_check: Mutex::new(None),
            next_behind_check_id: AtomicU64::new(0),
        }
    }

    pub async fn begin_behind_check(&self) -> (u64, CancellationToken) {
        let id = self.next_behind_check_id.fetch_add(1, Ordering::SeqCst) + 1;
        let token = CancellationToken::new();
        let mut active = self.active_behind_check.lock().await;
        if let Some(previous) = active.take() {
            previous.token.cancel();
        }
        *active = Some(ActiveBehindCheck {
            id,
            token: token.clone(),
        });
        (id, token)
    }

    pub async fn finish_behind_check(&self, id: u64) {
        let mut active = self.active_behind_check.lock().await;
        if active.as_ref().map(|check| check.id) == Some(id) {
            *active = None;
        }
    }

    pub async fn cancel_behind_check(&self) {
        let mut active = self.active_behind_check.lock().await;
        if let Some(check) = active.take() {
            check.token.cancel();
        }
    }

    /// Check P4 server connectivity by running `p4 info -s` with a 5-second timeout.
    /// Returns Ok(()) if the server is reachable, or an AppError otherwise.
    /// Includes retry logic for Windows sharing violations (os error 32) caused by
    /// antivirus scanning or file locking during process spawn.
    pub async fn check_connectivity(&self, workspace: &WorkspaceConfig) -> Result<(), AppError> {
        let result = tokio::time::timeout(std::time::Duration::from_secs(8), async {
            let mut cmd = self.build_p4_command(workspace, &["info", "-s"]);
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            output_with_retry(&mut cmd).await
        })
        .await;

        match result {
            Err(_) => {
                // Timeout elapsed (includes time spent in retries)
                Err(AppError::Process(
                    "Connection to P4 server timed out. Check your network connection and P4PORT setting.".to_string(),
                ))
            }
            Ok(Err(e)) => {
                // Process spawn error (retries exhausted or non-retryable error)
                Err(AppError::ProcessSpawn(e))
            }
            Ok(Ok(output)) => {
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    Err(AppError::Process(format!(
                        "P4 server is unreachable: {}",
                        stderr.trim()
                    )))
                } else {
                    Ok(())
                }
            }
        }
    }

    fn build_p4_command(&self, workspace: &WorkspaceConfig, args: &[&str]) -> Command {
        let mut cmd = Command::new("p4");
        command_no_window(&mut cmd);
        cmd.args([
            "-C",
            "utf8",
            "-c",
            &workspace.p4_client,
            "-d",
            &workspace.root_path,
        ]);
        cmd.args(args);
        cmd.stdin(Stdio::null());
        cmd
    }

    pub async fn get_have_changelist(
        &self,
        workspace: &WorkspaceConfig,
    ) -> Result<Option<String>, AppError> {
        // Use //client_name/...#have instead of //...#have because
        // the -d flag on Windows causes //... to be resolved as a local path
        let client_path = format!("//{}/...#have", workspace.p4_client);
        let mut cmd = self.build_p4_command(workspace, &["changes", "-m1", &client_path]);
        let output = output_with_retry(&mut cmd)
            .await
            .map_err(AppError::ProcessSpawn)?;

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.lines().next().unwrap_or("");
        // Format: "Change 12345 on 2024/01/01 by user@client"
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 && parts[0] == "Change" {
            Ok(Some(parts[1].to_string()))
        } else {
            Ok(None)
        }
    }

    /// Latest submitted changelist touching the same paths a sync would touch
    /// (same scope/exclusions as `build_p4_sync_args`). Snapshots HEAD at dry-run
    /// time so the actual sync can be pinned to it via `pin_cl`, keeping the
    /// dry-run preview and the real sync file sets identical (no progress overrun).
    ///
    /// Returns `None` on any error or empty result — callers fall back to HEAD.
    pub async fn get_latest_changelist(
        &self,
        workspace: &WorkspaceConfig,
        options: &SyncOptions,
    ) -> Option<String> {
        let scope = options.target_cl.is_some();
        let paths = resolve_non_excluded_paths(
            &workspace.root_path,
            &workspace.project_dir,
            &options.exclusions,
            scope,
        );
        if paths.is_empty() {
            return None;
        }

        let mut args: Vec<String> = vec!["changes".to_string(), "-m1".to_string()];
        args.extend(paths);
        let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        let mut cmd = self.build_p4_command(workspace, &args_refs);
        let output = match output_with_retry(&mut cmd).await {
            Ok(o) => o,
            Err(_) => return None,
        };

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        parse_head_changelist(&stdout)
    }

    pub async fn sync(
        &self,
        workspace: &WorkspaceConfig,
        channel: &Channel<SyncEvent>,
        cancel: CancellationToken,
        options: &SyncOptions,
        total: Arc<AtomicU64>,
        process_manager: Option<Arc<ProcessManager>>,
    ) -> Result<u64, AppError> {
        // Validate target_cl if provided
        if let Some(ref cl) = options.target_cl {
            validate_target_cl(cl)?;
        }

        let args = build_p4_sync_args(
            options,
            &workspace.root_path,
            &workspace.project_dir,
            &options.target_cl,
            &options.pin_cl,
        );
        let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        // Build command with -I global flag for progress indicators
        let mut cmd = Command::new("p4");
        command_no_window(&mut cmd);
        cmd.args([
            "-I",
            "-C",
            "utf8",
            "-c",
            &workspace.p4_client,
            "-d",
            &workspace.root_path,
        ]);
        cmd.args(&args_refs);

        let mut child = spawn_with_retry(
            cmd.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .await
        .map_err(AppError::ProcessSpawn)?;

        // Track the p4 process PID so stop_all can kill it via taskkill
        if let (Some(ref pm), Some(id)) = (&process_manager, child.id()) {
            pm.track_pid(id).await;
        }

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let stdout_reader = BufReader::new(stdout);
        let stderr_reader = BufReader::new(stderr);
        let file_count = Arc::new(AtomicU64::new(0));
        let last_progress_sent = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

        let ch = channel.clone();
        let fc = file_count.clone();
        let total_reader = total.clone();
        let lps = last_progress_sent.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = stdout_reader.lines();
            let mut log_buf: Vec<String> = Vec::with_capacity(500);
            let mut last_log_flush = std::time::Instant::now();
            while let Ok(Some(line)) = lines.next_line().await {
                let current = if parse_sync_file_count(&line) > 0 {
                    fc.fetch_add(1, Ordering::Relaxed) + 1
                } else {
                    fc.load(Ordering::Relaxed)
                };
                let current_file = extract_sync_file_path(&line);
                log_buf.push(line);
                // Flush log batch when buffer reaches 500 lines or 200ms has elapsed.
                // Reduces IPC calls from ~226K per-line sends to ~1130 batch sends.
                let should_flush_log = log_buf.len() >= 500
                    || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                if should_flush_log {
                    let batch = std::mem::take(&mut log_buf);
                    let _ = ch.send(SyncEvent::LogBatch {
                        lines: batch,
                        stream: "stdout".to_string(),
                    });
                    last_log_flush = std::time::Instant::now();
                }
                // Throttle Progress events to ~200ms intervals to avoid UI freeze
                let should_send = {
                    let mut guard = lps.lock().unwrap();
                    if guard.elapsed() >= std::time::Duration::from_millis(200) {
                        *guard = std::time::Instant::now();
                        true
                    } else {
                        false
                    }
                };
                if should_send {
                    let _ = ch.send(SyncEvent::Progress {
                        current,
                        total: total_reader.load(Ordering::Relaxed),
                        current_file,
                    });
                }
            }
            // Flush any remaining lines not yet sent
            if !log_buf.is_empty() {
                let _ = ch.send(SyncEvent::LogBatch {
                    lines: log_buf,
                    stream: "stdout".to_string(),
                });
            }
        });

        let ch_err = channel.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = stderr_reader.lines();
            let mut log_buf: Vec<String> = Vec::with_capacity(64);
            let mut last_log_flush = std::time::Instant::now();
            while let Ok(Some(line)) = lines.next_line().await {
                log_buf.push(line);
                let should_flush_log = log_buf.len() >= 500
                    || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                if should_flush_log {
                    let batch = std::mem::take(&mut log_buf);
                    let _ = ch_err.send(SyncEvent::LogBatch {
                        lines: batch,
                        stream: "stderr".to_string(),
                    });
                    last_log_flush = std::time::Instant::now();
                }
            }
            if !log_buf.is_empty() {
                let _ = ch_err.send(SyncEvent::LogBatch {
                    lines: log_buf,
                    stream: "stderr".to_string(),
                });
            }
        });

        // Heartbeat task: sends progress events every 5 seconds when no file progress
        // This prevents the UI from appearing "stuck" during large file transfers
        let ch_heartbeat = channel.clone();
        let fc_heartbeat = file_count.clone();
        let total_heartbeat = total.clone();
        let heartbeat_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                let current = fc_heartbeat.load(Ordering::Relaxed);
                let total = total_heartbeat.load(Ordering::Relaxed);
                // Send heartbeat to show the sync is still alive
                let _ = ch_heartbeat.send(SyncEvent::Progress {
                    current,
                    total,
                    current_file: String::new(),
                });
            }
        });

        tokio::select! {
            status = child.wait() => {
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                heartbeat_task.abort();
                let status = status.map_err(AppError::ProcessSpawn)?;
                if !status.success() {
                    return Err(AppError::P4Command(status.code()));
                }
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                heartbeat_task.abort();
                return Err(AppError::Cancelled);
            }
        }

        let total = file_count.load(Ordering::Relaxed);
        Ok(total)
    }

    /// Force sync the Engine subtree (Source, Shaders, Config) using `p4 sync -f`.
    /// This runs after normal sync to restore git-modified Engine files that normal
    /// sync skips when the same CL is already synced. Non-fatal in the pipeline.
    /// Streams LogLine events only (no progress/heartbeat per D-06).
    pub async fn force_sync_engine(
        &self,
        workspace: &WorkspaceConfig,
        channel: &Channel<SyncEvent>,
        cancel: CancellationToken,
        process_manager: Option<Arc<ProcessManager>>,
    ) -> Result<(), AppError> {
        let args = build_force_sync_args();
        let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        // Use build_p4_command (no -I flag — log lines only, per D-06)
        let mut cmd = self.build_p4_command(workspace, &args_refs);
        let mut child = spawn_with_retry(cmd.stdout(Stdio::piped()).stderr(Stdio::piped()))
            .await
            .map_err(AppError::ProcessSpawn)?;

        // Track PID for process_manager.stop_all() support
        if let (Some(ref pm), Some(id)) = (&process_manager, child.id()) {
            pm.track_pid(id).await;
        }

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        // Stream stdout as LogBatch events (batched to reduce IPC call count)
        let ch_out = channel.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut log_buf: Vec<String> = Vec::with_capacity(500);
            let mut last_log_flush = std::time::Instant::now();
            while let Ok(Some(line)) = lines.next_line().await {
                log_buf.push(line);
                let should_flush_log = log_buf.len() >= 500
                    || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                if should_flush_log {
                    let batch = std::mem::take(&mut log_buf);
                    let _ = ch_out.send(SyncEvent::LogBatch {
                        lines: batch,
                        stream: "stdout".to_string(),
                    });
                    last_log_flush = std::time::Instant::now();
                }
            }
            if !log_buf.is_empty() {
                let _ = ch_out.send(SyncEvent::LogBatch {
                    lines: log_buf,
                    stream: "stdout".to_string(),
                });
            }
        });

        // Stream stderr as LogBatch events (batched to reduce IPC call count)
        let ch_err = channel.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut log_buf: Vec<String> = Vec::with_capacity(64);
            let mut last_log_flush = std::time::Instant::now();
            while let Ok(Some(line)) = lines.next_line().await {
                log_buf.push(line);
                let should_flush_log = log_buf.len() >= 500
                    || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                if should_flush_log {
                    let batch = std::mem::take(&mut log_buf);
                    let _ = ch_err.send(SyncEvent::LogBatch {
                        lines: batch,
                        stream: "stderr".to_string(),
                    });
                    last_log_flush = std::time::Instant::now();
                }
            }
            if !log_buf.is_empty() {
                let _ = ch_err.send(SyncEvent::LogBatch {
                    lines: log_buf,
                    stream: "stderr".to_string(),
                });
            }
        });

        // Use tokio::select! for cancellation support
        // Note: caller (SyncOrchestrator) owns clear_tracked() — matches sync() pattern
        tokio::select! {
            status = child.wait() => {
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                let status = status.map_err(AppError::ProcessSpawn)?;
                if !status.success() {
                    return Err(AppError::P4Command(status.code()));
                }
                Ok(())
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                Err(AppError::Cancelled)
            }
        }
    }

    pub async fn dry_run_sync(
        &self,
        workspace: &WorkspaceConfig,
        options: &SyncOptions,
        cancel: CancellationToken,
        process_manager: Option<Arc<ProcessManager>>,
    ) -> Result<u64, AppError> {
        // Don't use -I for dry run (no actual transfer, no progress needed)
        let args = build_p4_sync_args(
            options,
            &workspace.root_path,
            &workspace.project_dir,
            &options.target_cl,
            &options.pin_cl,
        );
        let mut full_args = args.clone();
        full_args.insert(1, "-n".to_string()); // Insert after "sync" subcommand

        let args_refs: Vec<&str> = full_args.iter().map(|s| s.as_str()).collect();

        let mut cmd = self.build_p4_command(workspace, &args_refs);
        let mut child = spawn_with_retry(cmd.stdout(Stdio::piped()).stderr(Stdio::null()))
            .await
            .map_err(AppError::ProcessSpawn)?;

        // Track the p4 dry-run process PID so stop_all can kill it
        if let (Some(ref pm), Some(id)) = (&process_manager, child.id()) {
            pm.track_pid(id).await;
        }

        let stdout = child.stdout.take().unwrap();
        let stdout_reader = BufReader::new(stdout);
        let read_task = tokio::spawn(async move {
            let mut lines = stdout_reader.lines();
            let mut count: u64 = 0;
            while let Ok(Some(line)) = lines.next_line().await {
                if parse_sync_file_count(&line) > 0 {
                    count += 1;
                }
            }
            count
        });

        tokio::select! {
            result = tokio::time::timeout(
                std::time::Duration::from_secs(120),
                child.wait(),
            ) => {
                match result {
                    Ok(status) => {
                        let status = status.map_err(AppError::ProcessSpawn)?;
                        let count = read_task.await.unwrap_or(0);
                        if !status.success() {
                            return Ok(0);
                        }
                        info!("[dry_run] completed, total files: {count}");
                        Ok(count)
                    }
                    Err(_) => {
                        let _ = child.kill().await;
                        let _ = read_task.await;
                        warn!("[dry_run] timed out after 120s, proceeding with total=0");
                        Ok(0)
                    }
                }
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = read_task.await;
                warn!("[dry_run] cancelled by user");
                Err(AppError::Cancelled)
            }
        }
    }

    pub async fn get_changelists(
        &self,
        workspace: &WorkspaceConfig,
        batch_size: u32,
        after_cl: Option<&str>,
    ) -> Result<Vec<ChangelistEntry>, AppError> {
        // Cap batch_size at 100 to prevent excessive p4 output (T-03-03)
        let batch = batch_size.min(100);

        let mut args: Vec<String> = vec![
            "changes".to_string(),
            "-l".to_string(),
            "-s".to_string(),
            "submitted".to_string(),
            format!("-m{}", batch),
        ];

        match after_cl {
            Some(cl) => args.push(format!("//...@>{}", cl)),
            None => args.push("//...".to_string()),
        }

        let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        let mut cmd = self.build_p4_command(workspace, &args_refs);
        let output = output_with_retry(&mut cmd)
            .await
            .map_err(AppError::ProcessSpawn)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Process(format!(
                "p4 changes failed: {}",
                stderr.trim()
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(parse_changelists(&stdout))
    }
}

/// Parse the first `Change NNNNN on ...` line from `p4 changes` output.
/// Used by `get_latest_changelist` to snapshot HEAD at dry-run time.
fn parse_head_changelist(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 2 && parts[0] == "Change" {
        Some(parts[1].to_string())
    } else {
        None
    }
}

fn parse_sync_file_count(line: &str) -> u64 {
    if line.contains(" - updating ") || line.contains(" - added as ") || line.contains(" - deleted")
    {
        1
    } else {
        0
    }
}

fn extract_sync_file_path(line: &str) -> String {
    for sep in &[" - updating ", " - added as "] {
        if let Some(idx) = line.find(sep) {
            let local_path = &line[idx + sep.len()..];
            return local_path.trim().to_string();
        }
    }
    // Deleted files: path is before " - deleted"
    // e.g. "//depot/MyGame/file.txt#3 - deleted"
    if let Some(idx) = line.find(" - deleted") {
        let depot_path = &line[..idx];
        return depot_path
            .rsplit_once(|c: char| c == '/' || c == '\\')
            .map(|(_, name)| name.split_once('#').map(|(n, _)| n).unwrap_or(name))
            .unwrap_or("")
            .to_string();
    }
    String::new()
}

/// Parse `p4 changes -l` output into structured ChangelistEntry records.
/// Each entry starts with "Change " on a new line; continuation lines (not
/// starting with "Change ") are appended to the current entry's description.
pub fn parse_changelists(output: &str) -> Vec<ChangelistEntry> {
    let mut entries = Vec::new();
    let mut current: Option<ChangelistEntry> = None;

    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("Change ") {
            // Verify this is a real entry header by checking that the first
            // token after "Change " is a numeric CL number. This prevents
            // continuation lines like "Change the rendering pipeline..." from
            // being misparsed as new entries.
            let first_token = rest.splitn(2, ' ').next().unwrap_or("");
            if first_token.chars().all(|c| c.is_ascii_digit()) && !first_token.is_empty() {
                // Finalize previous entry
                if let Some(entry) = current.take() {
                    entries.push(entry);
                }

                // Parse header: "Change 12345 on 2024/01/15 by user@client *pending* Fix bug"
                // After stripping "Change ", we have: "12345 on 2024/01/15 by user@client *pending* Fix bug"
                let parts: Vec<&str> = rest.splitn(6, ' ').collect();
                if parts.len() >= 6 {
                    let number = parts[0].to_string();
                    // parts[1] = "on"
                    let date = parts[2].to_string();
                    // parts[3] = "by"
                    let user_client = parts[4]; // "user@client" or "user@client"
                    let description = parts[5].to_string();

                    let (user, client) = match user_client.rsplit_once('@') {
                        Some((u, c)) => (u.to_string(), c.to_string()),
                        None => (user_client.to_string(), String::new()),
                    };

                    current = Some(ChangelistEntry {
                        number,
                        date,
                        user,
                        client,
                        description,
                    });
                } else if parts.len() >= 5 {
                    // Entry without description on the first line
                    let number = parts[0].to_string();
                    let date = parts[2].to_string();
                    let user_client = parts[4];

                    let (user, client) = match user_client.rsplit_once('@') {
                        Some((u, c)) => (u.to_string(), c.to_string()),
                        None => (user_client.to_string(), String::new()),
                    };

                    current = Some(ChangelistEntry {
                        number,
                        date,
                        user,
                        client,
                        description: String::new(),
                    });
                }
            } else if let Some(ref mut entry) = current {
                // "Change " prefix but not a valid header -- treat as continuation
                if !entry.description.is_empty() {
                    entry.description.push('\n');
                }
                entry.description.push_str(line);
            }
        } else if let Some(ref mut entry) = current {
            // Continuation line -- append to description
            if !entry.description.is_empty() {
                entry.description.push('\n');
            }
            entry.description.push_str(line);
        }
    }

    // Finalize last entry
    if let Some(entry) = current.take() {
        entries.push(entry);
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_parse_sync_file_updating() {
        assert_eq!(
            1,
            parse_sync_file_count("//depot/MyGame/file.txt#5 - updating E:\\MyGame\\file.txt")
        );
    }

    #[test]
    fn test_parse_sync_file_added() {
        assert_eq!(
            1,
            parse_sync_file_count("//depot/MyGame/new.txt#1 - added as E:\\MyGame\\new.txt")
        );
    }

    #[test]
    fn test_parse_sync_file_deleted() {
        assert_eq!(
            1,
            parse_sync_file_count("//depot/MyGame/old.txt#3 - deleted")
        );
    }

    #[test]
    fn test_parse_sync_file_info_line() {
        assert_eq!(0, parse_sync_file_count("... file(s) up-to-date."));
    }

    // --- New tests for SyncOptions and arg-builder functions ---

    #[test]
    fn test_build_p4_sync_args_no_options() {
        let options = SyncOptions::default();
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None, &None);
        // Default SyncOptions has parallel_threads=4, so --parallel is included
        assert_eq!(args[0], "sync");
        assert!(args.contains(&"--parallel=threads=4".to_string()));
        assert!(args.contains(&"//...".to_string()));
    }

    #[test]
    fn test_build_p4_sync_args_no_threads_no_cl() {
        // Explicit test for ["sync", "//..."] with threads=1 and no CL
        let options = SyncOptions {
            target_cl: None,
            parallel_threads: 1,
            exclusions: vec![],
            pin_cl: None,
        };
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None, &None);
        assert_eq!(args, vec!["sync", "//..."]);
    }

    #[test]
    fn test_build_p4_sync_args_with_cl() {
        let options = SyncOptions::default();
        let target_cl = Some("12345".to_string());
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &target_cl, &None);
        assert!(args.contains(&"//...@12345".to_string()));
        assert_eq!(args[0], "sync");
    }

    #[test]
    fn test_build_p4_sync_args_parallel_threads() {
        let options = SyncOptions {
            parallel_threads: 4,
            ..Default::default()
        };
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None, &None);
        assert!(args.contains(&"--parallel=threads=4".to_string()));
    }

    #[test]
    fn test_build_p4_sync_args_no_parallel_when_one_thread() {
        let options = SyncOptions {
            parallel_threads: 1,
            ..Default::default()
        };
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None, &None);
        assert!(!args.iter().any(|a| a.contains("--parallel")));
    }

    #[test]
    fn test_validate_target_cl_numeric() {
        assert!(validate_target_cl("12345").is_ok());
    }

    #[test]
    fn test_validate_target_cl_non_numeric() {
        assert!(validate_target_cl("abc").is_err());
    }

    #[test]
    fn test_validate_target_cl_mixed() {
        assert!(validate_target_cl("12a34").is_err());
    }

    #[test]
    fn test_validate_exclusion_path_normal() {
        assert!(validate_exclusion_path("Binaries").is_ok());
    }

    #[test]
    fn test_validate_exclusion_path_traversal() {
        assert!(validate_exclusion_path("../etc").is_err());
    }

    #[test]
    fn test_validate_exclusion_path_backslash_traversal() {
        assert!(validate_exclusion_path("..\\etc").is_err());
    }

    #[test]
    fn test_resolve_non_excluded_paths_empty() {
        let paths = resolve_non_excluded_paths("E:\\nonexistent", "MyGame", &[], false);
        assert_eq!(paths, vec!["//..."]);
    }

    #[test]
    fn test_resolve_non_excluded_paths_with_exclusions() {
        // Create a temp directory structure: tmp/MyGame/{Binaries,Content,Config}
        let tmp_dir = std::env::temp_dir().join("p4_test_exclusions");
        let game_dir = tmp_dir.join("MyGame");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Binaries")).unwrap();
        fs::create_dir_all(game_dir.join("Content")).unwrap();
        fs::create_dir_all(game_dir.join("Config")).unwrap();

        let exclusions = vec!["Binaries".to_string()];
        let paths = resolve_non_excluded_paths(tmp_dir.to_str().unwrap(), "MyGame", &exclusions, false);

        assert!(!paths.iter().any(|p| p.contains("Binaries")));
        assert!(paths.iter().any(|p| p.contains("Content")));
        assert!(paths.iter().any(|p| p.contains("Config")));

        // Cleanup
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_non_excluded_paths_multiple_exclusions() {
        let tmp_dir = std::env::temp_dir().join("p4_test_multi_exclusions");
        let game_dir = tmp_dir.join("MyGame");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Binaries")).unwrap();
        fs::create_dir_all(game_dir.join("Content")).unwrap();
        fs::create_dir_all(game_dir.join("Config")).unwrap();

        let exclusions = vec!["Binaries".to_string(), "Config".to_string()];
        let paths = resolve_non_excluded_paths(tmp_dir.to_str().unwrap(), "MyGame", &exclusions, false);

        assert!(!paths.iter().any(|p| p.contains("Binaries")));
        assert!(!paths.iter().any(|p| p.contains("Config")));
        assert!(paths.iter().any(|p| p.contains("Content")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_non_excluded_paths_nested_exclusions() {
        let tmp_dir = std::env::temp_dir().join("p4_test_nested_exclusions");
        let game_dir = tmp_dir.join("MyGame");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Binaries")).unwrap();
        fs::create_dir_all(game_dir.join("Content/Developers")).unwrap();
        fs::create_dir_all(game_dir.join("Content/TestData")).unwrap();
        fs::create_dir_all(game_dir.join("Content/Audio")).unwrap();
        fs::create_dir_all(game_dir.join("Intermediate")).unwrap();

        let exclusions = vec![
            "Binaries".to_string(),
            "Content/Developers".to_string(),
            "Content/TestData".to_string(),
            "Intermediate".to_string(),
        ];
        let paths = resolve_non_excluded_paths(tmp_dir.to_str().unwrap(), "MyGame", &exclusions, false);

        assert!(!paths.iter().any(|p| p.contains("Binaries")));
        assert!(!paths.iter().any(|p| p.contains("Intermediate")));
        assert!(!paths.iter().any(|p| p.contains("Developers")));
        assert!(!paths.iter().any(|p| p.contains("TestData")));
        assert!(paths.iter().any(|p| p.contains("Content/Audio")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_build_p4_sync_args_with_exclusions_and_cl() {
        let tmp_dir = std::env::temp_dir().join("p4_test_args_cl");
        let game_dir = tmp_dir.join("MyGame");
        let ue_dir = tmp_dir.join("UnrealEngine");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Content")).unwrap();
        fs::create_dir_all(game_dir.join("Binaries")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Config")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Binaries")).unwrap();

        let options = SyncOptions {
            target_cl: Some("99999".to_string()),
            parallel_threads: 4,
            exclusions: vec!["Binaries".to_string()],
            pin_cl: None,
        };
        let args = build_p4_sync_args(&options, tmp_dir.to_str().unwrap(), "MyGame", &options.target_cl, &None);

        assert!(args.contains(&"--parallel=threads=4".to_string()));
        // Should have Content path with @CL suffix
        assert!(args
            .iter()
            .any(|a| a.contains("Content") && a.contains("@99999")));
        // Should NOT have Binaries
        assert!(!args.iter().any(|a| a.contains("Binaries")));
        // Should include UnrealEngine paths (workspace_root_scope=true because target_cl is Some)
        assert!(args
            .iter()
            .any(|a| a.contains("UnrealEngine") && a.contains("@99999")));
        // Should NOT include Engine/Binaries
        assert!(!args.iter().any(|a| a.contains("Engine/Binaries")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_build_p4_sync_args_pin_cl_without_full_scope() {
        // pin_cl must append @CL but NOT enable workspace_root_scope. Contrast
        // test_build_p4_sync_args_with_exclusions_and_cl (target_cl=Some -> scope
        // true -> UnrealEngine included): here target_cl=None + pin_cl keeps scope
        // off, so the sync stays project-only despite the @CL suffix.
        let tmp_dir = std::env::temp_dir().join("p4_test_args_pin");
        let game_dir = tmp_dir.join("MyGame");
        let ue_dir = tmp_dir.join("UnrealEngine");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Content")).unwrap();
        fs::create_dir_all(game_dir.join("Binaries")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Config")).unwrap();

        let options = SyncOptions {
            target_cl: None,
            parallel_threads: 1,
            exclusions: vec!["Binaries".to_string()],
            pin_cl: Some("77777".to_string()),
        };
        let args = build_p4_sync_args(
            &options,
            tmp_dir.to_str().unwrap(),
            "MyGame",
            &None,
            &options.pin_cl,
        );

        // Project Content path carries the pinned @CL suffix
        assert!(args
            .iter()
            .any(|a| a.contains("Content") && a.contains("@77777")));
        // Excluded Binaries is not present
        assert!(!args.iter().any(|a| a.contains("Binaries")));
        // Crucially: UnrealEngine is NOT included — scope stays project-only
        // even though a pin CL is present (decoupled from the @CL suffix).
        assert!(!args.iter().any(|a| a.contains("UnrealEngine")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_parse_head_changelist() {
        assert_eq!(
            parse_head_changelist("Change 12345 on 2024/01/01 by user@client"),
            Some("12345".to_string())
        );
        // Only the first line matters
        assert_eq!(
            parse_head_changelist(
                "Change 999 on 2024/01/01 by u@c\nChange 998 on 2024/01/01 by u@c"
            ),
            Some("999".to_string())
        );
        // Empty / malformed -> None (graceful fallback)
        assert_eq!(parse_head_changelist(""), None);
        assert_eq!(parse_head_changelist("no changes"), None);
    }

    // --- Tests for parse_changelists ---

    #[test]
    fn test_parse_changelists_empty() {
        let entries = parse_changelists("");
        assert!(entries.is_empty());
    }

    #[test]
    fn test_parse_changelists_single_entry() {
        let input = "Change 12345 on 2024/01/15 by user@client *pending* Fix bug";
        let entries = parse_changelists(input);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].number, "12345");
        assert_eq!(entries[0].date, "2024/01/15");
        assert!(entries[0].user.contains("user"));
        assert!(entries[0].client.contains("client"));
        assert!(entries[0].description.contains("Fix bug"));
    }

    #[test]
    fn test_parse_changelists_multiple_entries() {
        let input = "Change 12345 on 2024/01/15 by user@client *pending* Fix bug\nChange 12344 on 2024/01/14 by user2@client2 *pending* Add feature";
        let entries = parse_changelists(input);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].number, "12345");
        assert_eq!(entries[1].number, "12344");
    }

    #[test]
    fn test_parse_changelists_multiline_description() {
        let input = "Change 12345 on 2024/01/15 by user@client *pending* Fix bug\n\nThis is a multi-line description\nThat spans several lines\nChange 12344 on 2024/01/14 by user2@client2 *pending* Add feature";
        let entries = parse_changelists(input);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].description.contains("multi-line"));
        assert!(entries[0].description.contains("several lines"));
        assert!(entries[1].description.contains("Add feature"));
    }

    // --- Tests for workspace_root_scope expansion ---

    #[test]
    fn test_resolve_workspace_root_paths() {
        let tmp_dir = std::env::temp_dir().join("p4_test_workspace_root");
        let game_dir = tmp_dir.join("MyGame");
        let ue_dir = tmp_dir.join("UnrealEngine");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Content")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Config")).unwrap();

        let paths = resolve_non_excluded_paths(tmp_dir.to_str().unwrap(), "MyGame", &[], true);

        assert!(paths.iter().any(|p| p.contains("MyGame/Content")));
        assert!(paths.iter().any(|p| p.contains("UnrealEngine/Engine")));
        // Engine/Binaries should NOT be present
        assert!(!paths.iter().any(|p| p.contains("Engine/Binaries")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_project_only_paths() {
        let tmp_dir = std::env::temp_dir().join("p4_test_project_only");
        let game_dir = tmp_dir.join("MyGame");
        let ue_dir = tmp_dir.join("UnrealEngine");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Content")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Config")).unwrap();

        let paths = resolve_non_excluded_paths(tmp_dir.to_str().unwrap(), "MyGame", &[], false);

        // With empty exclusions and workspace_root_scope=false, returns default
        assert_eq!(paths, vec!["//..."]);
        assert!(!paths.iter().any(|p| p.contains("UnrealEngine")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_ue_binaries_excluded() {
        let tmp_dir = std::env::temp_dir().join("p4_test_ue_binaries");
        let ue_dir = tmp_dir.join("UnrealEngine");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(ue_dir.join("Engine/Binaries")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Config")).unwrap();

        let paths = resolve_non_excluded_paths(tmp_dir.to_str().unwrap(), "MyGame", &[], true);

        assert!(!paths.iter().any(|p| p.contains("Engine/Binaries")));
        assert!(paths.iter().any(|p| p.contains("Engine/Config")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_resolve_workspace_root_no_ue_dir() {
        let tmp_dir = std::env::temp_dir().join("p4_test_no_ue");
        let game_dir = tmp_dir.join("MyGame");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(game_dir.join("Content")).unwrap();

        let paths = resolve_non_excluded_paths(tmp_dir.to_str().unwrap(), "MyGame", &[], true);

        // Project paths should still be returned normally
        assert!(paths.iter().any(|p| p.contains("MyGame")));
        // No crash, no UnrealEngine paths
        assert!(!paths.iter().any(|p| p.contains("UnrealEngine")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    // --- Tests for build_force_sync_args (Task 1, TDD RED) ---

    #[test]
    fn test_build_force_sync_args_returns_correct_args() {
        let args = build_force_sync_args();
        assert_eq!(args[0], "sync", "first arg must be 'sync'");
        assert!(args.contains(&"-f".to_string()), "must contain -f flag");
        assert_eq!(
            args.len(),
            5,
            "should have exactly 5 args: sync, -f, and 3 paths"
        );
    }

    #[test]
    fn test_build_force_sync_args_exact_paths() {
        let args = build_force_sync_args();
        assert!(
            args.contains(&"UnrealEngine/Engine/Source/...".to_string()),
            "must contain UnrealEngine/Engine/Source/..."
        );
        assert!(
            args.contains(&"UnrealEngine/Engine/Shaders/...".to_string()),
            "must contain UnrealEngine/Engine/Shaders/..."
        );
        assert!(
            args.contains(&"UnrealEngine/Engine/Config/...".to_string()),
            "must contain UnrealEngine/Engine/Config/..."
        );
        // Verify exact ordering: sync, -f, Source, Shaders, Config
        assert_eq!(
            args,
            vec![
                "sync",
                "-f",
                "UnrealEngine/Engine/Source/...",
                "UnrealEngine/Engine/Shaders/...",
                "UnrealEngine/Engine/Config/...",
            ]
        );
    }

    #[test]
    fn test_build_force_sync_args_no_parallel_flag() {
        let args = build_force_sync_args();
        assert!(
            !args.iter().any(|a| a.contains("--parallel")),
            "force sync must NOT have --parallel flag"
        );
    }

    // --- Tests for sharing violation detection ---

    #[test]
    fn test_is_sharing_violation_os_error_32() {
        let e = std::io::Error::from_raw_os_error(32);
        assert!(is_sharing_violation(&e));
    }

    #[test]
    fn test_is_sharing_violation_other_error() {
        let e = std::io::Error::from_raw_os_error(2); // file not found
        assert!(!is_sharing_violation(&e));
    }

    #[test]
    fn test_is_sharing_violation_non_os_error() {
        let e = std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out");
        assert!(!is_sharing_violation(&e));
    }

    #[test]
    fn test_check_connectivity_timeout() {
        // This test verifies timeout behavior by spawning a long-running command.
        // Marked #[ignore] because it takes 5 seconds.
        // Testing with a dummy workspace that has non-existent p4 settings
        // will cause p4 to hang trying to connect.
        // For a reliable test, we use a command that blocks for >5 seconds.
        use std::time::Duration;

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // Verify timeout fires at ~8 seconds (updated from 5s to account for retries)
            let start = std::time::Instant::now();
            let executor = P4Executor::new();
            let workspace = WorkspaceConfig {
                id: String::new(),
                name: "test".to_string(),
                root_path: "E:\\nonexistent_test_path".to_string(),
                project_dir: "MyGame".to_string(),
                p4_client: "nonexistent_client".to_string(),
                p4_user: String::new(),
                parallel_threads: 4,
                exclusions: vec![],
                last_sync_cl: None,
                last_sync_time: None,
                last_sync_file_count: None,
                interval_minutes: 60,
            };
            // This will either timeout or fail quickly with a connection error
            let _ = executor.check_connectivity(&workspace).await;
            // If it timed out, it should have taken ~8 seconds
            // If it failed quickly (no p4 server), that's also acceptable
            let elapsed = start.elapsed();
            // Should not take longer than 9 seconds (8s timeout + overhead)
            assert!(
                elapsed < Duration::from_secs(9),
                "check_connectivity took {:?}, expected <9s",
                elapsed
            );
        });
    }
}
