use crate::error::AppError;
use crate::models::{ChangelistEntry, SyncEvent, WarningEntry, WarningSeverity, WorkspaceConfig};
use crate::services::disk_usage_sampler::DiskUsageSampler;
use crate::services::process_manager::ProcessManager;
use crate::utils::counting_channel::CountingChannel;
use crate::utils::log::{render_cancelled_line, render_exited_line, render_spawned_line, scope_run_with, RUN_ID, StepScope};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    /// When true (opt-in), a Target CL sync includes the UnrealEngine engine
    /// subtree (`UnrealEngine/Engine/{Source,Shaders,Config}/...`) pinned to
    /// the target CL. When false (default), a Target CL sync skips the engine
    /// so the subsequent `git pull` of UnrealEngine stays clean. Has NO effect
    /// on a normal HEAD sync (target_cl=None → gate never fires, engine block
    /// is never reached). Rollback always forces `include_engine: true`
    /// (engine version pinned to the target CL is part of rollback semantics).
    pub include_engine: bool,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            target_cl: None,
            parallel_threads: 4,
            exclusions: Vec::new(),
            include_engine: false,
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
                        // Skip the project dir itself — already covered
                        // granularly above as
                        // UnrealEngine/<project_dir>/<child>/... . A catch-all
                        // here re-covers the same files; p4 sync dedupes
                        // overlapping paths at transfer time, but `p4 sync -N`
                        // estimates each path independently → the project's
                        // byte estimate gets counted twice in the denominator
                        // (saw ~959.7 GB phantom bytes on a Revision/@CL
                        // sync — bogus byte-bar denominator; quick-260707-s1y).
                        // Other UE sibling subdirs (FeaturePacks, etc.) still
                        // get their catch-all — the guard is targeted.
                        if ue_name == project_dir {
                            continue;
                        }
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

    let workspace_root_scope = target_cl.is_some() && options.include_engine;
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
/// rewritten quick-260706-ow2, multi-line summation quick-260706-pvk). The real
/// `-N` summary is one line per depot subpath of the shape `Server network
/// estimates: files added/updated/deleted=X/Y/Z, bytes added/updated=D/E`.
///
/// The app's real `p4 sync -N` invocation (built by `build_p4_sync_args`) passes
/// ~47 depot subpaths, so stdout contains ~47 `bytes added/updated=` markers —
/// one per subpath. The first several markers are usually the leading subpaths'
/// `0/0` estimates (already-in-sync subpaths). This fn SUMS `D+E` across ALL
/// markers; previously it read only the FIRST segment via `.nth(1)`, which on a
/// real multi-path sync is the first subpath's `0/0` → the whole parse yielded
/// `None` and the byte bar denominator vanished.
///
/// For each marker segment after the literal `bytes added/updated=`, the fn
/// reads the leading `<digits>/<digits>` as `D` and `E`. A segment that does
/// NOT match that shape (empty digit run, missing `/`, or `.parse()` failure)
/// is SKIPPED (`continue`) — the parse is resilient to stray text between
/// markers and never aborts on a single bad segment.
///
/// Returns `None` if:
///   - no well-formed segment contributes bytes (i.e. no marker is present, or
///     every segment is malformed), or
///   - any per-segment `D+E` or the running total overflows `u64` (`checked_add`
///     semantics), or
///   - the running sum is `0` (a 0-byte total is NEVER a usable denominator —
///     this is the core ow2 bug fix: the old parser glued onto the deleted-files
///     count `Z` stuck to the `b` in `, bytes` and returned `Some(Z)`, which for
///     a normal sync is `Some(0)` and makes the frontend abandon the byte bar).
pub fn parse_sync_n_total_bytes(stdout: &str) -> Option<u64> {
    const MARKER: &str = "bytes added/updated=";

    // quick-260718-eje: strip the `-s` severity tag from each line before the
    // marker-split so an `info:` prefix can't offset a marker, and so the
    // terminal `exit: 0` line's digits are explicitly excluded from parsing
    // (its segment has no marker, but the strip makes the guarantee local
    // rather than relying on the marker-split's incident behavior).
    let normalized: String = stdout
        .lines()
        .map(strip_p4_prefix)
        .collect::<Vec<_>>()
        .join("\n");

    // Split on the marker. Element 0 is the text BEFORE the first marker (skip
    // it via `.skip(1)`); every remaining element is the text immediately
    // following one `bytes added/updated=` marker.
    let mut total: u64 = 0;
    for segment in normalized.split(MARKER).skip(1) {
        let bytes = segment.as_bytes();

        // Read the first ASCII-digit run as D (must be non-empty).
        let mut i = 0;
        let d_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == d_start {
            continue; // malformed segment — skip, do NOT abort
        }
        let d: u64 = match segment[d_start..i].parse::<u64>().ok() {
            Some(v) => v,
            None => continue,
        };

        // Require a single '/' separator.
        if i >= bytes.len() || bytes[i] != b'/' {
            continue;
        }
        i += 1;

        // Read the second ASCII-digit run as E (must be non-empty).
        let e_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == e_start {
            continue;
        }
        let e: u64 = match segment[e_start..i].parse::<u64>().ok() {
            Some(v) => v,
            None => continue,
        };

        // Per-segment D+E with overflow check.
        let segment_sum = d.checked_add(e)?;
        // Running total with overflow check.
        total = total.checked_add(segment_sum)?;
    }

    // A 0-byte total is never a usable denominator (preserved ow2 contract).
    if total == 0 {
        None
    } else {
        Some(total)
    }
}

struct ActiveBehindCheck {
    id: u64,
    token: CancellationToken,
}

pub struct P4Executor {
    active_behind_check: Mutex<Option<ActiveBehindCheck>>,
    next_behind_check_id: AtomicU64,
}

