use crate::error::AppError;
use crate::models::{SyncEvent, WorkspaceConfig};
use crate::services::process_manager::ProcessManager;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri_plugin_log::log::{error, info, warn};
use crate::utils::log::{render_cancelled_line, render_exited_line};
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
        channel: &Channel<SyncEvent>,
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
        channel: &Channel<SyncEvent>,
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
        });

        // Set up cancellation
        let cancel_token = CancellationToken::new();
        self.process_manager
            .set_cancel_token(cancel_token.clone())
            .await;

        info!("[gitPull] starting git pull in {}", ue_path.display());

        // Step 1: git stash to save local changes before pulling
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
        let mut child = tokio::process::Command::new("git")
            .args(["pull"])
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

        // INSTR-09 / D-09 / D-10: process.spawned at the track_pid site. git
        // pull has no identity-adjacent flags (arg vector is just `["pull"]`),
        // but `current_dir` embeds root_path — route cwd through the redact net
        // (Phase-10 Users-home pattern masks the prefix). The D-08 safeguard is
        // inline here (git has no p4-style client flag, so render_spawned_line's
        // p4-shaped prefix does not apply). Bound to named locals so the borrows
        // outlive the format!() / redact() expression statements.
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
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch_out.send(SyncEvent::LogLine {
                    line,
                    stream: "stdout".to_string(),
                });
            }
        });

        // Stream stderr
        let stderr = child.stderr.take().unwrap();
        let ch_err = channel.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch_err.send(SyncEvent::LogLine {
                    line,
                    stream: "stderr".to_string(),
                });
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
                    "git pull failed with exit code {}",
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
            });
        }

        // Get branch name: git rev-parse --abbrev-ref HEAD
        let branch_output = run_git(&ue_path, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        let branch = match branch_output {
            Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
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
        })
    }

    pub async fn cancel(&self) -> Result<(), AppError> {
        self.process_manager.stop_all().await
    }

    /// Run GenerateProjectFiles.bat after git pull to update project files
    async fn run_gen_project(
        &self,
        workspace: &WorkspaceConfig,
        channel: &Channel<SyncEvent>,
    ) -> Result<(), AppError> {
        let _ = channel.send(SyncEvent::StepStarted {
            step: "genProject".to_string(),
            description: "Generating project files...".to_string(),
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
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch_out.send(SyncEvent::LogLine {
                    line,
                    stream: "stdout".to_string(),
                });
            }
        });

        let ch_err = channel.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = ch_err.send(SyncEvent::LogLine {
                    line,
                    stream: "stderr".to_string(),
                });
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

/// Restore stashed changes via `git stash pop`, logging result to channel
async fn restore_stash(ue_path: &Path, channel: &Channel<SyncEvent>) -> Result<(), AppError> {
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
            remote: "https://alice:token@github.com/EpicGames/UnrealEngine.git".into(),
        };
        let dbg = format!("{:?}", gsi);
        assert!(!dbg.contains("alice"), "Debug leaked username: {dbg}");
        assert!(!dbg.contains("token"), "Debug leaked credential: {dbg}");
        assert!(dbg.contains("GitStatusInfo"), "Debug must still identify the type");
        assert!(dbg.contains("main"), "Debug must keep branch (non-identity)");
    }

    #[test]
    fn git_status_info_debug_keeps_counts() {
        // Regression: prove KEEP fields are retained (not over-masking).
        let gsi = GitStatusInfo {
            branch: "release".into(),
            ahead: 7,
            behind: 3,
            remote: "origin".into(),
        };
        let dbg = format!("{:?}", gsi);
        assert!(dbg.contains("7"));
        assert!(dbg.contains("3"));
        assert!(dbg.contains("release"));
        // The remote NAME "origin" is masked even though today it's harmless —
        // the mask is defensive against future URL-shaped values.
        assert!(!dbg.contains("origin"));
    }
}
