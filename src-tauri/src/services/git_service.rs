use crate::error::AppError;
use crate::models::{SyncEvent, WorkspaceConfig};
use crate::services::process_manager::ProcessManager;
use crate::utils::counting_channel::CountingChannel;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri_plugin_log::log::{error, info, warn};
use crate::utils::log::{render_cancelled_line, render_exited_line, scope_run_with, RUN_ID};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt as _;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Clone)]
pub struct GitStatusInfo {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub remote: String,
    // quick-260724-tgj: current commit short hash + detached-HEAD flag.
    // Default snake_case serde (NO rename_all — verified, the first multi-word
    // field; TS mirror must use `short_hash` / `is_detached`, NOT camelCase).
    pub short_hash: String,
    pub is_detached: bool,
}

/// Manual `Debug` for `GitStatusInfo` — the REDACT-06 / D-05 defense-in-depth
/// backstop.
///
/// Today `remote` is populated from `git remote` output (git_service.rs
/// ~line 252-263) and holds the remote NAME (e.g. `"origin"`), NOT a URL — so
/// it does not today carry embedded credentials. However: (a) the field is a
/// `String` and could hold a URL if the population code changes, and (b) the
/// D-02 regex still matters for any git URL appearing in error messages /
/// future instrumentation. Mask `remote` defensively per D-05; keep
/// `branch` / `ahead` / `behind` so `Debug` remains useful.
impl std::fmt::Debug for GitStatusInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitStatusInfo")
            .field("branch", &self.branch)
            .field("ahead", &self.ahead)
            .field("behind", &self.behind)
            .field("remote", &"<redacted>")
            // quick-260724-tgj: neither field carries credentials/PII. A 7-hex
            // short hash is not matched by redact's catalog (redact.rs:74 masks
            // only 32+ hex tokens) and short_hash is never logged by git_service,
            // so these are safe to emit in Debug with no redaction.
            .field("short_hash", &self.short_hash)
            .field("is_detached", &self.is_detached)
            .finish()
    }
}

pub struct GitService {
    process_manager: Arc<ProcessManager>,
    git_running: AtomicBool,
}

impl GitService {
    pub fn new(process_manager: Arc<ProcessManager>) -> Self {
        Self {
            process_manager,
            git_running: AtomicBool::new(false),
        }
    }

    pub async fn pull(
        &self,
        workspace: &WorkspaceConfig,
        channel: &CountingChannel,
    ) -> Result<(), AppError> {
        if self.git_running.swap(true, Ordering::SeqCst) {
            return Err(AppError::Process("A git pull is already running".into()));
        }
        let result = self.pull_inner(workspace, channel).await;
        self.git_running.store(false, Ordering::SeqCst);
        result
    }

    async fn pull_inner(
        &self,
        workspace: &WorkspaceConfig,
        channel: &CountingChannel,
    ) -> Result<(), AppError> {
        // Validate path: UnrealEngine directory must exist with .git
        let ue_path = Path::new(&workspace.root_path).join("UnrealEngine");
        if !ue_path.exists() {
            return Err(AppError::Process(
                "UnrealEngine directory not found or is not a Git repository".to_string(),
            ));
        }
        if !ue_path.join(".git").exists() {
            return Err(AppError::Process(
                "UnrealEngine directory not found or is not a Git repository".to_string(),
            ));
        }

        // Emit StepStarted
        let _ = channel.send(SyncEvent::StepStarted {
            step: "gitPull".to_string(),
            description: "Pulling UnrealEngine from Git...".to_string(),
            sub_step: Some("run".to_string()),
        });

        // Set up cancellation
        let cancel_token = CancellationToken::new();
        self.process_manager
            .set_cancel_token(cancel_token.clone())
            .await;

        info!("[gitPull] starting git pull in {}", ue_path.display());

        // Step 1: git stash to save local changes before pulling
        // Phase 15 D-03: sub-step label for the no-% stash phase.
        let _ = channel.send(SyncEvent::StepStarted {
            step: "gitPull".to_string(),
            description: "Saving local changes…".to_string(),
            sub_step: Some("stash".to_string()),
        });
        let stash_result = run_git(&ue_path, &["stash", "--include-untracked"]).await;
        let had_stash = match stash_result {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                // "No local changes to save" means nothing was stashed
                let did_stash = !stdout.contains("No local changes to save");
                if did_stash {
                    let _ = channel.send(SyncEvent::LogLine {
                        line: "Local changes stashed".to_string(),
                        stream: "stdout".to_string(),
                    });
                }
                did_stash
            }
            Ok(_) => {
                // Stash command returned non-zero (not fatal)
                let _ = channel.send(SyncEvent::LogLine {
                    line: "Warning: git stash skipped (non-zero exit)".to_string(),
                    stream: "stderr".to_string(),
                });
                false
            }
            Err(e) => {
                // Spawn failure — not fatal for stash step
                let _ = channel.send(SyncEvent::LogLine {
                    line: format!("Warning: git stash skipped ({})", e),
                    stream: "stderr".to_string(),
                });
                false
            }
        };