/// Shared global args for EVERY p4 spawn (quick-260718-eje). `-s` comes
/// FIRST: script mode severity-tags every stdout line
/// (`info:`/`warning:`/`error:`/`exit:`); all parsers strip the tag via
/// `split_p4_severity` (zero behavior change — parsed values identical).
fn p4_global_args(workspace: &WorkspaceConfig) -> Vec<String> {
    vec![
        "-s".to_string(),
        "-C".to_string(),
        "utf8".to_string(),
        "-c".to_string(),
        workspace.p4_client.clone(),
        "-d".to_string(),
        workspace.root_path.clone(),
    ]
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
                    // quick-260718-eje: with `-s` the diagnostic may be routed
                    // onto stdout as `error:`-tagged lines (stderr empty) —
                    // fall back to those so the message stays informative.
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stderr = stderr.trim();
                    let detail = if !stderr.is_empty() {
                        stderr.to_string()
                    } else {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        stdout
                            .lines()
                            .filter_map(|line| match split_p4_severity(line) {
                                (P4Severity::Error, rest) => Some(rest),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("; ")
                    };
                    Err(AppError::Process(format!(
                        "P4 server is unreachable: {}",
                        detail
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
        // quick-260718-eje: globals via the shared helper — carries `-s`
        // (script mode) first, so all 9 helper call sites get tagged output.
        cmd.args(p4_global_args(workspace));
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
        // quick-260718-eje: extracted free fn (severity-aware — strips the
        // `info:` tag `-s` now applies, skips `error:`/`exit:` lines).
        Ok(parse_have_changelist(&stdout))
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
        // quick-260718-eje: extracted free fn (severity-aware — strips the
        // `info:` tag `-s` now applies, skips `error:`/`exit:` lines; the
        // strip_prefix("Stream:") + trim rule itself is unchanged).
        Ok(parse_client_stream(&stdout))
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

        // Build command with -I global flag for progress indicators.
        // quick-260718-eje: keep `-I` (inert on a pipe; dropping it is a
        // separate user decision — it silently disables --parallel), and add
        // `-s` via the shared globals so every stdout line is severity-tagged.
        let mut cmd = Command::new("p4");
        command_no_window(&mut cmd);
        cmd.arg("-I");
        cmd.args(p4_global_args(workspace));
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
        // Diagnostic: log the RAW `-N` stdout so the per-subpath `Server network
        // estimates:` lines are visible. Used to diagnose denominator anomalies
        // (e.g. a Revision/@CL sync parsing as ~1TB vs ~36GB for HEAD on the same
        // workspace — needs the raw lines to tell a p4 estimate quirk from a
        // parser double-count). Debug level only — the stdout can be ~3-5KB across
        // ~47 subpaths; never want this at info.
        debug!("[sync-N] raw stdout ({} bytes): {}", stdout.len(), stdout);
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
            // quick-260718-eje: with `-s` the diagnostic may be routed onto
            // stdout as `error:`-tagged lines (stderr empty) — fall back to
            // those so the message stays informative.
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            let detail = if !stderr.is_empty() {
                stderr.to_string()
            } else {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout
                    .lines()
                    .filter_map(|line| match split_p4_severity(line) {
                        (P4Severity::Error, rest) => Some(rest),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            };
            return Err(AppError::Process(format!(
                "p4 changes failed: {}",
                detail
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(parse_changelists(&stdout))
    }

    /// quick-260713-s44: Read-only workspace-health audit. Spawns the 2-command
    /// p4 sequence (`p4 reconcile -n -l -I <whitelist>` + `p4 where <whitelist>`)
    /// over the FIXED Config/Source/.uproject whitelist and returns a categorized
    /// report of ALL files with abnormal p4 status.
    ///
    /// reconcile surfaces not-in-depot + missing-on-disk + differs in one pass;
    /// `p4 where` surfaces unmapped (the stream-switch orphan case) — reconcile
    /// only processes View-mapped paths, so unmapped needs the 2nd command.
    ///
    /// Best-effort + non-fatal: a p4 error on one path does NOT blank the report
    /// (T-s44-03). 120s timeout per command + CancellationToken via tokio::select!
    /// (mirrors dry_run_sync). The `audit_workspace` spawn+drain is NOT unit-
    /// tested (requires a live p4 server) — its correctness is exercised by the
    /// Task 3 human-verify checkpoint against the real FYGame workspace.
    pub async fn audit_workspace(
        &self,
        workspace: &WorkspaceConfig,
        cancel: CancellationToken,
    ) -> Result<WorkspaceHealthReport, AppError> {
        // D-14: the audit is its own `step=audit` StepScope — Drop guarantees a
        // terminal `done`/`failed`/`cancelled`/`dropped` line on every path.
        let _audit_scope = StepScope::new("audit");

        // Build the FIXED 3-entry whitelist (Config/..., Source/..., .uproject).
        let whitelist = build_audit_whitelist_args(&workspace.root_path, &workspace.project_dir);
        let whitelist_refs: Vec<&str> = whitelist.iter().map(|s| s.as_str()).collect();

        // 4-category buckets, populated from both commands. The report always
        // emits all 4 in WorkspaceHealthCategory::ALL order (empty Vec if none).
        // The reconcile read task OWNS the 3 reconcile buckets and returns them
        // (mirrors dry_run_sync's read_task returning count) so the spawn's
        // `async move` doesn't move them out of this scope. The where read task
        // likewise owns + returns the unmapped bucket.

        // --- (1) p4 reconcile -n -l -I <whitelist> ---
        // -n = preview (no mutations), -l = local-syntax paths, -I = ignore
        // P4IGNORE checking (NOT the sync -I progress flag — do NOT conflate).
        let reconcile_args: Vec<&str> = {
            let mut v = vec!["reconcile", "-n", "-l", "-I"];
            v.extend(whitelist_refs.iter().copied());
            v
        };
        let mut reconcile_cmd = self.build_p4_command(workspace, &reconcile_args);
        let mut reconcile_child = spawn_with_retry(
            reconcile_cmd
                .stdout(Stdio::piped())
                .stderr(Stdio::null()),
        )
        .await
        .map_err(AppError::ProcessSpawn)?;

        let reconcile_pid = reconcile_child.id().unwrap_or(0);
        let reconcile_start = std::time::Instant::now();
        info!(
            "{}",
            render_spawned_line(
                reconcile_pid,
                &workspace.root_path,
                &reconcile_args.join(" ")
            )
        );

        // The reconcile read task OWNS the 3 reconcile buckets and returns them
        // as a tuple so they aren't moved out of this scope prematurely.
        let reconcile_stdout = reconcile_child.stdout.take();
        let reconcile_read_task = if let Some(stdout) = reconcile_stdout {
            let reader = BufReader::new(stdout);
            tokio::spawn(async move {
                let mut lines = reader.lines();
                let mut not_in_depot: Vec<String> = Vec::new();
                let mut missing_on_disk: Vec<String> = Vec::new();
                let mut differs: Vec<String> = Vec::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some((category, path)) = parse_reconcile_line(&line) {
                        match category {
                            WorkspaceHealthCategory::NotInDepot => {
                                // Filter generated artifacts (Intermediate/Binaries/Saved/.sln)
                                // so the list isn't noisy (CONTEXT .p4ignore-strategy discretion).
                                if !is_ignored_generated(&path) {
                                    not_in_depot.push(path);
                                }
                            }
                            WorkspaceHealthCategory::MissingOnDisk => {
                                missing_on_disk.push(path);
                            }
                            WorkspaceHealthCategory::Differs => {
                                differs.push(path);
                            }
                            // Unmapped is NOT a reconcile category; skip defensively.
                            WorkspaceHealthCategory::Unmapped => {}
                        }
                    }
                }
                (not_in_depot, missing_on_disk, differs)
            })
        } else {
            tokio::spawn(async {
                (Vec::<String>::new(), Vec::<String>::new(), Vec::<String>::new())
            })
        };

        // 120s timeout + cancel for reconcile (mirrors dry_run_sync).
        let reconcile_outcome: Result<(), AppError> = tokio::select! {
            result = tokio::time::timeout(
                std::time::Duration::from_secs(120),
                reconcile_child.wait(),
            ) => {
                match result {
                    Ok(status) => {
                        let status = status.map_err(AppError::ProcessSpawn)?;
                        info!(
                            "{}",
                            render_exited_line(
                                reconcile_pid,
                                status.code(),
                                reconcile_start.elapsed().as_millis()
                            )
                        );
                        if !status.success() {
                            warn!("[audit] reconcile non-success status; returning partial report");
                        }
                        Ok(())
                    }
                    Err(_) => {
                        // Timeout — the child is still running; we can't take its
                        // stdout back, so abandon the read task and let it drop.
                        // (The partial report from lines read before timeout is
                        // already collected; we just lose the tail.)
                        warn!("[audit] reconcile timed out after 120s, returning partial report");
                        info!(
                            "{}",
                            render_exited_line(
                                reconcile_pid,
                                None,
                                reconcile_start.elapsed().as_millis()
                            )
                        );
                        Ok(())
                    }
                }
            }
            _ = cancel.cancelled() => {
                warn!("[audit] cancelled by user during reconcile");
                _audit_scope.cancelled();
                return Err(AppError::Cancelled);
            }
        };
        let (not_in_depot, missing_on_disk, differs) = reconcile_read_task.await.unwrap_or_default();
        reconcile_outcome?;

        // --- (2) p4 where <whitelist> ---
        // Surfaces unmapped files (the stream-switch orphan case). `p4 where`
        // returns "depot client local" for mapped, "- <path> - file(s) not in
        // client view." for unmapped. Accepts wildcards, so the whitelist is
        // bulk-friendly.
        let where_args: Vec<&str> = {
            let mut v = vec!["where"];
            v.extend(whitelist_refs.iter().copied());
            v
        };
        let mut where_cmd = self.build_p4_command(workspace, &where_args);
        let mut where_child = spawn_with_retry(
            where_cmd
                .stdout(Stdio::piped())
                .stderr(Stdio::null()),
        )
        .await
        .map_err(AppError::ProcessSpawn)?;

        let where_pid = where_child.id().unwrap_or(0);
        let where_start = std::time::Instant::now();
        info!(
            "{}",
            render_spawned_line(
                where_pid,
                &workspace.root_path,
                &where_args.join(" ")
            )
        );

        let where_stdout = where_child.stdout.take();
        let where_read_task = if let Some(stdout) = where_stdout {
            let reader = BufReader::new(stdout);
            tokio::spawn(async move {
                let mut lines = reader.lines();
                let mut unmapped: Vec<String> = Vec::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some((is_mapped, path)) = parse_where_line(&line) {
                        if !is_mapped {
                            unmapped.push(path);
                        }
                        // Mapped lines are skipped (they're the normal case).
                    }
                }
                unmapped
            })
        } else {
            tokio::spawn(async { Vec::<String>::new() })
        };

        let where_outcome: Result<(), AppError> = tokio::select! {
            result = tokio::time::timeout(
                std::time::Duration::from_secs(120),
                where_child.wait(),
            ) => {
                match result {
                    Ok(status) => {
                        let status = status.map_err(AppError::ProcessSpawn)?;
                        info!(
                            "{}",
                            render_exited_line(
                                where_pid,
                                status.code(),
                                where_start.elapsed().as_millis()
                            )
                        );
                        if !status.success() {
                            warn!("[audit] where non-success status; returning partial report");
                        }
                        Ok(())
                    }
                    Err(_) => {
                        warn!("[audit] where timed out after 120s, returning partial report");
                        info!(
                            "{}",
                            render_exited_line(
                                where_pid,
                                None,
                                where_start.elapsed().as_millis()
                            )
                        );
                        Ok(())
                    }
                }
            }
            _ = cancel.cancelled() => {
                warn!("[audit] cancelled by user during where");
                _audit_scope.cancelled();
                return Err(AppError::Cancelled);
            }
        };
        let unmapped = where_read_task.await.unwrap_or_default();
        where_outcome?;

        // Diagnostic: the bound p4 stream (context for WHY files are unmapped).
        // Non-fatal — get_client_stream returns Ok(None) on p4 failure.
        let stream = self
            .get_client_stream(workspace)
            .await
            .unwrap_or(None);

        // Assemble the report in the fixed WorkspaceHealthCategory::ALL order.
        // Move each bucket into its category group (empty Vec if none found).
        let categories: Vec<WorkspaceHealthCategoryGroup> = WorkspaceHealthCategory::ALL
            .iter()
            .map(|cat| {
                let paths = match cat {
                    WorkspaceHealthCategory::Unmapped => unmapped.clone(),
                    WorkspaceHealthCategory::MissingOnDisk => missing_on_disk.clone(),
                    WorkspaceHealthCategory::NotInDepot => not_in_depot.clone(),
                    WorkspaceHealthCategory::Differs => differs.clone(),
                };
                let count = paths.len();
                WorkspaceHealthCategoryGroup {
                    category: *cat,
                    count,
                    paths,
                }
            })
            .collect();

        _audit_scope.done(&format!(
            "unmapped={} missing={} notindepot={} differs={}",
            categories[0].count,
            categories[1].count,
            categories[2].count,
            categories[3].count,
        ));

        Ok(WorkspaceHealthReport { categories, stream })
    }
}

// ========================================================================
// quick-260718-eje: `p4 -s` scripting-mode severity-tag layer
// ========================================================================
//
// With the global `-s` flag (wired by `p4_global_args`), p4 tags EVERY stdout
// line with a severity prefix: `info: `, `warning: `, `error: `, and a single
// terminal `exit: <code>` line. Every parser below strips or routes on the
// tag BEFORE matching, so prefixed and legacy untagged output both parse
// identically (zero behavior change). The `exit: <code>` line is informational
// only — process exit status remains the authoritative success signal.

/// Severity tag p4 applies to each stdout line in `-s` scripting mode.
/// `Text` = legacy untagged line (pre-`-s` output shape).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum P4Severity {
    Info,
    Warning,
    Error,
    Exit,
    Text,
}

/// Split one p4 stdout line into its `-s` severity tag and the remainder.
/// Recognizes `info: `/`warning: `/`error: `/`exit: ` at the START of the line
/// (defensively also a bare `exit:` with no trailing space). Any other line
/// returns `(Text, line)` unchanged — depot paths start with `//` and local
/// paths with a drive letter, so there are no false-positive prefixes.
pub fn split_p4_severity(line: &str) -> (P4Severity, &str) {
    if let Some(rest) = line.strip_prefix("info: ") {
        (P4Severity::Info, rest)
    } else if let Some(rest) = line.strip_prefix("warning: ") {
        (P4Severity::Warning, rest)
    } else if let Some(rest) = line.strip_prefix("error: ") {
        (P4Severity::Error, rest)
    } else if let Some(rest) = line.strip_prefix("exit: ") {
        (P4Severity::Exit, rest)
    } else if let Some(rest) = line.strip_prefix("exit:") {
        (P4Severity::Exit, rest)
    } else {
        (P4Severity::Text, line)
    }
}

/// Convenience: just the line with any `-s` severity tag removed.
fn strip_p4_prefix(line: &str) -> &str {
    split_p4_severity(line).1
}

/// Parse the have-changelist out of `p4 changes -m1 //<client>/...#have`
/// stdout. Severity-aware: skips `exit:`/`error:` lines, strips `info:`.
/// Returns `Some(<cl>)` on the first `Change <N> ...` line with a numeric CL
/// token; `None` otherwise (mirrors the previous inline parse contract).
fn parse_have_changelist(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let (severity, rest) = split_p4_severity(line);
        if matches!(severity, P4Severity::Exit | P4Severity::Error) {
            return None;
        }
        // Format: "Change 12345 on 2024/01/01 by user@client"
        let parts: Vec<&str> = rest.split_whitespace().collect();
        if parts.len() >= 2
            && parts[0] == "Change"
            && !parts[1].is_empty()
            && parts[1].chars().all(|c| c.is_ascii_digit())
        {
            Some(parts[1].to_string())
        } else {
            None
        }
    })
}

/// Parse the bound stream out of `p4 client -o` stdout. Severity-aware:
/// skips `exit:`/`error:` lines, strips `info:`. Returns `Some(stream)` on a
/// non-empty `Stream:` field, `None` on an empty `Stream:` (classic client)
/// or when no `Stream:` line exists. Preserves the previous inline parse
/// contract (strip_prefix("Stream:") + trim, no regex).
fn parse_client_stream(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let (severity, rest) = split_p4_severity(line);
        if matches!(severity, P4Severity::Exit | P4Severity::Error) {
            continue;
        }
        // PINNED parse rule: strip_prefix("Stream:") + trim(). No regex, no
        // split-on-whitespace — `p4 client -o` emits `Stream: <path>` with a
        // single leading space after the colon.
        if let Some(stream_rest) = rest.strip_prefix("Stream:") {
            let s = stream_rest.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
            return None;
        }
    }
    None
}

fn parse_sync_file_count(line: &str) -> u64 {
    // Strip any `-s` severity tag first (quick-260718-eje): the `exit:`/
    // `warning:`/`error:` remainders contain no sync markers, so the terminal
    // `exit: 0` line is NEVER counted as a synced file.
    let line = strip_p4_prefix(line);
    if line.contains(" - updating ") || line.contains(" - added as ") || line.contains(" - deleted")
    {
        1
    } else {
        0
    }
}

fn extract_sync_file_path(line: &str) -> String {
    // Strip any `-s` severity tag first (quick-260718-eje).
    let line = strip_p4_prefix(line);
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
        // quick-260718-eje: route on the `-s` severity tag. `exit:`/`error:`
        // lines are SKIPPED — in particular the terminal `exit: 0` must never
        // be glued onto the last entry's description as a "continuation".
        let (severity, line) = split_p4_severity(line);
        if matches!(severity, P4Severity::Exit | P4Severity::Error) {
            continue;
        }
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

// ========================================================================
// quick-260713-s44: workspace-health audit (read-only p4 reconcile + where)
// ========================================================================
//
// Surfaces ALL files with abnormal p4 status in the FYGame structural
// whitelist (Config/ + Source/ + <project>.uproject), grouped into 4
// categories. Motivated by FY.Uproject showing "not in current workspace
// mapping" after a stream switch stranded files from the prior stream.
//
// TWO p4 commands cover all 4 categories (CONTEXT D-mechanism):
//   (1) `p4 reconcile -n -l -I <whitelist>` -> not-in-depot + missing-on-disk + differs
//   (2) `p4 where <whitelist>`              -> unmapped
// reconcile's `-I` means "ignore P4IGNORE checking" — NOT the sync command's
// `-I` global-progress flag. Do NOT conflate. reconcile does NOT surface
// unmapped files (it only processes View-mapped paths); that's WHY `p4 where`
// is the 2nd command.

/// The 4 abnormal-status categories surfaced by the workspace-health audit.
/// Serialized as snake_case strings across the Tauri IPC boundary.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum WorkspaceHealthCategory {
    /// Not in the client View (stream-switch orphan). Detected via `p4 where`.
    #[serde(rename = "unmapped")]
    Unmapped,
    /// In depot + have-list, but deleted from disk outside p4. reconcile "deleted".
    #[serde(rename = "missing-on-disk")]
    MissingOnDisk,
    /// On disk, not tracked by depot (would need `p4 add`). reconcile "added".
    #[serde(rename = "not-in-depot")]
    NotInDepot,
    /// Locally modified vs the depot revision. reconcile "edited"/"editing".
    #[serde(rename = "differs")]
    Differs,
}

impl WorkspaceHealthCategory {
    /// Stable display order: unmapped (the motivating case) first, then the 3
    /// reconcile categories. The report always emits all 4 entries in this order
    /// (empty Vec if none found — not omitted).
    pub const ALL: [WorkspaceHealthCategory; 4] = [
        WorkspaceHealthCategory::Unmapped,
        WorkspaceHealthCategory::MissingOnDisk,
        WorkspaceHealthCategory::NotInDepot,
        WorkspaceHealthCategory::Differs,
    ];
}

/// One category group in the audit report: the category, the count, and the
/// project-relative paths. Paths are display-only strings (never executed).
#[derive(Clone, Serialize, Deserialize)]
pub struct WorkspaceHealthCategoryGroup {
    pub category: WorkspaceHealthCategory,
    pub count: usize,
    pub paths: Vec<String>,
}

/// The full audit report. `stream` is the bound p4 stream (diagnostic context
/// for WHY files are unmapped); None on classic clients or p4 failure.
#[derive(Clone, Serialize, Deserialize)]
pub struct WorkspaceHealthReport {
    pub categories: Vec<WorkspaceHealthCategoryGroup>,
    pub stream: Option<String>,
}

/// `p4 reconcile -n -l` action markers, in the order reconcile emits them.
/// Match the longer "added as"/"deleted as"/"editing" forms first so the
/// shorter "add"/"delete"/"edit" arms only fire on the bare-summary variants.
/// The "edited" marker has NO trailing space so it also matches the
/// "edited, also opened" form (reconcile -n edit arm).
const RECONCILE_MARKERS_NOT_IN_DEPOT: &[&str] = &[" - added as ", " - add "];
const RECONCILE_MARKERS_MISSING_ON_DISK: &[&str] = &[" - deleted as ", " - delete "];
const RECONCILE_MARKERS_DIFFERS: &[&str] = &[" - editing ", " - edited", " - edit "];

/// The 4 supplemental sync-warning patterns p4 emits on exit-0-but-noisy
/// syncs. Tail-matched on the severity-stripped remainder AFTER
/// `split_p4_severity`. Live-confirmed (Phase 13 RESEARCH 2026-07-20):
///   `warning: <path> - file(s) not in client view.`  (no such file(s) family)
///   `warning: <path> - protected`                    (perms block)
///   `warning: <path> - currently opened`             (open-for-add)
///   `Library file missing.`                          (UE build, pathless)
///
/// DISTINCT from `RECONCILE_MARKERS_*` above — those are for the `p4 reconcile
/// -n -l` workspace-health audit, NOT for `p4 sync` warnings. Do NOT merge the
/// lists.
///
/// CRITICAL (Phase 13 RESEARCH Pitfall 1): the `info1:` framing in CONTEXT.md
/// and ROADMAP.md is WRONG. Live-probe confirms this user's p4 (Perforce 2023
/// build) emits ZERO `info1:` lines; reconcile warnings ride the `warning:`
/// tag that `split_p4_severity` ALREADY recognizes. The UNION capture rule
/// `(severity in {Warning, Error}) OR (stripped contains any pattern)` is
/// belt-and-suspenders — do NOT add an `info1:` branch to `split_p4_severity`.
pub const RECONCILE_WARN_PATTERNS: &[&str] = &[
    " - no such file(s)",
    " - protected",
    " - currently opened",
    "Library file missing",
];

/// D-04 cap on the per-run `SyncCompleted.warnings` payload size. Keep the
/// top-500 `(path, severity)` buckets by occurrence count; a synthetic
/// `<truncated>` row is appended when the pre-cap size exceeded 500. Bounds
/// the one-shot IPC payload regardless of input volume (logline-ipc-flood.md
/// lesson).
pub const MAX_WARNINGS: usize = 500;

/// Which drain a line came from. Determines the base severity before the
/// `-s` tag is consulted: stderr forces `Error` (WARN-16), stdout uses the
/// `split_p4_severity` tag result.
#[derive(Clone, Copy, Debug)]
pub enum DrainOrigin {
    Stdout,
    Stderr,
}

/// Extract the depot/local path from a severity-stripped reconcile-warn line.
/// Mirrors the `extract_sync_file_path` shape (p4_executor.rs:1961). Path is
/// BEFORE the ` - <action>` marker; trailing `#rev` glue stripped. Pathless
/// patterns (`Library file missing.`) return an empty string sentinel — the
/// dedup key for that one pattern is `("", Warning)`.
///
/// Pure: no allocation on the no-path path; returns `String::new()` for any
/// unrecognized shape so the caller's `entry(...).or_insert(...)` upserts
/// under the empty-path sentinel.
pub fn extract_warn_path(stripped: &str) -> String {
    if let Some(idx) = stripped.find(" - ") {
        let candidate = &stripped[..idx];
        // Defensive: only treat the pre-marker token as a path if it looks
        // like a depot (`//...`) or contains a Windows drive separator (`\`).
        // Otherwise it's a non-path ` - ` inside an unrelated message — fall
        // through to the empty-path sentinel.
        if candidate.starts_with("//") || candidate.contains('\\') {
            return candidate
                .rsplit_once('#')
                .map(|(p, _)| p.to_string())
                .unwrap_or_else(|| candidate.to_string());
        }
    }
    String::new()
}

/// One-per-drain warning aggregator (Phase 13 WARN-15..AGG-20). Owns a
/// `HashMap<(String, WarningSeverity), WarningEntry>` (D-01 dedup key) plus a
/// raw `total_lines` counter for the truncator message. Each drain task
/// (`sync()` stdout/stderr + `force_sync_engine()` stdout/stderr) owns ONE
/// collector — no `Arc`/`Mutex` on the hot loop (Pitfall 4). On drain EOF,
/// `finalize()` returns the bounded, deduped `Vec<WarningEntry>`.
///
/// Panic-safety (WARN-17): `ingest()`/`ingest_entry()` use the HashMap entry
/// API + `saturating_add` + `str::contains`. No `unwrap`/`?`/`panic!` on
/// parse — a garbage/empty/non-UTF8/giant line is silently skipped or safely
/// bucketed under the empty-path sentinel. The collection code is wrapped by
/// the existing `catch_unwind_future` on all four drain spawns (Plan 13-02),
/// so even a forced panic is caught + logged, never propagated.
pub struct WarningCollector {
    buckets: HashMap<(String, WarningSeverity), WarningEntry>,
    total_lines: u64,
}

impl WarningCollector {
    pub fn new() -> Self {
        Self {
            buckets: HashMap::with_capacity(64),
            total_lines: 0,
        }
    }

    /// Ingest one raw drain line. `drain_origin` determines the base severity
    /// when the `-s` tag alone is insufficient (stderr -> always Error).
    /// Capture rule (RESEARCH §"Severity assignment rule"):
    ///   `(severity in {Warning, Error}) OR (stripped contains any pattern)`
    /// union with the RECONCILE_WARN_PATTERNS tail match — defense in depth
    /// even though `info1:` is never emitted live (RESEARCH Pitfall 1).
    /// Benign ` - file(s) up-to-date.` / ` - no file(s) to reconcile.` lines
    /// are filtered out (RESEARCH Pitfall 2). The terminal `exit: <code>` line
    /// is NEVER captured (Exit is not a Warning/Error base and has no pattern).
    pub fn ingest(&mut self, raw_line: &str, drain_origin: DrainOrigin) {
        self.total_lines = self.total_lines.saturating_add(1);
        let (severity, stripped) = split_p4_severity(raw_line);
        // Base severity from drain + tag. `Exit`/`Info`/`Text` map to None —
        // they capture ONLY via the pattern right-arm of the UNION (so a
        // hypothetical `info: ... - no such file(s)` is still caught; an
        // `exit: 0` with no pattern is not).
        let base: Option<WarningSeverity> = match drain_origin {
            DrainOrigin::Stderr => Some(WarningSeverity::Error),
            DrainOrigin::Stdout => match severity {
                P4Severity::Error => Some(WarningSeverity::Error),
                P4Severity::Warning => Some(WarningSeverity::Warning),
                // Info/Exit/Text — capture-via-tag is OFF; the pattern arm of
                // the UNION below still fires if the tail matches.
                P4Severity::Info | P4Severity::Exit | P4Severity::Text => None,
            },
        };
        // PITFALL 2 benign-noise filter (applies regardless of drain origin).
        if stripped.contains(" - file(s) up-to-date.")
            || stripped.contains(" - no file(s) to reconcile.")
        {
            return;
        }
        // Capture rule: base in {Warning, Error} OR tail-pattern match.
        let matched = matches!(base, Some(WarningSeverity::Warning) | Some(WarningSeverity::Error))
            || RECONCILE_WARN_PATTERNS.iter().any(|p| stripped.contains(p));
        if !matched {
            return;
        }
        // Final severity: stdout Info+pattern -> Warning (promoted); Error
        // stays Error; Warning stays Warning.
        let final_sev = match base {
            Some(WarningSeverity::Error) => WarningSeverity::Error,
            _ => WarningSeverity::Warning,
        };
        let path = extract_warn_path(stripped);
        let key = (path.clone(), final_sev);
        let bucket = self.buckets.entry(key).or_insert(WarningEntry {
            severity: final_sev,
            path,
            message: stripped.to_string(), // D-02: first-seen wins (or_insert)
            count: 0,
        });
        bucket.count = bucket.count.saturating_add(1);
    }

    /// Sibling of `ingest()` — takes a PRE-BUCKETED `WarningEntry` (from a
    /// previously finalized list). Used by `merge_warning_lists`. On existing
    /// bucket: count climbs via `saturating_add`. On new bucket: the incoming
    /// message wins (first-seen across the FIRST list — `or_insert` only
    /// fires on empty buckets, so the caller's list order determines which
    /// message survives).
    pub fn ingest_entry(&mut self, entry: WarningEntry) {
        let key = (entry.path.clone(), entry.severity);
        let bucket = self.buckets.entry(key).or_insert(WarningEntry {
            severity: entry.severity,
            path: entry.path.clone(),
            message: entry.message.clone(),
            count: 0,
        });
        bucket.count = bucket.count.saturating_add(entry.count);
    }

    /// Finalize: sort by count desc, path asc tiebreak (Pitfall 7), truncate
    /// to `MAX_WARNINGS`, append a synthetic `<truncated>` row when the
    /// pre-cap size exceeded the cap (D-04). Empty collector -> empty Vec
    /// (Phase 14 silent-UI contract).
    pub fn finalize(self) -> Vec<WarningEntry> {
        let mut entries: Vec<WarningEntry> = self.buckets.into_values().collect();
        entries.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.path.cmp(&b.path)));
        if entries.len() > MAX_WARNINGS {
            let suppressed = entries.len() - MAX_WARNINGS;
            entries.truncate(MAX_WARNINGS);
            entries.push(WarningEntry {
                severity: WarningSeverity::Warning,
                path: "<truncated>".to_string(),
                message: format!(
                    "+{} more paths suppressed ({} total warnings from {} distinct buckets)",
                    suppressed, self.total_lines, MAX_WARNINGS,
                ),
                count: suppressed as u64,
            });
        }
        entries
    }
}

impl Default for WarningCollector {
    fn default() -> Self {
        Self::new()
    }
}

/// Pure-fn test seam for the orchestrator merge (RESEARCH §"Test Seam for
/// Merge Across Two Drains Without Live p4"). Given an iterator of
/// pre-finalized `Vec<WarningEntry>` lists (one per drain), re-bucket by
/// `(path, severity)` and re-cap at 500 + truncator (Open Question 2 =
/// yes, recap after merge).
///
/// Plan 13-02 calls this at the two `SyncCompleted` emission sites
/// (`run_pipeline_inner` + `rollback_pipeline_inner`) with
/// `merge_warning_lists([p4_warnings, force_warnings])`.
pub fn merge_warning_lists(lists: impl IntoIterator<Item = Vec<WarningEntry>>) -> Vec<WarningEntry> {
    let mut collector = WarningCollector::new();
    for list in lists {
        for entry in list {
            collector.ingest_entry(entry);
        }
    }
    collector.finalize()
}

/// Parse one `p4 reconcile -n -l` stdout line into (category, project-relative path).
///
/// Returns None for summary/info lines (`... file(s) up-to-date.`, empty, or
/// any line without a recognized action marker). Paths are display-only.
///
/// The depot path is the token BEFORE the action marker (e.g.
/// `//depot/FYGame/Config/DefaultEngine.ini#1 - added as D:\\...`). The
/// project-relative display path is extracted by finding the structural
/// whitelist segment (`/Config/`, `/Source/`, or the `<project>.uproject`
/// filename) and taking from there — the audit ONLY scans Config/Source/.uproject,
/// so every categorized line MUST contain one of these.
///
/// T-s44-01: pure parser, returns Option, no unwrap on parsed paths — a
/// malformed p4 line cannot panic the drain.
pub fn parse_reconcile_line(line: &str) -> Option<(WorkspaceHealthCategory, String)> {
    // quick-260718-eje: route on the `-s` severity tag — `exit:`/`error:`
    // lines are NEVER categorized (an error-tagged line must not fall through
    // to the marker match and yield a garbage entry).
    let (severity, rest) = split_p4_severity(line);
    if matches!(severity, P4Severity::Exit | P4Severity::Error) {
        return None;
    }
    let line = rest.trim();
    if line.is_empty() {
        return None;
    }

    // Try each marker family. The depot path is BEFORE the marker.
    let (category, marker_idx) = if let Some(idx) =
        RECONCILE_MARKERS_NOT_IN_DEPOT
            .iter()
            .find_map(|m| line.find(m).map(|i| (m, i)))
    {
        let (_, i) = idx;
        (WorkspaceHealthCategory::NotInDepot, i)
    } else if let Some((_, i)) = RECONCILE_MARKERS_MISSING_ON_DISK
        .iter()
        .find_map(|m| line.find(m).map(|i| (m, i)))
    {
        (WorkspaceHealthCategory::MissingOnDisk, i)
    } else if let Some((_, i)) = RECONCILE_MARKERS_DIFFERS
        .iter()
        .find_map(|m| line.find(m).map(|i| (m, i)))
    {
        (WorkspaceHealthCategory::Differs, i)
    } else {
        return None;
    };

    let depot_part = &line[..marker_idx];
    Some((category, extract_whitelist_relative_path(depot_part)))
}

/// Extract the project-relative display path from a depot or local path by
/// finding the structural whitelist segment (`Config/`, `Source/`, or the
/// `<project>.uproject` filename) and taking from there. The audit whitelist
/// is EXACTLY Config/Source/.uproject, so every categorized path contains one
/// of these. Falls back to the filename if no structural segment is found
/// (defensive — should not happen for real reconcile output).
fn extract_whitelist_relative_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    // Drop any trailing "#rev" depot revision glue.
    let no_rev = normalized
        .rsplit_once('#')
        .map(|(p, _)| p)
        .unwrap_or(&normalized);

    // Find the Config/ or Source/ segment (the whitelist subtrees). Take from
    // the segment onward (e.g. "...FYGame/Config/DefaultEngine.ini" -> "Config/DefaultEngine.ini").
    for seg in &["Config/", "Source/"] {
        if let Some(idx) = no_rev.find(seg) {
            return no_rev[idx..].to_string();
        }
    }
    // .uproject descriptor file — return the last two segments
    // ("<project>/<project>.uproject") so the project context is preserved
    // (e.g. "//FYDepot/FYGame/FYGame.uproject" -> "FYGame/FYGame.uproject").
    if no_rev.to_lowercase().ends_with(".uproject") {
        // rsplitn(3, '/') yields [filename, project_seg, ...rest] in reverse
        // order: parts[0]=filename, parts[1]=project_seg, parts[2]=rest.
        let parts: Vec<&str> = no_rev.rsplitn(3, '/').collect();
        return match parts.len() {
            1 => parts[0].to_string(),
            _ => format!("{}/{}", parts[1], parts[0]),
        };
    }
    // Defensive fallback: last path segment.
    no_rev
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(no_rev)
        .to_string()
}

