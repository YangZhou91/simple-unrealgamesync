use crate::error::AppError;
use crate::models::{ChangelistEntry, SyncEvent, WorkspaceConfig};
use crate::services::disk_usage_sampler::DiskUsageSampler;
use crate::services::process_manager::ProcessManager;
use crate::utils::counting_channel::CountingChannel;
use crate::utils::log::{render_cancelled_line, render_exited_line, render_spawned_line, scope_run_with, RUN_ID, StepScope};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri_plugin_log::log::{debug, info, warn};
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
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            target_cl: None,
            parallel_threads: 4,
            exclusions: Vec::new(),
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
) -> Vec<String> {
    let mut args = vec!["sync".to_string()];

    if options.parallel_threads > 1 {
        args.push(format!("--parallel=threads={}", options.parallel_threads));
    }

    let workspace_root_scope = target_cl.is_some();
    let paths =
        resolve_non_excluded_paths(root_path, project_dir, &options.exclusions, workspace_root_scope);
    let cl_suffix = match target_cl {
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

/// Defensive parser for the `p4 sync -N` total transfer bytes (quick-260701-ep7,
/// rewritten quick-260706-ow2). The real `-N` summary is a single line of the
/// shape `Server network estimates: files added/updated/deleted=X/Y/Z, bytes
/// added/updated=D/E`. This fn extracts the two byte literals `D` and `E` from
/// the literal marker `bytes added/updated=` and returns `Some(D+E)`.
///
/// Returns `None` if:
///   - the literal marker `bytes added/updated=` is absent,
///   - the two integers don't parse as `u64`,
///   - the checked sum overflows, or
///   - the sum is `0` (a 0-byte total is NEVER a usable denominator — this is
///     the core bug fix: the old parser glued onto the deleted-files count `Z`
///     stuck to the `b` in `, bytes` and returned `Some(Z)`, which for a normal
///     sync is `Some(0)` and makes the frontend abandon the byte bar).
pub fn parse_sync_n_total_bytes(stdout: &str) -> Option<u64> {
    const MARKER: &str = "bytes added/updated=";
    let after = stdout.split(MARKER).nth(1)?;
    let bytes = after.as_bytes();

    // Read the first ASCII-digit run as D (must be non-empty).
    let mut i = 0;
    let d_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == d_start {
        return None;
    }
    let d: u64 = after[d_start..i].parse().ok()?;

    // Require a single '/' separator.
    if i >= bytes.len() || bytes[i] != b'/' {
        return None;
    }
    i += 1;

    // Read the second ASCII-digit run as E (must be non-empty).
    let e_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == e_start {
        return None;
    }
    let e: u64 = after[e_start..i].parse().ok()?;

    // Sum with overflow check; a 0-byte total is never a usable denominator.
    let sum = d.checked_add(e)?;
    if sum == 0 {
        return None;
    }
    Some(sum)
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

    /// Read the bound p4 stream of the workspace's client spec via `p4 client -o`.
    /// Returns `Ok(Some(stream))` when the client has a non-empty `Stream:`
    /// field (stream-bound client), or `Ok(None)` when the client is classic
    /// (no `Stream:` line) OR p4 fails (non-success status). Stream is
    /// informational only — a p4 failure MUST NOT surface as an error to the
    /// caller; it just means "no stream to show", which the UI renders as the
    /// pinned `classic client` placeholder.
    pub async fn get_client_stream(
        &self,
        workspace: &WorkspaceConfig,
    ) -> Result<Option<String>, AppError> {
        let mut cmd = self.build_p4_command(workspace, &["client", "-o"]);
        let output = output_with_retry(&mut cmd)
            .await
            .map_err(AppError::ProcessSpawn)?;

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            // PINNED parse rule: strip_prefix("Stream:") + trim(). No regex,
            // no split-on-whitespace — `p4 client -o` emits `Stream: <path>`
            // with a single leading space after the colon.
            if let Some(rest) = line.strip_prefix("Stream:") {
                let s = rest.trim();
                if !s.is_empty() {
                    return Ok(Some(s.to_string()));
                }
                return Ok(None);
            }
        }
        Ok(None)
    }

    #[allow(clippy::too_many_arguments)] // 9 args: sync_log_dir added by
    // quick-260630-srw; bytes_total added by quick-260701-ep7 (best-effort
    // `p4 sync -N` denominator threaded from the orchestrator's dry-run phase).
    // Grouping into a builder would be disproportionate for a quick task (the
    // existing drain args are already coupled to the p4 spawn + IPC channel +
    // cancellation trio).
    pub async fn sync(
        &self,
        workspace: &WorkspaceConfig,
        channel: &CountingChannel,
        cancel: CancellationToken,
        options: &SyncOptions,
        total: Arc<AtomicU64>,
        process_manager: Option<Arc<ProcessManager>>,
        sync_log_dir: Option<std::path::PathBuf>,
        bytes_total: Option<u64>,
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
        let spawn_start = std::time::Instant::now();
        // quick-260701-ep7: capture the p4 child PID ONCE here (before
        // stdout/stderr take — child.id() is still valid per the plan's
        // plan-checker verification) so the heartbeat can poll the child's
        // disk_usage via DiskUsageSampler. None only if id() is unavailable
        // (the heartbeat falls back to count-only Progress in that case).
        let child_pid: Option<u32> = child.id();
        if let (Some(ref pm), Some(id)) = (&process_manager, child_pid) {
            pm.track_pid(id).await;
        }

        // INSTR-09 / D-09 / D-10: process.spawned at the track_pid site. The
        // joined args are the sync subcommand args (depot paths / CL / parallel
        // flag) WITHOUT the p4 globals — render_spawned_line re-adds the masked
        // `p4 -I -C utf8 -c <P4CLIENT> -d <masked_root>` prefix and routes the
        // whole line through the D-08 redact safeguard (Plan 11-01 helper).
        info!(
            "{}",
            render_spawned_line(
                child.id().unwrap_or(0),
                &workspace.root_path,
                &args_refs.join(" ")
            )
        );

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
        // Phase 12 / D-02: capture RUN_ID ONCE before spawn (task_local does
        // not cross tokio::spawn). Re-scoped inside the task via scope_run_with
        // so every line this drain logs carries [run=<id>].
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        // quick-260630-srw: open the per-run sync file writer keyed on the
        // SAME run_id used for the [run=<id>] log tags, so the per-run file
        // name (sync-<run_id>.log) 1:1-correlates with the main log's run
        // tags. Best-effort: None means "no file logging this run" (dir
        // missing / resolver error) and sync proceeds normally. The writer
        // is moved INTO the stdout_task closure (single owner — no clone).
        let mut sync_writer = sync_log_dir
            .as_deref()
            .and_then(|dir| {
                let id = run_id.as_deref().unwrap_or("unknown");
                crate::utils::sync_run_log::SyncRunFileWriter::open(dir, id)
            })
            .unwrap_or_else(crate::utils::sync_run_log::SyncRunFileWriter::disabled);
        let stdout_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future keeps a panic from silently
            // killing the drain while child.wait() in the select! below hangs on
            // a pipe the dead task is no longer reading (RESEARCH Pitfall 5). On
            // Err the panic payload is Display-rendered via panic_payload_as_str
            // (NEVER {:?} — SC#3 gate) and logged as warn!. `catch_unwind_future`
            // (utils/log.rs) is the async-aware twin of std::catch_unwind — the
            // naive `catch_unwind(AssertUnwindSafe(async {...}))` shape does NOT
            // compile (catch_unwind requires FnOnce(), an async block is a Future);
            // the helper polls the inner future inside catch_unwind instead.
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
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
                        // quick-260630-srw: write ONLY matched-file lines to
                        // the per-run file — one entry per increment — so log
                        // entry #N maps 1:1 to the frontend progress bar
                        // reaching N. Non-file p4 lines (progress dots etc.)
                        // are skipped (they do not increment fc). Best-effort:
                        // write_line swallows all io errors internally (the
                        // drain never propagates a file-write failure).
                        if parse_sync_file_count(&line) > 0 {
                            sync_writer.write_line(
                                current,
                                total_reader.load(Ordering::Relaxed),
                                &line,
                            );
                        }
                        log_buf.push(line);
                        // Flush log batch when buffer reaches 500 lines or 200ms has elapsed.
                        // Reduces IPC calls from ~226K per-line sends to ~1130 batch sends.
                        let should_flush_log = log_buf.len() >= 500
                            || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                        if should_flush_log {
                            // Phase 12 / D-01: capture batch length + flush-start
                            // BEFORE mem::take resets log_buf (batch owns the
                            // post-take count; flush_start yields the
                            // since-previous-flush elapsed after reset).
                            let batch_len = log_buf.len();
                            let flush_start = last_log_flush;
                            let current_files = fc.load(Ordering::Relaxed);
                            let total_files = total_reader.load(Ordering::Relaxed);
                            let batch = std::mem::take(&mut log_buf);
                            let _ = ch.send(SyncEvent::LogBatch {
                                lines: batch,
                                stream: "stdout".to_string(),
                            });
                            last_log_flush = std::time::Instant::now();
                            // quick-260630-srw: piggy-back a per-run file
                            // flush on the existing 500-line / 200ms cadence
                            // so the BufWriter drains to disk periodically
                            // (best-effort; flush swallows errors).
                            sync_writer.flush();
                            // D-01 per-batch count summary — ONE line per flush,
                            // guarded by log_enabled! (HOTUI-13 eager-eval rule).
                            // Counts-only — never raw line text (T-12-DR-1).
                            if log::log_enabled!(log::Level::Debug) {
                                crate::utils::log::debug!(
                                    "stdout drained stream=stdout lines={} elapsed={}ms current={} total={}",
                                    batch_len,
                                    flush_start.elapsed().as_millis(),
                                    current_files,
                                    total_files
                                );
                            }
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
                                bytes_done: None,
                                bytes_total: None,
                                bytes_rate: None,
                            });
                        }
                    }
                    // Flush any remaining lines not yet sent
                    if !log_buf.is_empty() {
                        let batch_len = log_buf.len();
                        let flush_start = last_log_flush;
                        let current_files = fc.load(Ordering::Relaxed);
                        let total_files = total_reader.load(Ordering::Relaxed);
                        let _ = ch.send(SyncEvent::LogBatch {
                            lines: log_buf,
                            stream: "stdout".to_string(),
                        });
                        // quick-260630-srw: final per-run file flush before
                        // the drain task ends (the writer's Drop will flush
                        // once more on scope exit — belt-and-suspenders).
                        sync_writer.flush();
                        // D-01: final partial-batch summary — same shape, guarded.
                        if log::log_enabled!(log::Level::Debug) {
                            crate::utils::log::debug!(
                                "stdout drained stream=stdout lines={} elapsed={}ms current={} total={}",
                                batch_len,
                                flush_start.elapsed().as_millis(),
                                current_files,
                                total_files
                            );
                        }
                    }
                    // D-05 (Phase 12 / HOTUI-12): per-completion counter summary
                    // for the stdout drain family (the p4-sync stdout drain has
                    // no heartbeat host of its own — the heartbeat above is a
                    // separate task). ONE line per drain per run, O(1) — NOT
                    // per-event. log_enabled! guard mandatory.
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "ipc.channel drain complete stream=stdout sent_total={}",
                            ch.count()
                        );
                    }
                })
                .await;
            })
            .await
            {
                let msg = crate::utils::log::panic_payload_as_str(&payload);
                warn!("[drain] panic caught stream=stdout msg={}", msg);
            }
        });

        let ch_err = channel.clone();
        // Phase 12 / D-02: capture RUN_ID before spawn (task_local does not
        // cross tokio::spawn).
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        let stderr_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future wrap (async-aware twin of
            // std::catch_unwind — see stdout_task above for rationale).
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
                    let mut lines = stderr_reader.lines();
                    let mut log_buf: Vec<String> = Vec::with_capacity(64);
                    let mut last_log_flush = std::time::Instant::now();
                    while let Ok(Some(line)) = lines.next_line().await {
                        log_buf.push(line);
                        let should_flush_log = log_buf.len() >= 500
                            || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                        if should_flush_log {
                            // Phase 12 / D-01: stderr does not track fc/total
                            // (it only buffers) — the summary uses lines +
                            // elapsed + stream only (CONTEXT discretion: the
                            // line stays a count summary; current/total trimmed).
                            let batch_len = log_buf.len();
                            let flush_start = last_log_flush;
                            let batch = std::mem::take(&mut log_buf);
                            let _ = ch_err.send(SyncEvent::LogBatch {
                                lines: batch,
                                stream: "stderr".to_string(),
                            });
                            last_log_flush = std::time::Instant::now();
                            if log::log_enabled!(log::Level::Debug) {
                                crate::utils::log::debug!(
                                    "stderr drained stream=stderr lines={} elapsed={}ms",
                                    batch_len,
                                    flush_start.elapsed().as_millis()
                                );
                            }
                        }
                    }
                    if !log_buf.is_empty() {
                        let batch_len = log_buf.len();
                        let flush_start = last_log_flush;
                        let _ = ch_err.send(SyncEvent::LogBatch {
                            lines: log_buf,
                            stream: "stderr".to_string(),
                        });
                        if log::log_enabled!(log::Level::Debug) {
                            crate::utils::log::debug!(
                                "stderr drained stream=stderr lines={} elapsed={}ms",
                                batch_len,
                                flush_start.elapsed().as_millis()
                            );
                        }
                    }
                    // D-05 (Phase 12 / HOTUI-12): per-completion counter summary
                    // for the stderr drain family — ONE line per drain per run.
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "ipc.channel drain complete stream=stderr sent_total={}",
                            ch_err.count()
                        );
                    }
                })
                .await;
            })
            .await
            {
                let msg = crate::utils::log::panic_payload_as_str(&payload);
                warn!("[drain] panic caught stream=stderr msg={}", msg);
            }
        });

        // Heartbeat task: sends progress events every 2 seconds when no file progress
        // This prevents the UI from appearing "stuck" during large file transfers
        let ch_heartbeat = channel.clone();
        let fc_heartbeat = file_count.clone();
        let total_heartbeat = total.clone();
        // Phase 12 / D-02: capture RUN_ID before the heartbeat spawn so the
        // Plan 12-01 counter line carries [run=<id>].
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        // quick-260701-ep7: capture the `bytes_total` denominator (best-effort
        // `p4 sync -N` parse from the orchestrator's dry-run phase) so the
        // heartbeat can emit it on every tick when the sampler is live. This
        // is a one-shot value — clone the Option once into the closure.
        let bytes_total_hb = bytes_total;
        let heartbeat_task = tokio::spawn(async move {
            scope_run_with(run_id, async move {
                // quick-260701-ep7: construct the DiskUsageSampler ONCE
                // (outside the tick loop). The sampler is PID-scoped — it
                // refreshes ONLY the p4 child pid on each sample. None when
                // child_pid was unavailable at spawn (count-only fallback).
                let mut sampler = child_pid.map(DiskUsageSampler::new);
                // quick-260701-ep7: tighten heartbeat interval from 5s to ~2s
                // so the byte-level bar updates at a usable cadence.
                let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
                loop {
                    interval.tick().await;
                    let current = fc_heartbeat.load(Ordering::Relaxed);
                    let total = total_heartbeat.load(Ordering::Relaxed);
                    // quick-260701-ep7: poll the p4 child's disk activity. When
                    // the sampler yields a sample (pid live), emit the byte
                    // signal (bytesDone = accumulated, bytesRate = per-sec
                    // rate, bytesTotal = the -N denominator). When the sampler
                    // returns None (pid gone) or there is no sampler, emit
                    // None for the byte fields — the frontend falls back to
                    // the count-based bar (ADDITIVE — current/total/currentFile
                    // are always sent).
                    let (bytes_done, bytes_rate) = if let Some(ref mut s) = sampler {
                        match s.sample() {
                            Some(sampled) => {
                                // INSTRUMENTATION (quick-260701-ep7): the byte
                                // signal cannot be runtime-pre-verified without
                                // a real sync — this per-tick debug log is the
                                // empirical-validation evidence. The next real
                                // p4 sync's log MUST show non-zero delta/accumulated/rate
                                // during the transfer tail.
                                if log::log_enabled!(log::Level::Debug) {
                                    debug!(
                                        "disk_usage pid={} delta={}B accumulated={}B rate={}B/s",
                                        child_pid.unwrap_or(0),
                                        sampled.delta_bytes,
                                        sampled.accumulated_bytes,
                                        sampled.rate_bytes_per_sec
                                    );
                                }
                                (Some(sampled.accumulated_bytes), Some(sampled.rate_bytes_per_sec))
                            }
                            None => (None, None),
                        }
                    } else {
                        (None, None)
                    };
                    // Send heartbeat to show the sync is still alive
                    let _ = ch_heartbeat.send(SyncEvent::Progress {
                        current,
                        total,
                        current_file: String::new(),
                        bytes_done,
                        bytes_total: bytes_total_hb,
                        bytes_rate,
                    });
                    // D-05 (Phase 12 / HOTUI-12): sample the IPC-channel send counter
                    // on every 2s tick — ONE line per tick (O(seconds-per-sync), NOT
                    // per-event). `ch_heartbeat` is a CountingChannel clone, so its
                    // `.count()` reads the Arc-shared total incremented by every
                    // stdout/stderr/heartbeat/orchestrator `.send()`. The
                    // `log_enabled!(Debug)` guard is MANDATORY (HOTUI-13 eager-eval
                    // rule: the `format!` cost is skipped when Debug is compiled out).
                    if log::log_enabled!(log::Level::Debug) {
                        debug!(
                            "ipc.channel sent total={}",
                            ch_heartbeat.count()
                        );
                    }
                }
            })
            .await;
        });

        tokio::select! {
            status = child.wait() => {
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                heartbeat_task.abort();
                let status = status.map_err(AppError::ProcessSpawn)?;
                // INSTR-09 / D-09: process.exited fires BEFORE the success check
                // so the terminal lifecycle line always emits, success or fail.
                let pid_for_log = child.id().unwrap_or(0);
                let elapsed_for_log = spawn_start.elapsed().as_millis();
                info!(
                    "{}",
                    render_exited_line(pid_for_log, status.code(), elapsed_for_log)
                );
                if !status.success() {
                    return Err(AppError::P4Command(status.code()));
                }
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                heartbeat_task.abort();
                // INSTR-09 / D-09: process.cancelled — the distinct cancel signal
                // (kill sent + Err(Cancelled) returned to the orchestrator).
                let pid_for_log = child.id().unwrap_or(0);
                let elapsed_for_log = spawn_start.elapsed().as_millis();
                info!(
                    "{}",
                    render_cancelled_line(pid_for_log, elapsed_for_log)
                );
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
        channel: &CountingChannel,
        cancel: CancellationToken,
        process_manager: Option<Arc<ProcessManager>>,
        sync_log_dir: Option<std::path::PathBuf>,
    ) -> Result<(), AppError> {
        let args = build_force_sync_args();
        let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        // Use build_p4_command (no -I flag — log lines only, per D-06)
        let mut cmd = self.build_p4_command(workspace, &args_refs);
        let mut child = spawn_with_retry(cmd.stdout(Stdio::piped()).stderr(Stdio::piped()))
            .await
            .map_err(AppError::ProcessSpawn)?;

        // Track PID for process_manager.stop_all() support
        let spawn_start = std::time::Instant::now();
        if let (Some(ref pm), Some(id)) = (&process_manager, child.id()) {
            pm.track_pid(id).await;
        }

        // INSTR-09 / D-09 / D-10: process.spawned at the force-sync track_pid
        // site. args_refs is `build_force_sync_args()` output (`sync -f
        // UnrealEngine/Engine/{Source,Shaders,Config}/...`); the masked prefix
        // is re-added by render_spawned_line (Plan 11-01 D-08 safeguard).
        info!(
            "{}",
            render_spawned_line(
                child.id().unwrap_or(0),
                &workspace.root_path,
                &args_refs.join(" ")
            )
        );

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        // Stream stdout as LogBatch events (batched to reduce IPC call count)
        let ch_out = channel.clone();
        // Phase 12 / D-02: capture RUN_ID before spawn.
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        // quick-260630-srw: open the per-run writer from the SAME run_id + dir
        // as the primary sync drain. Because the filename is keyed only on
        // run_id (NOT on drain), force-sync appends to the SAME
        // sync-<run_id>.log the primary sync wrote, continuing the per-file
        // counter correlation. Force-sync has no dry-run total, so each
        // matched line is written with total=0 (printed verbatim — never a
        // divisor); the per-file counter is local to this drain. Best-effort:
        // None means no file logging; the drain proceeds normally.
        let mut sync_writer = sync_log_dir
            .as_deref()
            .and_then(|dir| {
                let id = run_id.as_deref().unwrap_or("unknown");
                crate::utils::sync_run_log::SyncRunFileWriter::open(dir, id)
            })
            .unwrap_or_else(crate::utils::sync_run_log::SyncRunFileWriter::disabled);
        let stdout_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future wrap (async-aware twin of
            // std::catch_unwind — see p4 sync stdout_task for rationale).
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
                    let mut lines = BufReader::new(stdout).lines();
                    let mut log_buf: Vec<String> = Vec::with_capacity(500);
                    let mut last_log_flush = std::time::Instant::now();
                    // quick-260630-srw: local matched-file counter so force-sync
                    // lines carry a 1-based {current} in the per-run file.
                    // total is unknown for force-sync (no dry-run); printed
                    // verbatim as 0 (never a divisor).
                    let mut fc_force: u64 = 0;
                    while let Ok(Some(line)) = lines.next_line().await {
                        // quick-260630-srw: write matched-file lines to the
                        // per-run file (same sync-<run_id>.log as primary
                        // sync). Best-effort; write_line swallows errors.
                        if parse_sync_file_count(&line) > 0 {
                            fc_force += 1;
                            sync_writer.write_line(fc_force, 0, &line);
                        }
                        log_buf.push(line);
                        let should_flush_log = log_buf.len() >= 500
                            || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                        if should_flush_log {
                            // Phase 12 / D-01: force-sync stdout drain has no
                            // fc/total counters (it only buffers) — summary uses
                            // lines + elapsed + stream (CONTEXT discretion).
                            let batch_len = log_buf.len();
                            let flush_start = last_log_flush;
                            let batch = std::mem::take(&mut log_buf);
                            let _ = ch_out.send(SyncEvent::LogBatch {
                                lines: batch,
                                stream: "stdout".to_string(),
                            });
                            last_log_flush = std::time::Instant::now();
                            // quick-260630-srw: piggy-back per-run file flush.
                            sync_writer.flush();
                            if log::log_enabled!(log::Level::Debug) {
                                crate::utils::log::debug!(
                                    "stdout drained stream=stdout lines={} elapsed={}ms",
                                    batch_len,
                                    flush_start.elapsed().as_millis()
                                );
                            }
                        }
                    }
                    if !log_buf.is_empty() {
                        let batch_len = log_buf.len();
                        let flush_start = last_log_flush;
                        let _ = ch_out.send(SyncEvent::LogBatch {
                            lines: log_buf,
                            stream: "stdout".to_string(),
                        });
                        // quick-260630-srw: final per-run file flush (Drop
                        // flushes once more on scope exit).
                        sync_writer.flush();
                        if log::log_enabled!(log::Level::Debug) {
                            crate::utils::log::debug!(
                                "stdout drained stream=stdout lines={} elapsed={}ms",
                                batch_len,
                                flush_start.elapsed().as_millis()
                            );
                        }
                    }
                    // D-05 (Phase 12 / HOTUI-12): force-sync has NO heartbeat task, so
                    // the counter line fires as a per-completion summary instead — ONE
                    // line per drain per run, O(1). log_enabled! guard mandatory.
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "ipc.channel drain complete stream=stdout sent_total={}",
                            ch_out.count()
                        );
                    }
                })
                .await;
            })
            .await
            {
                let msg = crate::utils::log::panic_payload_as_str(&payload);
                warn!("[drain] panic caught stream=stdout msg={}", msg);
            }
        });

        // Stream stderr as LogBatch events (batched to reduce IPC call count)
        let ch_err = channel.clone();
        // Phase 12 / D-02: capture RUN_ID before spawn.
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        let stderr_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future wrap (async-aware twin of
            // std::catch_unwind — see p4 sync stdout_task for rationale).
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
                    let mut lines = BufReader::new(stderr).lines();
                    let mut log_buf: Vec<String> = Vec::with_capacity(64);
                    let mut last_log_flush = std::time::Instant::now();
                    while let Ok(Some(line)) = lines.next_line().await {
                        log_buf.push(line);
                        let should_flush_log = log_buf.len() >= 500
                            || last_log_flush.elapsed() >= std::time::Duration::from_millis(200);
                        if should_flush_log {
                            let batch_len = log_buf.len();
                            let flush_start = last_log_flush;
                            let batch = std::mem::take(&mut log_buf);
                            let _ = ch_err.send(SyncEvent::LogBatch {
                                lines: batch,
                                stream: "stderr".to_string(),
                            });
                            last_log_flush = std::time::Instant::now();
                            if log::log_enabled!(log::Level::Debug) {
                                crate::utils::log::debug!(
                                    "stderr drained stream=stderr lines={} elapsed={}ms",
                                    batch_len,
                                    flush_start.elapsed().as_millis()
                                );
                            }
                        }
                    }
                    if !log_buf.is_empty() {
                        let batch_len = log_buf.len();
                        let flush_start = last_log_flush;
                        let _ = ch_err.send(SyncEvent::LogBatch {
                            lines: log_buf,
                            stream: "stderr".to_string(),
                        });
                        if log::log_enabled!(log::Level::Debug) {
                            crate::utils::log::debug!(
                                "stderr drained stream=stderr lines={} elapsed={}ms",
                                batch_len,
                                flush_start.elapsed().as_millis()
                            );
                        }
                    }
                    // D-05 (Phase 12 / HOTUI-12): force-sync stderr per-completion
                    // counter summary — ONE line per drain per run.
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "ipc.channel drain complete stream=stderr sent_total={}",
                            ch_err.count()
                        );
                    }
                })
                .await;
            })
            .await
            {
                let msg = crate::utils::log::panic_payload_as_str(&payload);
                warn!("[drain] panic caught stream=stderr msg={}", msg);
            }
        });

        // Use tokio::select! for cancellation support
        // Note: caller (SyncOrchestrator) owns clear_tracked() — matches sync() pattern
        tokio::select! {
            status = child.wait() => {
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                let status = status.map_err(AppError::ProcessSpawn)?;
                // INSTR-09 / D-09: process.exited — always fires (before success
                // check) so the force-sync terminal lifecycle line emits on
                // both success and failure paths.
                let pid_for_log = child.id().unwrap_or(0);
                let elapsed_for_log = spawn_start.elapsed().as_millis();
                info!(
                    "{}",
                    render_exited_line(pid_for_log, status.code(), elapsed_for_log)
                );
                if !status.success() {
                    return Err(AppError::P4Command(status.code()));
                }
                Ok(())
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                // INSTR-09 / D-09: process.cancelled on the cancel arm.
                let pid_for_log = child.id().unwrap_or(0);
                let elapsed_for_log = spawn_start.elapsed().as_millis();
                info!(
                    "{}",
                    render_cancelled_line(pid_for_log, elapsed_for_log)
                );
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
        // D-14: the behind-check dry-run is its own `step=dryRun`. StepScope
        // emits `step=dryRun starting` here and a terminal `done`/`failed`/
        // `cancelled`/`dropped` line with elapsed on Drop — on EVERY return path
        // (the structural D-12 guarantee). The done/failed/cancelled markers
        // below pin the outcome text; even if a return path forgets one, Drop
        // still emits a greppable `dropped` terminal so a forgotten path stays
        // distinct from a real hang (which has NO terminal at all).
        let _dry_scope = StepScope::new("dryRun");

        // Don't use -I for dry run (no actual transfer, no progress needed)
        let args = build_p4_sync_args(
            options,
            &workspace.root_path,
            &workspace.project_dir,
            &options.target_cl,
        );
        let mut full_args = args.clone();
        full_args.insert(1, "-n".to_string()); // Insert after "sync" subcommand

        let args_refs: Vec<&str> = full_args.iter().map(|s| s.as_str()).collect();

        let mut cmd = self.build_p4_command(workspace, &args_refs);
        let mut child = spawn_with_retry(cmd.stdout(Stdio::piped()).stderr(Stdio::null()))
            .await
            .map_err(AppError::ProcessSpawn)?;

        // Track the p4 dry-run process PID so stop_all can kill it
        let spawn_start = std::time::Instant::now();
        if let (Some(ref pm), Some(id)) = (&process_manager, child.id()) {
            pm.track_pid(id).await;
        }

        // INSTR-09 / D-09 / D-10: process.spawned at the dry-run track_pid site.
        // full_args includes `-n` and the sync subcommand args; render_spawned_line
        // re-adds the masked `p4 -I -C utf8 -c <P4CLIENT> -d <masked_root>` prefix
        // (Plan 11-01 D-08 safeguard).
        info!(
            "{}",
            render_spawned_line(
                child.id().unwrap_or(0),
                &workspace.root_path,
                &args_refs.join(" ")
            )
        );

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

        let pid_for_log = child.id().unwrap_or(0);
        tokio::select! {
            result = tokio::time::timeout(
                std::time::Duration::from_secs(120),
                child.wait(),
            ) => {
                match result {
                    Ok(status) => {
                        let status = status.map_err(AppError::ProcessSpawn)?;
                        let count = read_task.await.unwrap_or(0);
                        // INSTR-09 / D-09: process.exited — emit BEFORE the
                        // success check so the terminal lifecycle line always
                        // fires (success or `Ok(0)` fallback).
                        info!(
                            "{}",
                            render_exited_line(
                                pid_for_log,
                                status.code(),
                                spawn_start.elapsed().as_millis()
                            )
                        );
                        if !status.success() {
                            _dry_scope.failed();
                            return Ok(0);
                        }
                        info!("[dry_run] completed, total files: {count}");
                        _dry_scope.done(&format!("files_behind={count}"));
                        Ok(count)
                    }
                    Err(_) => {
                        let _ = child.kill().await;
                        let _ = read_task.await;
                        warn!("[dry_run] timed out after 120s, proceeding with total=0");
                        // INSTR-09 / D-09: record the timeout as an exit-with-
                        // no-code (child killed, code unknown). The dry-run
                        // step is marked failed so Drop logs `failed` terminal.
                        info!(
                            "{}",
                            render_exited_line(
                                pid_for_log,
                                None,
                                spawn_start.elapsed().as_millis()
                            )
                        );
                        _dry_scope.failed();
                        Ok(0)
                    }
                }
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                let _ = read_task.await;
                warn!("[dry_run] cancelled by user");
                // INSTR-09 / D-09: process.cancelled on the cancel arm.
                info!(
                    "{}",
                    render_cancelled_line(
                        pid_for_log,
                        spawn_start.elapsed().as_millis()
                    )
                );
                _dry_scope.cancelled();
                Err(AppError::Cancelled)
            }
        }
    }

    /// Best-effort `p4 sync -N` denominator for the byte-level progress bar
    /// (quick-260701-ep7). `p4 sync -N` is the "network preview" / summary
    /// form that reports the transfer size Perforce would pull. The format is
    /// NOT hardcoded (the workspace is often 0-behind so it cannot be
    /// pre-tested) — parsing is DEFENSIVE: any uncertainty (command error,
    /// timeout, unparseable output) yields `None`, and sync proceeds with a
    /// rate-only bar.
    ///
    /// T-ep7-02 / T-ep7-03: the entire call is wrapped in a 60s
    /// `tokio::time::timeout`; ALL errors (spawn, timeout, parse, status)
    /// map to `None`. The parse scans stdout for a numeric token adjacent to
    /// a unit hint (bytes/KB/MB/GB/k/M/G) and scales; no `unwrap`/`expect` on
    /// parsed values.
    ///
    /// This MUST NOT block the real sync — callers run it concurrently with /
    /// after the `-n` count and pass `Option<u64>` into `sync()`.
    pub async fn sync_n_total_bytes(
        &self,
        workspace: &WorkspaceConfig,
        options: &SyncOptions,
    ) -> Option<u64> {
        // Build the SAME args the real sync uses (depot paths / CL / parallel),
        // then insert -N (network summary) after "sync" — mirrors dry_run_sync's
        // -n insertion shape.
        let args = build_p4_sync_args(
            options,
            &workspace.root_path,
            &workspace.project_dir,
            &options.target_cl,
        );
        let mut full_args = args.clone();
        full_args.insert(1, "-N".to_string());
        let args_refs: Vec<&str> = full_args.iter().map(|s| s.as_str()).collect();

        // T-ep7-02: 60s timeout — any failure below short-circuits to None via
        // the catch-all match at the bottom.
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            async {
                let mut cmd = self.build_p4_command(workspace, &args_refs);
                // stdout piped + stderr null — we only parse the summary line.
                cmd.stdout(Stdio::piped()).stderr(Stdio::null());
                output_with_retry(&mut cmd).await
            },
        )
        .await
        .ok()?
        .ok()?;

        if !output.status.success() {
            info!("[sync-N] non-success status, bytes_total=None");
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed = parse_sync_n_total_bytes(&stdout);
        // T-ep7-03: log the parse outcome — this is the empirical-validation
        // log for the denominator. Some(v) = parse succeeded; None = -N output
        // did not match the expected shape (workspace may be 0-behind or the
        // format differs).
        info!("[sync-N] bytes_total parsed: {:?}", parsed);
        parsed
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

    // --- Tests for parse_sync_n_total_bytes (quick-260706-ow2) ---

    #[test]
    fn test_parse_sync_n_total_bytes_single_file() {
        let stdout =
            "Server network estimates: files added/updated/deleted=0/1/0, bytes added/updated=0/54761";
        assert_eq!(Some(54761), parse_sync_n_total_bytes(stdout));
    }

    #[test]
    fn test_parse_sync_n_total_bytes_large() {
        // D + E = 12345 + 4300000000 = 4300012345 (exercises u64 + non-trivial D).
        let stdout = "Server network estimates: files added/updated/deleted=120/164000/0, bytes added/updated=12345/4300000000";
        assert_eq!(Some(4300012345), parse_sync_n_total_bytes(stdout));
    }

    #[test]
    fn test_parse_sync_n_total_bytes_zero_behind_is_none() {
        // 0-behind: D=E=0 → sum is 0 → None (never a usable denominator; this
        // is the core bug fix — the old parser returned Some(0) via the deleted
        // count Z glued to ", bytes").
        let stdout =
            "Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/0";
        assert_eq!(None, parse_sync_n_total_bytes(stdout));
    }

    #[test]
    fn test_parse_sync_n_total_bytes_missing_literal_is_none() {
        let stdout = "some other p4 output";
        assert_eq!(None, parse_sync_n_total_bytes(stdout));
    }

    #[test]
    fn test_parse_sync_n_total_bytes_empty_is_none() {
        assert_eq!(None, parse_sync_n_total_bytes(""));
    }

    // --- New tests for SyncOptions and arg-builder functions ---

    #[test]
    fn test_build_p4_sync_args_no_options() {
        let options = SyncOptions::default();
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None);
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
        };
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None);
        assert_eq!(args, vec!["sync", "//..."]);
    }

    #[test]
    fn test_build_p4_sync_args_with_cl() {
        let options = SyncOptions::default();
        let target_cl = Some("12345".to_string());
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &target_cl);
        assert!(args.contains(&"//...@12345".to_string()));
        assert_eq!(args[0], "sync");
    }

    #[test]
    fn test_build_p4_sync_args_parallel_threads() {
        let options = SyncOptions {
            parallel_threads: 4,
            ..Default::default()
        };
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None);
        assert!(args.contains(&"--parallel=threads=4".to_string()));
    }

    #[test]
    fn test_build_p4_sync_args_no_parallel_when_one_thread() {
        let options = SyncOptions {
            parallel_threads: 1,
            ..Default::default()
        };
        let args = build_p4_sync_args(&options, "E:\\test", "MyGame", &None);
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
        };
        let args = build_p4_sync_args(&options, tmp_dir.to_str().unwrap(), "MyGame", &options.target_cl);

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
                "check_connectivity took {}ms, expected <9000ms",
                elapsed.as_millis()
            );
        });
    }
}