        // Step 2: git pull
        // Phase 15 D-03: covers pre-network Counting/Enumerating before % lines
        // start (the indeterminate phase before Receiving/Compressing kick in).
        let _ = channel.send(SyncEvent::StepStarted {
            step: "gitPull".to_string(),
            description: "Preparing download…".to_string(),
            sub_step: Some("preNetwork".to_string()),
        });
        let mut child = tokio::process::Command::new("git")
            .args(git_pull_args())
            .current_dir(&ue_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(AppError::ProcessSpawn)?;

        // Track PID + capture spawn_start for the process.exited/cancelled
        // elapsed values (git_service's wait is a plain child.wait() + post-hoc
        // cancel_token check, NOT a tokio::select! — see PATTERNS Pattern B).
        let spawn_start = std::time::Instant::now();
        if let Some(id) = child.id() {
            self.process_manager.track_pid(id).await;
        }

        // INSTR-09 / D-09 / D-10: process.spawned at the track_pid site. The
        // arg vector is now `["pull", "--ff-only", "--progress"]` (Phase 15
        // GPULL-24 added `--progress`, which forces git's `%` progress lines on
        // the piped/non-tty stderr so the Phase 15 parser receives them — it
        // carries no identity/URL/path so no additional redaction is required
        // beyond the existing cwd_redacted net). `--ff-only` is a strategy
        // flag carrying no identity, username, URL, or path, so it needs no
        // additional redaction — the only identity-bearing value in the spawn
        // line remains `current_dir` (ue_path / root_path), which is already
        // routed through the redact net via the `cwd_redacted` local below
        // (Phase-10 Users-home pattern masks the prefix, unchanged). The D-08
        // safeguard is inline here (git has no p4-style client flag, so
        // render_spawned_line's p4-shaped prefix does not apply). Bound to
        // named locals so the borrows outlive the format!() / redact()
        // expression statements.
        {
            let cwd_lossy = ue_path.to_string_lossy();
            let cwd_redacted = crate::utils::redact::redact(&cwd_lossy).into_owned();
            let line = format!("git pull (cwd={})", cwd_redacted);
            let safe = crate::utils::redact::redact(&line);
            info!(
                "process.spawned pid={} cmd=\"{}\"",
                child.id().unwrap_or(0),
                safe
            );
        }

        // Stream stdout
        let stdout = child.stdout.take().unwrap();
        let ch_out = channel.clone();
        // Phase 12 / D-02: capture RUN_ID ONCE before spawn (task_local does
        // not cross tokio::spawn). Re-scoped inside the task via scope_run_with
        // so every line this drain logs carries [run=<id>] (closes the Phase 11
        // deferral — git pull drains were [run=——] pre-12-02).
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        let stdout_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future keeps a panic from silently
            // killing the drain (RESEARCH Pitfall 5). On Err the panic payload
            // is Display-rendered via panic_payload_as_str (NEVER {:?} — SC#3
            // gate) and logged as warn!. catch_unwind_future is the async-aware
            // twin of std::catch_unwind (the naive shape does NOT compile — see
            // utils/log.rs).
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
                    let mut lines = BufReader::new(stdout).lines();
                    // Phase 12 / D-01 (option b): per-drain line counter for the
                    // per-completion count summary. git pull is un-batched (one
                    // LogLine per line) so the per-batch summary shape does not
                    // apply; instead a single lines=N summary fires at drain
                    // completion (O(1)/drain, well within the O(hundreds) bound).
                    let mut line_count: u64 = 0;
                    while let Ok(Some(line)) = lines.next_line().await {
                        let _ = ch_out.send(SyncEvent::LogLine {
                            line,
                            stream: "stdout".to_string(),
                        });
                        line_count += 1;
                    }
                    // D-01 per-completion count summary (this drain's line
                    // throughput) — coexists with the 12-01 sent_total=N line
                    // below (sent_total reports the Arc-shared TOTAL IPC sends;
                    // lines= reports THIS drain's local count — different
                    // signals, both useful). log_enabled!-guarded (HOTUI-13).
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "git drain complete stream=stdout lines={}",
                            line_count
                        );
                    }
                    // D-05 (Phase 12 / HOTUI-12): per-completion counter summary for the
                    // git-pull stdout drain — ONE line per drain per run, O(1). git pull
                    // has no heartbeat task, so the counter fires at drain completion.
                    // log_enabled! guard mandatory (HOTUI-13 eager-eval rule).
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

        // Stream stderr
        let stderr = child.stderr.take().unwrap();
        let ch_err = channel.clone();
        // Phase 12 / D-02: capture RUN_ID before spawn.
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        let stderr_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future wrap (see stdout_task above).
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
                    let mut lines = BufReader::new(stderr).lines();
                    let mut line_count: u64 = 0;
                    while let Ok(Some(line)) = lines.next_line().await {
                        // Phase 15 (GPULL-24): parse git `%` BEFORE the move
                        // below. Split on \r — git updates progress in-place with
                        // \r so one `lines()` line can hold the whole 0->100
                        // sweep; take the last Some segment (most recent update).
                        // D-04: the raw LogLine still emits verbatim below.
                        // GPULL-26: send is `let _ =` and this whole drain lives
                        // inside the catch_unwind_future wrap above, so a parser
                        // panic or a closed channel never breaks the pull.
                        // WR-01 fix: bind `phase` (was `_phase` discard) and
                        // thread the display label through the IPC so the bar
                        // label reflects the ACTUAL phase (Compressing/Receiving/
                        // Resolving) instead of always "Receiving objects".
                        // GPULL-26: send is `let _ =` (best-effort, non-fatal).
                        if let Some((phase, pct)) = line
                            .split('\r')
                            .rev()
                            .find_map(parse_git_progress_percent)
                        {
                            let _ = ch_err.send(SyncEvent::Progress {
                                current: 0,
                                total: 0,
                                current_file: String::new(),
                                bytes_done: None,
                                bytes_total: None,
                                bytes_rate: None,
                                percent: Some(pct),
                                phase: Some(phase.label().to_string()),
                            });
                        }
                        let _ = ch_err.send(SyncEvent::LogLine {
                            line,
                            stream: "stderr".to_string(),
                        });
                        line_count += 1;
                    }
                    // D-01 per-completion count summary (this drain's lines).
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "git drain complete stream=stderr lines={}",
                            line_count
                        );
                    }
                    // D-05 (Phase 12 / HOTUI-12): git-pull stderr per-completion
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

        // Wait for completion
        let status = child.wait().await.map_err(AppError::ProcessSpawn)?;
        self.process_manager.clear_tracked().await;

        // Abort reader tasks — git hooks or credential helpers may spawn
        // child processes that inherit the pipe handles.
        stdout_task.abort();
        stderr_task.abort();

        // INSTR-09 / D-09: process.exited — emits on BOTH success and the
        // post-hoc cancel branch (git_service does wait-then-check, not a
        // select!, so the normal exit line fires before the cancel signal).
        info!(
            "{}",
            render_exited_line(
                child.id().unwrap_or(0),
                status.code(),
                spawn_start.elapsed().as_millis()
            )
        );

        // Handle cancellation
        if cancel_token.is_cancelled() {
            if had_stash {
                let _ = restore_stash(&ue_path, channel).await;
            }
            // INSTR-09 / D-09: process.cancelled — the distinct cancel signal
            // INSTR-09 names; the post-hoc check fires AFTER the exited line
            // above, so both an exited and a cancelled line emit on cancel
            // (PATTERNS Pattern B adaptation — git's wait-then-check shape).
            info!(
                "{}",
                render_cancelled_line(
                    child.id().unwrap_or(0),
                    spawn_start.elapsed().as_millis()
                )
            );
            let _ = channel.send(SyncEvent::SyncCancelled {
                step: "gitPull".to_string(),
            });
            return Ok(());
        }

        // Handle failure
        if !status.success() {
            if had_stash {
                let _ = restore_stash(&ue_path, channel).await;
            }
            let _ = channel.send(SyncEvent::StepCompleted {
                step: "gitPull".to_string(),
                success: false,
            });
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "gitPull".to_string(),
                error: format!(
                    "git pull failed (exit code {}) — --ff-only refused to merge because local has diverged from origin. \
                     Likely cause: local commits not on origin. \
                     Manually reconcile (git rebase origin/<branch> or git reset --hard origin/<branch>) in the UnrealEngine repo, then retry the sync.",
                    status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "none".to_string())
                ),
            });
            return Err(AppError::CommandFailed {
                step: "gitPull".to_string(),
                exit_code: status.code(),
            });
        }

        // Step 3: git stash pop to restore local changes (if we stashed)
        if had_stash {
            if let Err(e) = restore_stash(&ue_path, channel).await {
                let _ = channel.send(SyncEvent::StepCompleted {
                    step: "gitPull".to_string(),
                    success: false,
                });
                let _ = channel.send(SyncEvent::SyncFailed {
                    step: "gitPull".to_string(),
                    error: e.to_string(),
                });
                return Err(e);
            }
        }

        // Step 4: Run GenerateProjectFiles.bat
        self.run_gen_project(workspace, channel).await?;

        // Handle success only after local changes are restored and project files are regenerated.
        let _ = channel.send(SyncEvent::StepCompleted {
            step: "gitPull".to_string(),
            success: true,
        });

        let _ = channel.send(SyncEvent::SyncCompleted {
            changelist: None,
            files_synced: 0,
            // Phase 13: git-pull has no p4 warning surface — always empty.
            warnings: Vec::new(),
        });

        info!("[gitPull] completed successfully");
        Ok(())
    }

    pub async fn status(&self, workspace: &WorkspaceConfig) -> Result<GitStatusInfo, AppError> {
        let ue_path = Path::new(&workspace.root_path).join("UnrealEngine");

        // If not a git repo, return defaults
        if !ue_path.exists() || !ue_path.join(".git").exists() {
            return Ok(GitStatusInfo {
                branch: String::new(),
                ahead: 0,
                behind: 0,
                remote: String::new(),
                short_hash: String::new(),
                is_detached: false,
            });
        }

        // Get branch name: git rev-parse --abbrev-ref HEAD
        let branch_output = run_git(&ue_path, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        let branch = match branch_output {
            Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
            Err(_) => String::new(),
        };

        // quick-260724-tgj (D-02): detached detection reuses the existing branch
        // output — `git rev-parse --abbrev-ref HEAD` returns the literal "HEAD"
        // when HEAD is detached, so NO extra git process is needed.
        // The raw "HEAD" value is KEPT in the `branch` field intentionally; the
        // frontend relabels it to "(detached)" for display. Do NOT relabel here.
        let is_detached = branch == "HEAD";

        // quick-260724-tgj: current commit short hash. One extra run_git spawn
        // (30s timeout already enforced by run_git). On failure → empty string,
        // same fallback `branch` uses on Err.
        let short_hash_output = run_git(&ue_path, &["rev-parse", "--short", "HEAD"]).await;
        let short_hash = match short_hash_output {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            Err(_) => String::new(),
        };

        // Get remote name: git remote (needed for ahead/behind calculation)
        let remote_output = run_git(&ue_path, &["remote"]).await;
        // Take first remote (usually "origin")
        let remote = match remote_output {
            Ok(output) => String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string(),
            Err(_) => String::new(),
        };

        // Fetch latest refs from remote so ahead/behind is accurate.
        // Without this, the locally cached remote tracking branch is stale
        // and behind will always show 0 even when the remote has new commits.
        if !remote.is_empty() {
            let _ = run_git(&ue_path, &["fetch", &remote]).await;
        }

        // Get ahead/behind: git rev-list --left-right --count HEAD...{remote}/{branch}
        // Uses explicit remote/branch instead of @{upstream} which requires tracking config
        let (ahead, behind) = if !remote.is_empty() && !branch.is_empty() {
            let upstream = format!("{}/{}", remote, branch);
            let ab_output = run_git(
                &ue_path,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("HEAD...{}", upstream),
                ],
            )
            .await;
            match ab_output {
                Ok(output) if output.status.success() => {
                    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    parse_ahead_behind(&text)
                }
                _ => (0, 0),
            }
        } else {
            (0, 0)
        };

        Ok(GitStatusInfo {
            branch,
            ahead,
            behind,
            remote,
            short_hash,
            is_detached,
        })
    }

    pub async fn cancel(&self) -> Result<(), AppError> {
        self.process_manager.stop_all().await
    }

    /// Run GenerateProjectFiles.bat after git pull to update project files
    async fn run_gen_project(
        &self,
        workspace: &WorkspaceConfig,
        channel: &CountingChannel,
    ) -> Result<(), AppError> {
        let _ = channel.send(SyncEvent::StepStarted {
            step: "genProject".to_string(),
            description: "Generating project files...".to_string(),
            sub_step: Some("gen".to_string()),
        });

        let root = Path::new(&workspace.root_path);
        let bat_path = root.join("UnrealEngine/GenerateProjectFiles.bat");
        let work_dir = root.join("UnrealEngine");
        info!(
            "[gitPull/genProject] bat_path={}, work_dir={}",
            bat_path.display(),
            work_dir.display()
        );

        if !bat_path.exists() {
            warn!(
                "[gitPull/genProject] bat file not found: {}, skipping",
                bat_path.display()
            );
            let _ = channel.send(SyncEvent::LogLine {
                line: "GenerateProjectFiles.bat not found, skipping".to_string(),
                stream: "stderr".to_string(),
            });
            // Not fatal — git pull still succeeded
            return Ok(());
        }

        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", &bat_path.to_string_lossy()])
            .current_dir(&work_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(AppError::ProcessSpawn)?;

        // Capture spawn_start for the process.exited elapsed value.
        // genProject in this code path is non-cancellable (no select! / no
        // cancel_token check) — only the exited line fires below.
        let spawn_start = std::time::Instant::now();
        if let Some(id) = child.id() {
            self.process_manager.track_pid(id).await;
        }

        // INSTR-09 / D-09 / D-10: process.spawned at the track_pid site. The
        // arg vector `["/C", <bat_path>]` embeds root_path; route bat_path +
        // work_dir through redact (Phase-10 Users-home pattern masks the prefix)
        // — D-08 safeguard for git_service's genProject spawn. Bound to a named
        // local so the borrow outlives the format!() expression statement.
        {
            let line = format!(
                "cmd /C {} (cwd={})",
                bat_path.to_string_lossy(),
                work_dir.to_string_lossy()
            );
            let safe = crate::utils::redact::redact(&line);
            info!(
                "process.spawned pid={} cmd=\"{}\"",
                child.id().unwrap_or(0),
                safe
            );
        }

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let ch_out = channel.clone();
        // Phase 12 / D-02: capture RUN_ID before spawn.
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        let stdout_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future wrap (see git pull stdout_task).
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
                    let mut lines = BufReader::new(stdout).lines();
                    let mut line_count: u64 = 0;
                    while let Ok(Some(line)) = lines.next_line().await {
                        let _ = ch_out.send(SyncEvent::LogLine {
                            line,
                            stream: "stdout".to_string(),
                        });
                        line_count += 1;
                    }
                    // D-01 per-completion count summary (this drain's lines).
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "genProject drain complete stream=stdout lines={}",
                            line_count
                        );
                    }
                    // D-05 (Phase 12 / HOTUI-12): genProject stdout per-completion
                    // counter summary — ONE line per drain per run.
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

        let ch_err = channel.clone();
        // Phase 12 / D-02: capture RUN_ID before spawn.
        let run_id = RUN_ID.try_with(|r| r.clone()).ok();
        let stderr_task = tokio::spawn(async move {
            // Phase 12 / D-09: catch_unwind_future wrap.
            if let Err(payload) = crate::utils::log::catch_unwind_future(async move {
                scope_run_with(run_id, async move {
                    let mut lines = BufReader::new(stderr).lines();
                    let mut line_count: u64 = 0;
                    while let Ok(Some(line)) = lines.next_line().await {
                        let _ = ch_err.send(SyncEvent::LogLine {
                            line,
                            stream: "stderr".to_string(),
                        });
                        line_count += 1;
                    }
                    // D-01 per-completion count summary (this drain's lines).
                    if log::log_enabled!(log::Level::Debug) {
                        crate::utils::log::debug!(
                            "genProject drain complete stream=stderr lines={}",
                            line_count
                        );
                    }
                    // D-05 (Phase 12 / HOTUI-12): genProject stderr per-completion
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

        let status = child.wait().await.map_err(AppError::ProcessSpawn)?;
        self.process_manager.clear_tracked().await;

        // Abort reader tasks — MSBuild /nodeReuse:true spawns dotnet.exe
        // servers that inherit the pipe handles and keep them open forever.
        stdout_task.abort();
        stderr_task.abort();

        // INSTR-09 / D-09: process.exited — always fires (before success check)
        // so the genProject terminal lifecycle line emits on both success and
        // failure. No cancel arm here (genProject is non-cancellable in this
        // code path) — only the exited line.
        info!(
            "{}",
            render_exited_line(
                child.id().unwrap_or(0),
                status.code(),
                spawn_start.elapsed().as_millis()
            )
        );

        if !status.success() {
            error!(
                "[gitPull/genProject] failed with exit code {}",
                status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "none".to_string())
            );
            let _ = channel.send(SyncEvent::StepCompleted {
                step: "genProject".to_string(),
                success: false,
            });
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "genProject".to_string(),
                error: format!(
                    "GenerateProjectFiles failed with exit code {}",
                    status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "none".to_string())
                ),
            });
            return Err(AppError::CommandFailed {
                step: "genProject".to_string(),
                exit_code: status.code(),
            });
        }

        let _ = channel.send(SyncEvent::StepCompleted {
            step: "genProject".to_string(),
            success: true,
        });

        info!("[gitPull/genProject] completed successfully");
        Ok(())
    }
}