/// Parse one `p4 where` stdout line into (is_mapped, project-relative path).
///
/// - Mapped: 3 whitespace-separated path-like tokens (`depot client local`) -> Some((true, path))
/// - Unmapped: `- <path> - file(s) not in client view.` -> Some((false, path))
/// - Other (info/summary lines): None
///
/// The unmapped path is extracted from the leading `- <path> -` token. The
/// mapped path is derived from the depot (1st) token via the whitelist-relative
/// extractor (the .uproject unmapped case surfaces as just the filename).
pub fn parse_where_line(line: &str) -> Option<(bool, String)> {
    // quick-260718-eje: strip the `-s` severity tag, then run the existing
    // unmapped/mapped matching on the remainder. Under `-s`, p4 tags the
    // "not in client view" unmapped line as `error:` — the tag is stripped
    // here so the remainder still parses as unmapped (NOT a garbage "error:"
    // path), while the terminal `exit: 0` line parses to None downstream.
    let (_, rest) = split_p4_severity(line);
    let line = rest.trim();
    if line.is_empty() {
        return None;
    }

    // Unmapped: "- //depot/path - file(s) not in client view."
    // The leading "-" + surrounding " - " delimiters identify the unmapped form.
    // Guard against the bare summary "... file(s) not in client view." (no leading
    // "- <path> -") by requiring the "- <token> -" shape.
    if line.contains("file(s) not in client view") {
        // Strip the leading "- " if present.
        let after_dash = line.strip_prefix("- ").unwrap_or(line);
        // The path is everything up to the next " -" delimiter.
        let path = after_dash
            .split(" -")
            .next()
            .unwrap_or("")
            .trim();
        if path.is_empty() || path.starts_with("...") {
            // Summary line "... file(s) not in client view." (no path) -> None.
            return None;
        }
        return Some((false, extract_whitelist_relative_path(path)));
    }

    // Mapped: "depot client local" — 3 whitespace-separated path tokens.
    // p4 where emits exactly 3 space-separated paths for a mapped file.
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() == 3 {
        // The depot path (1st token) is the canonical path; extract the
        // whitelist-relative portion (Config/..., Source/..., or .uproject).
        let depot = tokens[0];
        // Reject obviously non-path tokens (defensive — a stray info line with
        // 3 tokens shouldn't match, but the depot token must look like a path).
        if depot.contains('/') || depot.contains('\\') {
            return Some((true, extract_whitelist_relative_path(depot)));
        }
    }

    None
}