/// Parse "N\tM" format from git rev-list --left-right --count
fn parse_ahead_behind(text: &str) -> (u32, u32) {
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() == 2 {
        let ahead = parts[0].parse::<u32>().unwrap_or(0);
        let behind = parts[1].parse::<u32>().unwrap_or(0);
        (ahead, behind)
    } else {
        (0, 0)
    }
}

/// Phase 15 (GPULL-24): which git transfer phase a parsed progress line
/// belongs to. Drives the D-01 per-phase reset + label. Fixed 3-variant enum
/// (no user data) — safe to emit in Debug/logs without redaction.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GitProgressPhase {
    Compressing,
    Receiving,
    Resolving,
}

impl GitProgressPhase {
    /// Canonical label string sent to the frontend for the bar label (D-01 /
    /// WR-01 fix). The string IS the label — the frontend renders it verbatim
    /// as the `{phase} {pct}%` prefix, so it must match the user-facing
    /// "Compressing objects" / "Receiving objects" / "Resolving deltas" text.
    pub fn label(&self) -> &'static str {
        match self {
            GitProgressPhase::Compressing => "Compressing objects",
            GitProgressPhase::Receiving => "Receiving objects",
            GitProgressPhase::Resolving => "Resolving deltas",
        }
    }
}

/// Phase 15 (GPULL-24): parse a git stderr progress line into (phase, percent).
///
/// Pure + side-effect-free — unit-testable. Mirrors `parse_sync_n_total_bytes`
/// (returns `Option`, NOT `Result`; malformed -> None -> skip, GPULL-26
/// non-fatal: no error path to propagate, never `.unwrap()`).
///
/// Recognized shapes (verified via Pro Git + live git output docs):
///   "Compressing objects:  45% (12/26)"
///   "Receiving objects:  45% (1234/5678)"           <- note: may be double-space
///   "Resolving deltas:  45% (1234/5678)"
///   "Receiving objects: 100% (5678/5678), 677.42 KiB | 4 KiB/s, done"
///
/// Returns None for:
///   - "remote: Enumerating objects: 5, done."   (no %, pre-network — indeterminate per D-01)
///   - "Counting objects: 100%"                   (pre-network — indeterminate per D-01/SC#2)
///   - any line without a leading "<phase>: N%" shape
///
/// `\r` subtlety (RESEARCH Pitfall 2): `BufReader::lines()` does NOT split a
/// bare `\r`, so one "line" can contain the whole 0->100 sweep joined. This
/// parser handles a SINGLE segment; the call site (drain wiring in Plan 02)
/// applies `.split('\r').rev().find_map(parse_git_progress_percent)` to take
/// the LAST (most-recent) update.
pub fn parse_git_progress_percent(line: &str) -> Option<(GitProgressPhase, u8)> {
    // Identify the phase by its leading prefix (else this is not a progress line).
    let phase = if line.starts_with("Compressing objects:") {
        GitProgressPhase::Compressing
    } else if line.starts_with("Receiving objects:") {
        GitProgressPhase::Receiving
    } else if line.starts_with("Resolving deltas:") {
        GitProgressPhase::Resolving
    } else {
        return None;
    };
    // Take everything after the first colon, then scan whitespace-separated
    // tokens for the first "<digits>%". Malformed tokens (NaN, overflow like
    // 999%) fall through to None via the `if let Ok` guard — never `.unwrap()`
    // (GPULL-26 structural gate).
    let after_colon = line.splitn(2, ':').nth(1)?;
    for tok in after_colon.split_whitespace() {
        if let Some(num_str) = tok.strip_suffix('%') {
            if let Ok(pct) = num_str.parse::<u8>() {
                return Some((phase, pct));
            }
        }
    }
    None
}