/// Hardcoded predicate for UE-generated subtrees + IDE files. Applied ONLY to
/// not-in-depot results (the noisy category) so the list isn't dominated by
/// generated artifacts the user can't act on (CONTEXT .p4ignore-strategy
/// discretion: hardcode well-known UE patterns rather than depend on a
/// .p4ignore file that may not exist / is p4-version-dependent).
///
/// Source/Config/.uproject content is NEVER filtered (Source is in-scope).
pub fn is_ignored_generated(rel_path: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    let lower = normalized.to_lowercase();

    // UE-generated subtrees (prefix match on a path segment). Lowercase to
    // match the lowercased input.
    const GENERATED_PREFIXES: &[&str] = &[
        "intermediate/",
        "binaries/",
        "saved/",
        ".vs/",
        "build/",
    ];
    if GENERATED_PREFIXES
        .iter()
        .any(|p| lower.starts_with(p))
    {
        return true;
    }

    // IDE / project-file suffixes (filename match, any directory).
    const GENERATED_SUFFIXES: &[&str] = &[
        ".sln",
        ".suo",
        ".user",
        ".vcxproj",
        ".vcxproj.filters",
    ];
    if GENERATED_SUFFIXES
        .iter()
        .any(|s| lower.ends_with(s))
    {
        return true;
    }

    false
}

/// Build the FIXED 3-entry depot-syntax whitelist for the audit
/// (Config/..., Source/..., <project>.uproject) per D-scope. Resolves the
/// project path the SAME way as `resolve_non_excluded_paths` (try
/// root/UnrealEngine/<project>, then root/<project>), then builds the 3
/// entries. Does NOT honor exclusions — the audit wants a fixed whitelist
/// regardless of the sync-exclude list (D-scope: whitelist, not exclude list).
pub fn build_audit_whitelist_args(root_path: &str, project_dir: &str) -> Vec<String> {
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

    // Build the relative project prefix (e.g. "FYGame" or "UnrealEngine/FYGame").
    let project_rel = project_path
        .strip_prefix(root)
        .unwrap_or(Path::new(project_dir))
        .to_string_lossy()
        .replace('\\', "/");

    vec![
        format!("{}/Config/...", project_rel),
        format!("{}/Source/...", project_rel),
        format!("{}/{}.uproject", project_rel, project_dir),
    ]
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

    // --- Multi-line tests for parse_sync_n_total_bytes (quick-260706-pvk) ---

    #[test]
    fn test_parse_sync_n_total_bytes_multi_path_sums_all() {
        // The app's real `p4 sync -N` (built by build_p4_sync_args) passes ~47
        // depot subpaths → ~47 `bytes added/updated=` markers, one per subpath.
        // The first several are usually `0/0` (already-in-sync subpaths). The
        // parser must SUM D+E across ALL non-zero markers, not bail on the first
        // `0/0` segment. Exact sum: 38275900 + 359115 + 42792 = 38677807.
        let stdout = "\
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/0
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/0
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/38275900
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/359115
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/42792
";
        assert_eq!(Some(38677807), parse_sync_n_total_bytes(stdout));
    }

    #[test]
    fn test_parse_sync_n_total_bytes_all_zero_multi_line() {
        // Several `0/0` markers across multiple lines → running sum stays 0 →
        // None (a 0-byte total is NEVER a usable denominator — preserved ow2
        // contract, now applied to the multi-line sum).
        let stdout = "\
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/0
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/0
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/0
";
        assert_eq!(None, parse_sync_n_total_bytes(stdout));
    }

    #[test]
    fn test_parse_sync_n_total_bytes_skips_malformed_segment() {
        // A segment that doesn't match `<digits>/<digits>` must be SKIPPED
        // (continue), not abort the whole parse. Here the first marker segment
        // is malformed (non-digit runs `abc/def`); the second is a well-formed
        // `0/1000` → the parse yields Some(1000).
        let stdout = "\
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=abc/def
Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/1000
";
        assert_eq!(Some(1000), parse_sync_n_total_bytes(stdout));
    }

    // --- quick-260713-s44: workspace-health audit pure-parser tests (RED) ---
    // The audit_workspace spawn+drain is NOT unit-tested (requires a live p4
    // server) — these pin the pure parsers that classify reconcile/where output.

    #[test]
    fn test_parse_reconcile_line_added_as() {
        // `reconcile -n -l` "added as" -> not-in-depot (file on disk, not tracked)
        let r = parse_reconcile_line(
            "//depot/FYGame/Config/DefaultEngine.ini#1 - added as D:\\FYDepot\\FYGame\\Config\\DefaultEngine.ini",
        );
        assert_eq!(r, Some((WorkspaceHealthCategory::NotInDepot, "Config/DefaultEngine.ini".to_string())));
    }

    #[test]
    fn test_parse_reconcile_line_deleted_as() {
        // "deleted as" -> missing-on-disk (in depot + have-list, deleted from disk)
        let r = parse_reconcile_line(
            "//depot/FYGame/Source/Foo.cpp#3 - deleted as D:\\FYDepot\\FYGame\\Source\\Foo.cpp",
        );
        assert_eq!(r, Some((WorkspaceHealthCategory::MissingOnDisk, "Source/Foo.cpp".to_string())));
    }

    #[test]
    fn test_parse_reconcile_line_editing() {
        // "editing" -> differs (locally modified vs depot revision)
        let r = parse_reconcile_line(
            "//depot/FYGame/Source/Bar.cpp#2 - editing D:\\FYDepot\\FYGame\\Source\\Bar.cpp",
        );
        assert_eq!(r, Some((WorkspaceHealthCategory::Differs, "Source/Bar.cpp".to_string())));
    }

    #[test]
    fn test_parse_reconcile_line_edited_also_opened() {
        // reconcile -n edit arm can read "- edited, also opened" -> differs
        let r = parse_reconcile_line("//depot/FYGame/Source/Bar.h#2 - edited, also opened");
        assert_eq!(r, Some((WorkspaceHealthCategory::Differs, "Source/Bar.h".to_string())));
    }

    #[test]
    fn test_parse_reconcile_line_info_line_is_none() {
        // Summary/info lines are NOT categorized entries.
        assert_eq!(parse_reconcile_line("... file(s) up-to-date."), None);
    }

    #[test]
    fn test_parse_reconcile_line_empty_is_none() {
        assert_eq!(parse_reconcile_line(""), None);
    }

    #[test]
    fn test_parse_reconcile_line_strips_project_prefix() {
        // reconcile -l emits local-syntax relative paths; the display path
        // strips a leading "<project>/" so the UI shows "Config/...".
        let r = parse_reconcile_line(
            "FYGame/Config/DefaultEngine.ini#1 - added as D:\\FYDepot\\FYGame\\Config\\DefaultEngine.ini",
        );
        assert_eq!(r, Some((WorkspaceHealthCategory::NotInDepot, "Config/DefaultEngine.ini".to_string())));
    }

    #[test]
    fn test_parse_where_line_mapped_triple() {
        // 3 whitespace-separated path tokens (depot client local) -> Mapped.
        // The caller skips mapped lines; this is NOT the unmapped case.
        let r = parse_where_line(
            "//FYDepot/FYGame/Config/DefaultEngine.ini //client/FYGame/Config/DefaultEngine.ini D:\\FYDepot\\FYGame\\Config\\DefaultEngine.ini",
        );
        assert_eq!(r, Some((true, "Config/DefaultEngine.ini".to_string())));
    }

    #[test]
    fn test_parse_where_line_unmapped() {
        // The motivating case: "- <path> - file(s) not in client view."
        let r = parse_where_line("- //FYDepot/FYGame/FYGame.uproject - file(s) not in client view.");
        assert_eq!(r, Some((false, "FYGame/FYGame.uproject".to_string())));
    }

    #[test]
    fn test_parse_where_line_info_line_is_none() {
        // Non-path info lines (e.g. summary) are None.
        assert_eq!(parse_where_line("... file(s) not in client view."), None);
    }

    #[test]
    fn test_is_ignored_generated_intermediate() {
        assert!(is_ignored_generated("Intermediate/Project/xxxx.bin"));
    }

    #[test]
    fn test_is_ignored_generated_binaries() {
        assert!(is_ignored_generated("Binaries/Win64/Foo.dll"));
    }

    #[test]
    fn test_is_ignored_generated_saved() {
        assert!(is_ignored_generated("Saved/Autosaves/Map.umap"));
    }

    #[test]
    fn test_is_ignored_generated_source_is_false() {
        // Source is IN-scope (the whitelist), NOT generated.
        assert!(!is_ignored_generated("Source/Foo.cpp"));
    }

    #[test]
    fn test_is_ignored_generated_config_is_false() {
        assert!(!is_ignored_generated("Config/DefaultEngine.ini"));
    }

    #[test]
    fn test_is_ignored_generated_sln() {
        assert!(is_ignored_generated("Foo.sln"));
    }

    #[test]
    fn test_is_ignored_generated_vs_dir() {
        assert!(is_ignored_generated(".vs/config/anything"));
    }

    #[test]
    fn test_build_audit_whitelist_args_three_entries() {
        // The whitelist is EXACTLY 3 depot-syntax entries: Config/..., Source/...,
        // and the <project>.uproject file. Per D-scope: whitelist, not exclude list.
        let args = build_audit_whitelist_args("D:\\FYDepot", "FYGame");
        assert_eq!(args.len(), 3, "expected exactly 3 whitelist entries, got {args:?}");
        // Config subtree (wildcard)
        assert!(
            args.iter().any(|a| a.ends_with("/Config/...")),
            "missing Config/... entry: {args:?}"
        );
        // Source subtree (wildcard)
        assert!(
            args.iter().any(|a| a.ends_with("/Source/...")),
            "missing Source/... entry: {args:?}"
        );
        // .uproject descriptor file (exact, no wildcard)
        assert!(
            args.iter().any(|a| a.ends_with("/FYGame.uproject")),
            "missing FYGame.uproject entry: {args:?}"
        );
    }

    #[test]
    fn test_build_audit_whitelist_args_resolves_unrealengine_prefix() {
        // When the project lives under root/UnrealEngine/<project>/ (the common
        // FYGame layout), the whitelist entries carry the UnrealEngine/ prefix.
        // Uses std::env::temp_dir so the filesystem probe in resolve matches
        // (mirrors the existing resolve_non_excluded_paths test convention).
        use std::fs;
        let tmp_dir = std::env::temp_dir().join("p4_test_audit_whitelist_ue_prefix");
        let _ = fs::remove_dir_all(&tmp_dir);
        let project_dir = tmp_dir.join("UnrealEngine").join("FYGame");
        fs::create_dir_all(project_dir.join("Config")).unwrap();
        fs::create_dir_all(project_dir.join("Source")).unwrap();
        fs::write(project_dir.join("FYGame.uproject"), "{}").unwrap();

        let root_str = tmp_dir.to_string_lossy().replace('\\', "/");
        let args = build_audit_whitelist_args(&root_str, "FYGame");
        assert!(
            args.iter().any(|a| a.contains("UnrealEngine/FYGame/Config/...")),
            "expected UnrealEngine/FYGame/Config/... when project is under UnrealEngine/, got {args:?}"
        );
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    // --- quick-260718-eje: p4 -s severity-tag split + prefixed-line parser tests ---
    //
    // With the global `-s` scripting flag (Task 2 wires it onto every spawn),
    // EVERY p4 stdout line arrives severity-tagged: `info: `/`warning: `/
    // `error: `/`exit: <code>` (terminal). All parsers strip/route on the tag
    // via `split_p4_severity` and MUST still accept legacy untagged lines
    // (the pre-existing unprefixed fixtures above stay untouched and green).

    #[test]
    fn test_split_p4_severity_info() {
        assert_eq!(
            split_p4_severity("info: //depot/f.txt#5 - updating D:\\f.txt"),
            (P4Severity::Info, "//depot/f.txt#5 - updating D:\\f.txt")
        );
    }

    #[test]
    fn test_split_p4_severity_warning() {
        assert_eq!(
            split_p4_severity("warning: //p - no such file(s)."),
            (P4Severity::Warning, "//p - no such file(s).")
        );
    }

    #[test]
    fn test_split_p4_severity_error() {
        assert_eq!(
            split_p4_severity("error: - //depot/x - file(s) not in client view."),
            (P4Severity::Error, "- //depot/x - file(s) not in client view.")
        );
    }

    #[test]
    fn test_split_p4_severity_exit() {
        assert_eq!(split_p4_severity("exit: 0"), (P4Severity::Exit, "0"));
    }

    #[test]
    fn test_split_p4_severity_exit_no_space() {
        // Defensive: a bare `exit:` with no trailing space still splits.
        assert_eq!(split_p4_severity("exit:0"), (P4Severity::Exit, "0"));
    }

    #[test]
    fn test_split_p4_severity_plain_text() {
        assert_eq!(
            split_p4_severity("//depot/f.txt#5 - updating D:\\f.txt"),
            (P4Severity::Text, "//depot/f.txt#5 - updating D:\\f.txt")
        );
    }

    #[test]
    fn test_split_p4_severity_empty() {
        assert_eq!(split_p4_severity(""), (P4Severity::Text, ""));
    }

    #[test]
    fn test_parse_sync_file_count_info_prefixed() {
        assert_eq!(
            1,
            parse_sync_file_count(
                "info: //depot/MyGame/file.txt#5 - updating E:\\MyGame\\file.txt"
            )
        );
    }

    #[test]
    fn test_parse_sync_file_count_exit_line_is_zero() {
        // The terminal `exit: <code>` line must NEVER count as a synced file.
        assert_eq!(0, parse_sync_file_count("exit: 0"));
    }

    #[test]
    fn test_parse_sync_file_count_warning_line_is_zero() {
        assert_eq!(
            0,
            parse_sync_file_count("warning: //p - no such file(s).")
        );
    }

    #[test]
    fn test_extract_sync_file_path_info_prefixed() {
        assert_eq!(
            "E:\\MyGame\\file.txt",
            extract_sync_file_path(
                "info: //depot/MyGame/file.txt#5 - updating E:\\MyGame\\file.txt"
            )
        );
    }

    #[test]
    fn test_parse_sync_n_total_bytes_info_prefixed_multi_line_with_exit() {
        // EVERY estimate line `info:`-prefixed + a trailing `exit: 0` line.
        // The exit line contributes nothing; the D+E sum is unchanged.
        let stdout = "\
info: Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/0
info: Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/38275900
info: Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/359115
info: Server network estimates: files added/updated/deleted=0/0/0, bytes added/updated=0/42792
exit: 0
";
        assert_eq!(Some(38677807), parse_sync_n_total_bytes(stdout));
    }

    #[test]
    fn test_parse_changelists_info_prefixed_with_exit_line() {
        let input = "info: Change 12345 on 2024/01/15 by user@client *pending* Fix bug\nexit: 0";
        let entries = parse_changelists(input);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].number, "12345");
        assert_eq!(entries[0].date, "2024/01/15");
        assert!(entries[0].description.contains("Fix bug"));
        // The trailing `exit: 0` line must NOT be glued onto the description
        // as a "continuation" line.
        assert!(!entries[0].description.contains("exit"));
    }

    #[test]
    fn test_parse_changelists_error_line_skipped() {
        // An `error:`-tagged line between entries is skipped, not appended to
        // the previous entry's description.
        let input = "info: Change 12345 on 2024/01/15 by user@client *pending* Fix bug\nerror: some depot error\ninfo: Change 12344 on 2024/01/14 by user2@client2 *pending* Add feature\nexit: 0";
        let entries = parse_changelists(input);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].number, "12345");
        assert_eq!(entries[1].number, "12344");
        assert!(!entries[0].description.contains("some depot error"));
    }

    #[test]
    fn test_parse_reconcile_line_info_prefixed() {
        let r = parse_reconcile_line(
            "info: //depot/FYGame/Config/DefaultEngine.ini#1 - added as D:\\FYDepot\\FYGame\\Config\\DefaultEngine.ini",
        );
        assert_eq!(
            r,
            Some((
                WorkspaceHealthCategory::NotInDepot,
                "Config/DefaultEngine.ini".to_string()
            ))
        );
    }

    #[test]
    fn test_parse_reconcile_line_exit_is_none() {
        assert_eq!(parse_reconcile_line("exit: 0"), None);
    }

    #[test]
    fn test_parse_reconcile_line_error_is_none() {
        // Error-tagged lines are routed out, never mis-categorized.
        assert_eq!(
            parse_reconcile_line("error: //depot/FYGame/Config/X.ini#1 - added as D:\\X"),
            None
        );
    }

    #[test]
    fn test_parse_where_line_info_prefixed_mapped() {
        let r = parse_where_line(
            "info: //FYDepot/FYGame/Config/DefaultEngine.ini //client/FYGame/Config/DefaultEngine.ini D:\\FYDepot\\FYGame\\Config\\DefaultEngine.ini",
        );
        assert_eq!(r, Some((true, "Config/DefaultEngine.ini".to_string())));
    }

    #[test]
    fn test_parse_where_line_error_prefixed_unmapped() {
        // p4 tags the "not in client view" line as an error under `-s`; the
        // parser must strip the tag and still surface the unmapped path
        // (NOT a garbage "error:" path).
        let r = parse_where_line(
            "error: - //FYDepot/FYGame/FYGame.uproject - file(s) not in client view.",
        );
        assert_eq!(r, Some((false, "FYGame/FYGame.uproject".to_string())));
    }

    #[test]
    fn test_parse_where_line_exit_is_none() {
        assert_eq!(parse_where_line("exit: 0"), None);
    }

    #[test]
    fn test_parse_have_changelist_info_prefixed() {
        assert_eq!(
            parse_have_changelist("info: Change 12345 on 2024/01/01 by user@client\nexit: 0"),
            Some("12345".to_string())
        );
    }

    #[test]
    fn test_parse_have_changelist_legacy_unprefixed() {
        assert_eq!(
            parse_have_changelist("Change 678 on 2024/01/01 by user@client"),
            Some("678".to_string())
        );
    }

    #[test]
    fn test_parse_have_changelist_error_only_is_none() {
        assert_eq!(
            parse_have_changelist("error: //client/...#have - no such file(s).\nexit: 1"),
            None
        );
    }

    #[test]
    fn test_parse_client_stream_info_prefixed() {
        assert_eq!(
            parse_client_stream(
                "info: Client: zhouyang\ninfo: Stream: //FY_Depot/main\nexit: 0"
            ),
            Some("//FY_Depot/main".to_string())
        );
    }

    #[test]
    fn test_parse_client_stream_classic_no_stream_line_is_none() {
        assert_eq!(
            parse_client_stream("info: Client: zhouyang\ninfo: Root: D:\\FYDepot\nexit: 0"),
            None
        );
    }

    #[test]
    fn test_parse_client_stream_legacy_unprefixed() {
        assert_eq!(
            parse_client_stream("Client: x\nStream: //depot/main"),
            Some("//depot/main".to_string())
        );
    }

    #[test]
    fn test_parse_client_stream_empty_stream_value_is_none() {
        // `Stream:` present but empty → classic client (None), preserved.
        assert_eq!(parse_client_stream("Stream:\n"), None);
        assert_eq!(parse_client_stream("info: Stream: \nexit: 0"), None);
    }

    // --- quick-260718-eje Task 2: p4_global_args carries `-s` first ---

    #[test]
    fn test_p4_global_args_script_mode_first() {
        // `-s` (scripting mode) is a GLOBAL flag and comes FIRST so script
        // mode applies to the whole session; the client + root ride along.
        let ws = WorkspaceConfig {
            id: String::new(),
            name: "test".to_string(),
            root_path: "E:\\test".to_string(),
            project_dir: "MyGame".to_string(),
            p4_client: "test_client".to_string(),
            p4_user: String::new(),
            parallel_threads: 4,
            exclusions: vec![],
            last_sync_cl: None,
            last_sync_time: None,
            last_sync_file_count: None,
            interval_minutes: 60,
        };
        let args = p4_global_args(&ws);
        assert_eq!(args[0], "-s", "-s scripting flag must be the FIRST global arg");
        assert_eq!(
            args,
            vec!["-s", "-C", "utf8", "-c", "test_client", "-d", "E:\\test"],
            "global args carry -s + client + root in one shared place"
        );
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
            include_engine: false,
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

    // --- Test for project catch-all overlap fix (quick-260707-s1y) ---
    //
    // Reproduces the real Revision(@CL) layout that triggered the bug: the
    // project lives UNDER `UnrealEngine/<project_dir>/`, so when the
    // workspace_root_scope loop iterates `UnrealEngine/` children, the project
    // dir is one of them and would otherwise get a catch-all
    // `UnrealEngine/<project_dir>/...` RE-COVERING files already enumerated
    // granularly in the first loop (`UnrealEngine/<project_dir>/<child>/...`).
    // `p4 sync -N` estimates each path independently → double-count → bogus
    // ~959.7 GB denominator observed in run 4fd03ef1.
    //
    // The fix skips the catch-all ONLY when `ue_name == project_dir`. Sibling
    // UE subdirs (FeaturePacks below) MUST still get their catch-all — that
    // assertion proves the guard is targeted, not over-broad.
    #[test]
    fn test_resolve_non_excluded_paths_skips_project_catchall() {
        let tmp_dir = std::env::temp_dir().join("p4_test_project_catchall_overlap");
        let ue_dir = tmp_dir.join("UnrealEngine");
        // Project lives UNDER UnrealEngine/ — the real layout that exposes the
        // overlap. project_candidates resolves to `UnrealEngine/FYGame`.
        let project_dir = ue_dir.join("FYGame");
        let _ = fs::remove_dir_all(&tmp_dir);
        // Project's own children — must be enumerated granularly by the first
        // loop as `UnrealEngine/FYGame/<child>/...`.
        fs::create_dir_all(project_dir.join("Content")).unwrap();
        fs::create_dir_all(project_dir.join("Build")).unwrap();
        fs::create_dir_all(project_dir.join("Config")).unwrap();
        // Engine child — must be enumerated by the Engine branch.
        fs::create_dir_all(ue_dir.join("Engine/Config")).unwrap();
        // A UE sibling that is NOT the project — must get its catch-all.
        fs::create_dir_all(ue_dir.join("FeaturePacks")).unwrap();

        let paths = resolve_non_excluded_paths(
            tmp_dir.to_str().unwrap(),
            "FYGame",
            &[],
            true, // workspace_root_scope=true exercises the CL branch directly
        );

        // (A) Granular project children ARE present — proves the project is
        // resolved granularly by the first loop.
        assert!(
            paths.iter().any(|p| p == "UnrealEngine/FYGame/Content/..."),
            "granular project child Content must be present; got {:?}",
            paths
        );
        assert!(
            paths.iter().any(|p| p == "UnrealEngine/FYGame/Build/..."),
            "granular project child Build must be present; got {:?}",
            paths
        );

        // (B) CORE: the project-dir catch-all is ABSENT — exact-match (NOT
        // .contains("FYGame"), which would match the legitimate granular
        // children like `UnrealEngine/FYGame/Content/...`). This is the
        // phantom-bytes line that contributed ~959.7 GB to the -N denominator.
        assert!(
            !paths.iter().any(|p| p == "UnrealEngine/FYGame/..."),
            "project-dir catch-all must be absent (would double-count in -N); got {:?}",
            paths
        );

        // (C) A sibling UE subdir catch-all IS present — proves the guard
        // skips ONLY the project dir, not all UE siblings. This is the
        // assertion that proves the guard is targeted.
        assert!(
            paths.iter().any(|p| p == "UnrealEngine/FeaturePacks/..."),
            "sibling UE subdir catch-all must be present; got {:?}",
            paths
        );

        // (D) Engine enumeration still works.
        assert!(
            paths.iter().any(|p| p == "UnrealEngine/Engine/Config/..."),
            "Engine child enumeration must work; got {:?}",
            paths
        );

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
            include_engine: true,
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

    // --- New tests for include_engine opt-out (quick-260713-kx6) ---
    //
    // Proves the :306 gate: a Target CL sync with `include_engine: false` skips
    // all `UnrealEngine/...` paths (so the subsequent `git pull` of UnrealEngine
    // stays clean), while the project subtree is still synced to the target CL.
    // The companion test proves the gate still admits engine paths when ON.

    #[test]
    fn test_build_p4_sync_args_with_cl_no_engine() {
        // Layout mirrors the real workspace: project under UnrealEngine/<project>,
        // plus Engine source under UnrealEngine/Engine.
        let tmp_dir = std::env::temp_dir().join("p4_test_args_cl_no_engine");
        let ue_dir = tmp_dir.join("UnrealEngine");
        let project_dir = ue_dir.join("FYGame");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(project_dir.join("Content")).unwrap();
        fs::create_dir_all(project_dir.join("Binaries")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Source")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Shaders")).unwrap();

        // include_engine: false → the engine block MUST be skipped.
        let options = SyncOptions {
            target_cl: Some("12345".to_string()),
            parallel_threads: 1,
            exclusions: vec![],
            include_engine: false,
        };
        let args = build_p4_sync_args(&options, tmp_dir.to_str().unwrap(), "FYGame", &options.target_cl);

        // (A) The project is still synced to the target CL. With
        // include_engine=false, workspace_root_scope is false, so
        // resolve_non_excluded_paths returns the `//...` catch-all (no
        // exclusions, no workspace-root enumeration) → the CL suffix is applied
        // to it. The point is the project subtree IS pinned to @CL; how it is
        // expressed (`//...@12345` vs a granular `FYGame/...@12345`) is an
        // implementation detail of path resolution.
        assert!(
            args.iter().any(|a| a.contains("@12345")),
            "project subtree must be synced to CL; got {:?}",
            args
        );
        // (B) CORE: NO UnrealEngine path appears anywhere in the args. This is
        // the opt-out — the engine source is left untouched so `git pull` of
        // UnrealEngine stays clean.
        assert!(
            !args.iter().any(|a| a.contains("UnrealEngine")),
            "UnrealEngine paths must be absent when include_engine=false; got {:?}",
            args
        );

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_build_p4_sync_args_with_cl_engine_on() {
        let tmp_dir = std::env::temp_dir().join("p4_test_args_cl_engine_on");
        let ue_dir = tmp_dir.join("UnrealEngine");
        let project_dir = ue_dir.join("FYGame");
        let _ = fs::remove_dir_all(&tmp_dir);
        fs::create_dir_all(project_dir.join("Content")).unwrap();
        fs::create_dir_all(project_dir.join("Binaries")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Source")).unwrap();
        fs::create_dir_all(ue_dir.join("Engine/Shaders")).unwrap();

        // include_engine: true → engine block IS admitted, pinned to the CL.
        let options = SyncOptions {
            target_cl: Some("12345".to_string()),
            parallel_threads: 1,
            exclusions: vec![],
            include_engine: true,
        };
        let args = build_p4_sync_args(&options, tmp_dir.to_str().unwrap(), "FYGame", &options.target_cl);

        assert!(
            args.iter().any(|a| a.contains("UnrealEngine") && a.contains("@12345")),
            "UnrealEngine paths must be present (pinned to CL) when include_engine=true; got {:?}",
            args
        );

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

    // --- Phase 13 (13-01): WarningCollector classifier + dedup + cap + merge ---

    #[test]
    fn test_warning_collector_warn_tagged() {
        // WARN-15: warning:-tagged reconcile line classifies to (path, Warning)
        // with the severity-stripped line as message, count 1.
        let mut c = WarningCollector::new();
        c.ingest(
            "warning: //FY_Depot/.../X.uasset - no such file(s).",
            DrainOrigin::Stdout,
        );
        let out = c.finalize();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, WarningSeverity::Warning);
        assert_eq!(out[0].count, 1);
        assert_eq!(out[0].path, "//FY_Depot/.../X.uasset");
        assert_eq!(out[0].message, "//FY_Depot/.../X.uasset - no such file(s).");
    }

    #[test]
    fn test_reconcile_patterns_4() {
        // WARN-15: each of the 4 RECONCILE_WARN_PATTERNS matched individually
        // when wrapped in a synthetic "warning: <prefix><pattern>" line.
        let patterns = [
            " - no such file(s)",
            " - protected",
            " - currently opened",
            "Library file missing",
        ];
        for p in &patterns {
            let mut c = WarningCollector::new();
            c.ingest(&format!("warning: //depot/p{p}"), DrainOrigin::Stdout);
            let out = c.finalize();
            assert_eq!(
                out.len(),
                1,
                "pattern {p:?} should be individually matched"
            );
        }
    }

    #[test]
    fn test_warning_collector_tail_pattern_union() {
        // WARN-15 defense-in-depth: an `info:`-tagged line (severity Info, NOT
        // Warning) whose tail matches a RECONCILE_WARN_PATTERN is STILL captured
        // via the UNION right arm and promoted to Warning severity. The
        // `info1:` framing in CONTEXT/ROADMAP is wrong (RESEARCH Pitfall 1) —
        // reconcile warnings ride `warning:` in practice, but the UNION rule
        // is the safety net.
        let mut c = WarningCollector::new();
        c.ingest(
            "info: //depot/p - no such file(s)",
            DrainOrigin::Stdout,
        );
        let out = c.finalize();
        assert_eq!(out.len(), 1, "UNION right arm must capture info+pattern");
        assert_eq!(out[0].severity, WarningSeverity::Warning);
        assert_eq!(out[0].count, 1);
    }

    #[test]
    fn test_extract_warn_path_no_such_file() {
        // Path is BEFORE the ` - ` marker; trailing `#rev` stripped.
        assert_eq!(
            extract_warn_path("//depot/dir/X.uasset#3 - no such file(s)."),
            "//depot/dir/X.uasset"
        );
    }

    #[test]
    fn test_extract_warn_path_protected() {
        // Same shape for the ` - protected` pattern.
        assert_eq!(
            extract_warn_path("//depot/dir/Y.cpp#1 - protected"),
            "//depot/dir/Y.cpp"
        );
    }

    #[test]
    fn test_extract_warn_path_pathless_returns_empty() {
        // Pathless pattern (no ` - ` marker, no `//` prefix) -> empty sentinel.
        assert_eq!(extract_warn_path("Library file missing."), "");
        assert_eq!(extract_warn_path(""), "");
    }

    #[test]
    fn test_library_file_missing_pathless() {
        // WARN-15: pathless "Library file missing." buckets under path == "".
        let mut c = WarningCollector::new();
        c.ingest("warning: Library file missing.", DrainOrigin::Stdout);
        let out = c.finalize();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "");
        assert_eq!(out[0].severity, WarningSeverity::Warning);
    }

    #[test]
    fn test_benign_uptodate_filtered() {
        // RESEARCH Pitfall 2: "file(s) up-to-date." is BENIGN informational
        // noise (sync on already-synced file); MUST be filtered out.
        let mut c = WarningCollector::new();
        c.ingest(
            "warning: //depot/p - file(s) up-to-date.",
            DrainOrigin::Stdout,
        );
        let out = c.finalize();
        assert!(out.is_empty(), "benign up-to-date must be filtered: {out:?}");
    }

    #[test]
    fn test_benign_no_file_to_reconcile_filtered() {
        // RESEARCH Pitfall 2 sibling: "no file(s) to reconcile." is benign.
        let mut c = WarningCollector::new();
        c.ingest(
            "warning: //depot/p - no file(s) to reconcile.",
            DrainOrigin::Stdout,
        );
        let out = c.finalize();
        assert!(
            out.is_empty(),
            "benign no-file-to-reconcile must be filtered: {out:?}"
        );
    }

    #[test]
    fn test_exit_line_never_captured() {
        // The terminal `exit: <code>` line must never be captured.
        let mut c = WarningCollector::new();
        c.ingest("exit: 0", DrainOrigin::Stdout);
        c.ingest("exit: 1", DrainOrigin::Stdout);
        assert!(c.finalize().is_empty());
    }

    #[test]
    fn test_stderr_severity_error() {
        // WARN-16: stderr forces Error severity regardless of tag content.
        let mut c = WarningCollector::new();
        c.ingest("info: some soft stderr line", DrainOrigin::Stderr);
        let out = c.finalize();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, WarningSeverity::Error);
    }

    #[test]
    fn test_stdout_error_tag_severity() {
        // WARN-16: stdout `error:` tag -> Error severity.
        let mut c = WarningCollector::new();
        c.ingest("error: //depot/p - boom", DrainOrigin::Stdout);
        let out = c.finalize();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, WarningSeverity::Error);
    }

    #[test]
    fn test_ingest_garbage_no_panic() {
        // WARN-17 fault injection: ingest must never panic on garbage/empty/
        // non-UTF8-lossy/giant/NUL-only/marker-without-path lines. Each line
        // is either silently skipped or safely bucketed.
        let mut c = WarningCollector::new();
        let giant = "x".repeat(64 * 1024);
        let non_utf8_lossy =
            String::from_utf8_lossy(&[0xff, 0xfe]).to_string() + " - no such file(s)";
        let fixture: Vec<String> = vec![
            String::new(),
            giant,
            "\0".to_string(),
            " - no path here".to_string(),
            non_utf8_lossy,
            "warning: //depot/ok - no such file(s).".to_string(),
        ];
        for line in &fixture {
            // MUST NOT panic — test fails by panicking inside the closure.
            c.ingest(line, DrainOrigin::Stdout);
        }
        // The one well-formed warning line landed in one bucket; the rest
        // silently skipped or bucketed under empty path. No assertions on the
        // exact output — only the panic-safety contract.
        let _ = c.finalize();
    }

    #[test]
    fn test_dedup_same_path_same_sev() {
        // AGG-19 D-01: 5 identical lines for the same path collapse to 1
        // bucket with count 5; first-seen message preserved (D-02).
        let mut c = WarningCollector::new();
        for _ in 0..5 {
            c.ingest(
                "warning: //depot/p - no such file(s).",
                DrainOrigin::Stdout,
            );
        }
        let out = c.finalize();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].count, 5);
        assert_eq!(out[0].message, "//depot/p - no such file(s).");
    }

    #[test]
    fn test_dedup_path_sev_boundary() {
        // AGG-19 D-01 boundary: same path producing BOTH a warning and an
        // error yields 2 buckets (severity is part of the dedup key).
        let mut c = WarningCollector::new();
        c.ingest(
            "warning: //depot/p - no such file(s).",
            DrainOrigin::Stdout,
        );
        c.ingest("error: //depot/p - boom", DrainOrigin::Stdout);
        let out = c.finalize();
        assert_eq!(out.len(), 2);
        let sev_counts = (
            out.iter().filter(|e| e.severity == WarningSeverity::Warning).count(),
            out.iter().filter(|e| e.severity == WarningSeverity::Error).count(),
        );
        assert_eq!(sev_counts, (1, 1));
    }

    #[test]
    fn test_hard_cap_500_truncator() {
        // AGG-19 D-04: >500 distinct (path, severity) buckets -> finalize()
        // yields exactly 501 entries (500 capped + 1 truncator). The truncator
        // has path == "<truncated>", severity Warning, count == (pre_cap - 500).
        let mut c = WarningCollector::new();
        for i in 0..600u32 {
            c.ingest(
                &format!("warning: //depot/p{i} - no such file(s)."),
                DrainOrigin::Stdout,
            );
        }
        let out = c.finalize();
        assert_eq!(out.len(), MAX_WARNINGS + 1);
        let truncator = out.last().expect("truncator row present");
        assert_eq!(truncator.path, "<truncated>");
        assert_eq!(truncator.severity, WarningSeverity::Warning);
        assert_eq!(truncator.count, (600 - MAX_WARNINGS) as u64);
    }

    #[test]
    fn test_empty_run_returns_empty_vec() {
        // AGG-19 Phase 14 silent-UI contract: empty collector -> empty Vec.
        let c = WarningCollector::new();
        assert!(c.finalize().is_empty());
    }

    #[test]
    fn test_count_saturates_no_overflow() {
        // Pitfall 5: pathological repeat of the same key cannot overflow.
        // We ingest the same line 1_000_000 times — count climbs to 1_000_000
        // (well under u64::MAX saturation) and MUST NOT panic. The contract
        // under test is panic-safety, not actually hitting the saturation cap.
        let mut c = WarningCollector::new();
        for _ in 0..1_000_000u64 {
            c.ingest(
                "warning: //depot/p - no such file(s).",
                DrainOrigin::Stdout,
            );
        }
        let out = c.finalize();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].count, 1_000_000);
    }

    #[test]
    fn test_sort_tiebreak_deterministic() {
        // Pitfall 7: two paths with identical counts -> finalize() orders them
        // lexicographically by path asc (stable across runs).
        let mut c = WarningCollector::new();
        // Ingest in reverse-lex order so the sort must actually reorder them.
        c.ingest(
            "warning: //depot/zzz - no such file(s).",
            DrainOrigin::Stdout,
        );
        c.ingest(
            "warning: //depot/aaa - no such file(s).",
            DrainOrigin::Stdout,
        );
        let out = c.finalize();
        assert_eq!(out.len(), 2);
        // Both have count 1; tiebreak is path asc, so aaa comes first.
        assert_eq!(out[0].path, "//depot/aaa");
        assert_eq!(out[1].path, "//depot/zzz");
    }

    #[test]
    fn test_merge_two_collectors() {
        // AGG-18 pure-fn test seam: merge two pre-formed Vec<WarningEntry>
        // with the same (path, severity) — count sums, first-seen message
        // preserved (from the FIRST list).
        let list_a = vec![WarningEntry {
            severity: WarningSeverity::Warning,
            path: "//depot/a".into(),
            message: "//depot/a - no such file(s).".into(),
            count: 3,
        }];
        let list_b = vec![WarningEntry {
            severity: WarningSeverity::Warning,
            path: "//depot/a".into(),
            message: "//depot/a - DUPE later message".into(),
            count: 2,
        }];
        let merged = merge_warning_lists([list_a, list_b]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].count, 5);
        // First-seen message (from list_a) wins.
        assert_eq!(merged[0].message, "//depot/a - no such file(s).");
    }

    #[test]
    fn test_orchestrator_merge_recaps() {
        // Open Question 2: merge re-applies the 500 cap + truncator to the
        // POST-merge list. Two lists whose union exceeds 500 distinct paths
        // are re-capped at 500 + a truncator row.
        let mut list_a = Vec::new();
        for i in 0..300u32 {
            list_a.push(WarningEntry {
                severity: WarningSeverity::Warning,
                path: format!("//depot/a{i}"),
                message: format!("//depot/a{i} - no such file(s)."),
                count: 1,
            });
        }
        let mut list_b = Vec::new();
        for i in 0..300u32 {
            list_b.push(WarningEntry {
                severity: WarningSeverity::Warning,
                path: format!("//depot/b{i}"),
                message: format!("//depot/b{i} - no such file(s)."),
                count: 1,
            });
        }
        let merged = merge_warning_lists([list_a, list_b]);
        assert_eq!(
            merged.len(),
            MAX_WARNINGS + 1,
            "merge must re-cap at MAX_WARNINGS + truncator"
        );
        let truncator = merged.last().expect("truncator present");
        assert_eq!(truncator.path, "<truncated>");
        assert_eq!(truncator.count, (600 - MAX_WARNINGS) as u64);
    }
}