/// Phase 15 (GPULL-24 / SC#3): the git pull arg vector as a pure fn.
///
/// `--progress` forces git's `%` progress lines on the piped (non-tty) stderr
/// so the Phase 15 parser (Plan 02 drain wiring) receives them — without it
/// git detects non-tty stderr and emits ZERO `%` lines (RESEARCH Pitfall 3).
/// `--ff-only` is preserved (the quick-260715-qhs merge-self-loop guard).
///
/// Extracted into a pure fn so SC#3 (`--progress` present) is assertable
/// WITHOUT spawning git — mirrors the `p4_global_args` / `build_p4_command`
/// pattern. `--progress` is a progress-display flag carrying no identity/URL/
/// path, so it needs no additional redaction beyond the existing cwd_redacted
/// net at the spawn site.
fn git_pull_args() -> [&'static str; 3] {
    ["pull", "--ff-only", "--progress"]
}

/// Restore stashed changes via `git stash pop`, logging result to channel
async fn restore_stash(ue_path: &Path, channel: &CountingChannel) -> Result<(), AppError> {
    // Phase 15 D-03: sub-step label for the no-% restore phase. Emitted as the
    // FIRST statement so ALL 3 call sites (cancel / cancel / success) get the
    // label uniformly without each call site needing its own emit (DRY).
    let _ = channel.send(SyncEvent::StepStarted {
        step: "gitPull".to_string(),
        description: "Restoring local changes…".to_string(),
        sub_step: Some("restoreStash".to_string()),
    });
    let _ = channel.send(SyncEvent::LogLine {
        line: "Restoring stashed changes...".to_string(),
        stream: "stdout".to_string(),
    });
    match run_git(ue_path, &["stash", "pop"]).await {
        Ok(output) if output.status.success() => {
            let _ = channel.send(SyncEvent::LogLine {
                line: "Stashed changes restored".to_string(),
                stream: "stdout".to_string(),
            });
            Ok(())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let _ = channel.send(SyncEvent::LogLine {
                line: format!("Warning: git stash pop failed — {}", stderr),
                stream: "stderr".to_string(),
            });
            Err(AppError::Process(if stderr.is_empty() {
                "git stash pop failed while restoring local changes".to_string()
            } else {
                format!(
                    "git stash pop failed while restoring local changes: {}",
                    stderr
                )
            }))
        }
        Err(e) => {
            let _ = channel.send(SyncEvent::LogLine {
                line: format!("Warning: git stash pop failed — {}", e),
                stream: "stderr".to_string(),
            });
            Err(AppError::Process(format!(
                "git stash pop failed while restoring local changes: {}",
                e
            )))
        }
    }
}

/// Run a git command and return output, propagating spawn failures as errors.
/// stdin is set to null to prevent hangs when git prompts for credentials.
/// A 30s timeout prevents indefinite blocking on network issues.
async fn run_git(dir: &Path, args: &[&str]) -> Result<std::process::Output, AppError> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| AppError::Process(format!("git {} timed out after 30s", args.join(" "))))?
        .map_err(AppError::ProcessSpawn);

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SC#2: manual Debug does not leak remote (REDACT-06 / D-05 backstop) ----

    #[test]
    fn git_status_info_debug_does_not_leak_remote() {
        // The format-layer redact() net is the audited boundary (Wave 1); this
        // struct-level Debug is the pragmatic backstop. Use a URL-shaped remote
        // (worst case: embedded creds) to prove the mask holds regardless of
        // what the `remote` field happens to carry.
        let gsi = GitStatusInfo {
            branch: "main".into(),
            ahead: 1,
            behind: 0,
            remote: concat!("https://alice:token", "@", "github.com/EpicGames/UnrealEngine.git").into(),
            short_hash: "a1b2c3d".into(),
            is_detached: false,
        };
        let dbg = format!("{:?}", gsi);
        assert!(!dbg.contains("alice"), "Debug leaked username: {dbg}");
        assert!(!dbg.contains("token"), "Debug leaked credential: {dbg}");
        assert!(dbg.contains("GitStatusInfo"), "Debug must still identify the type");
        assert!(dbg.contains("main"), "Debug must keep branch (non-identity)");
        // quick-260724-tgj: the two new fields appear in Debug output and carry
        // their value through (field key + the literal short_hash value).
        assert!(dbg.contains("short_hash"), "Debug must expose short_hash field: {dbg}");
        assert!(dbg.contains("is_detached"), "Debug must expose is_detached field: {dbg}");
        assert!(
            dbg.contains("a1b2c3d"),
            "Debug must carry the short_hash VALUE through: {dbg}"
        );
    }

    #[test]
    fn git_status_info_debug_keeps_counts() {
        // Regression: prove KEEP fields are retained (not over-masking).
        let gsi = GitStatusInfo {
            branch: "release".into(),
            ahead: 7,
            behind: 3,
            remote: "origin".into(),
            short_hash: "deadbee".into(),
            is_detached: true,
        };
        let dbg = format!("{:?}", gsi);
        assert!(dbg.contains("7"));
        assert!(dbg.contains("3"));
        assert!(dbg.contains("release"));
        // The remote NAME "origin" is masked even though today it's harmless —
        // the mask is defensive against future URL-shaped values.
        assert!(!dbg.contains("origin"));
        // quick-260724-tgj: detached flag travels through Debug.
        assert!(
            dbg.contains("is_detached: true"),
            "Debug must carry is_detached value: {dbg}"
        );
    }

    // ---- Phase 15 (GPULL-24 / GPULL-26): pure git progress percent parser ----

    #[test]
    fn parse_git_progress_percent_receiving() {
        // Real git stderr line shape (Pro Git format). Double-space is common.
        assert_eq!(
            parse_git_progress_percent("Receiving objects:  45% (1234/5678)"),
            Some((GitProgressPhase::Receiving, 45))
        );
    }

    #[test]
    fn parse_git_progress_percent_compressing() {
        assert_eq!(
            parse_git_progress_percent("Compressing objects:  45% (12/26)"),
            Some((GitProgressPhase::Compressing, 45))
        );
    }

    #[test]
    fn parse_git_progress_percent_resolving() {
        assert_eq!(
            parse_git_progress_percent("Resolving deltas:  45% (1234/5678)"),
            Some((GitProgressPhase::Resolving, 45))
        );
    }

    #[test]
    fn git_progress_phase_label_matches_user_facing_text() {
        // WR-01 fix: the label() string is what the frontend renders verbatim
        // as the bar label prefix. It must match the canonical git output text
        // exactly so the bar reads "Compressing objects N%" / "Receiving objects
        // N%" / "Resolving deltas N%" — never a stale "Receiving objects".
        assert_eq!(GitProgressPhase::Compressing.label(), "Compressing objects");
        assert_eq!(GitProgressPhase::Receiving.label(), "Receiving objects");
        assert_eq!(GitProgressPhase::Resolving.label(), "Resolving deltas");
    }

    #[test]
    fn parse_git_progress_percent_done_line() {
        // The "done" tail line still carries a leading 100% — must parse.
        assert_eq!(
            parse_git_progress_percent(
                "Receiving objects: 100% (5678/5678), 677.42 KiB | 4 KiB/s, done"
            ),
            Some((GitProgressPhase::Receiving, 100))
        );
    }

    #[test]
    fn parse_git_progress_percent_counting_returns_none() {
        // D-01: Counting is indeterminate (no useful % for the bar).
        assert_eq!(parse_git_progress_percent("Counting objects: 100%"), None);
    }

    #[test]
    fn parse_git_progress_percent_enumerating_returns_none() {
        // D-01: remote: Enumerating is indeterminate.
        assert_eq!(
            parse_git_progress_percent("remote: Enumerating objects: 5, done."),
            None
        );
    }

    #[test]
    fn parse_git_progress_percent_malformed_returns_none() {
        // GPULL-26 non-fatal discipline: every malformed shape -> None, no panic.
        assert_eq!(parse_git_progress_percent(""), None);
        // NaN is not a u8.
        assert_eq!(parse_git_progress_percent("Receiving objects: NaN%"), None);
        // 999 overflows u8 (Err from parse::<u8>) -> None, NOT a panic.
        assert_eq!(parse_git_progress_percent("Receiving objects: 999%"), None);
        // Non-progress ref line.
        assert_eq!(
            parse_git_progress_percent("From https://github.com/EpicGames/UnrealEngine"),
            None
        );
    }

    #[test]
    fn parse_git_progress_percent_carriage_return_last_segment_wins() {
        // git updates progress in-place with \r (NOT \n); tokio's
        // BufReader::lines() does NOT split bare \r, so one "line" can contain
        // the whole 0->100 sweep joined. The drain (Plan 02) will apply
        // `.split('\r').rev().find_map(parse_git_progress_percent)` — this test
        // proves that idiom yields the LAST (highest, most-recent) percent.
        let joined =
            "Receiving objects:  10% (1/10)\rReceiving objects:  67% (7/10)\rReceiving objects:  90% (9/10)";
        let result = joined.split('\r').rev().find_map(parse_git_progress_percent);
        assert_eq!(result, Some((GitProgressPhase::Receiving, 90)));
    }

    #[test]
    fn git_pull_args_include_progress() {
        // SC#3 gate: --progress forces git's % lines on the piped (non-tty)
        // stderr so the Phase 15 parser receives them. Assertable WITHOUT
        // spawning git (mirrors p4_global_args testability).
        let args = git_pull_args();
        assert!(
            args.contains(&"--progress"),
            "git_pull_args must include --progress: {:?}",
            args
        );
        // --ff-only (the merge-self-loop guard from quick-260715-qhs) MUST be
        // preserved.
        assert!(
            args.contains(&"--ff-only"),
            "git_pull_args must preserve --ff-only: {:?}",
            args
        );
        assert!(args.contains(&"pull"), "git_pull_args must include pull: {:?}", args);
    }
}
