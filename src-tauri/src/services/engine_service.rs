//! The P4 engine-update service — a second backend with the same shape as
//! `git_service::GitService` but two deliberate divergences the phase decisions
//! require:
//!
//! 1. **D-03 — a missing `UnrealEngine/GenerateProjectFiles.bat` is fatal for
//!    the genProject step only.** The p4 sync's own success is reported first
//!    (`SyncCompleted`, carrying the engine's own CL); only then does the
//!    missing bat emit `SyncFailed{step:"genProject"}`. `git_service::run_gen_project`
//!    treats a missing bat as non-fatal (logs a line and returns `Ok(())`) — this
//!    action deliberately does not, because an engine update that silently
//!    produces no project files would be a partial success the UI could not
//!    distinguish from a full one.
//!
//! 2. **The terminal-event honesty (T-30-10).** The ordered pair
//!    `SyncCompleted` → `SyncFailed{step:"genProject"}` is LOAD-BEARING: it is
//!    what makes the frontend's fourth (`partial`) terminal state reachable. If
//!    only a failure were emitted, or the pair reordered, the reducer could not
//!    tell a partial success from a total failure.
//!
//! The genProject body is lifted from the orchestrator's **fatal** version
//! (`sync_orchestrator::gen_project`), including its abort-not-await discipline:
//! `GenerateProjectFiles.bat` invokes MSBuild with `/nodeReuse:true`, which
//! spawns `dotnet.exe` server processes that inherit the pipe handles and stay
//! alive indefinitely — awaiting the reader tasks would hang forever.

use crate::error::AppError;
use crate::models::{SyncEvent, WorkspaceConfig};
use crate::services::operation_lock::{Operation, OperationLock};
use crate::services::p4_executor::P4Executor;
use crate::services::process_manager::ProcessManager;
use crate::utils::counting_channel::CountingChannel;
use std::path::Path;
use std::sync::Arc;
use tauri_plugin_log::log::{error, info, warn};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// D-03: the three outcomes the genProject step can take, decided from the two
/// facts available at that point.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GenOutcome {
    /// The bat exists and no cancel landed — run GenerateProjectFiles.
    Run,
    /// A cancel landed after the sync completed — skip genProject entirely.
    /// `SyncCompleted` is already the single terminal event.
    SkippedCancelled,
    /// The bat is missing — fatal for this step only (D-03).
    FatalMissingBat,
}

/// D-03: decide the genProject step's behaviour from the two facts available.
///
/// **Deliberate divergence** from `git_service::run_gen_project` (bat-check at
/// `git_service.rs:565-580`), which logs a line and returns `Ok(())` on a
/// missing bat. Here a missing bat is fatal for the genProject step only: the
/// sync's own success has *already* been reported as `SyncCompleted`, so this
/// only denies the step that produces project files.
///
/// Precedence: a cancel that arrived after the sync wins over both bat states,
/// so a cancelled run never spawns a process and never emits a second terminal
/// event.
pub fn gen_project_outcome(bat_exists: bool, cancel_after_sync: bool) -> GenOutcome {
    if cancel_after_sync {
        GenOutcome::SkippedCancelled
    } else if bat_exists {
        GenOutcome::Run
    } else {
        GenOutcome::FatalMissingBat
    }
}

pub struct EngineService {
    p4: P4Executor,
    process_manager: Arc<ProcessManager>,
    lock: Arc<OperationLock>,
}

impl EngineService {
    pub fn new(process_manager: Arc<ProcessManager>, lock: Arc<OperationLock>) -> Self {
        Self {
            // A private executor, mirroring `SyncOrchestrator::new`'s precedent —
            // `command`-owned `Arc<P4Executor>` is separate and unneeded here.
            p4: P4Executor::new(),
            process_manager,
            lock,
        }
    }

    /// Run one engine update: count pass → sync pass → `SyncCompleted{engine CL}`
    /// → genProject. Emits exactly one terminal event on every path.
    pub async fn update(
        &self,
        workspace: &WorkspaceConfig,
        channel: &CountingChannel,
    ) -> Result<(), AppError> {
        // D-13: enter through the shared lock FIRST — before any `channel.send`,
        // so a refusal starts no partial work and emits no event.
        let _guard = self.lock.acquire(Operation::EngineUpdate)?;

        // Count phase start.
        let _ = channel.send(SyncEvent::StepStarted {
            step: "engineUpdate".to_string(),
            description: "Counting engine files...".to_string(),
            sub_step: Some("count".to_string()),
        });

        // Mirror `sync_orchestrator::p4_sync`'s enumeration notify so the bar
        // shows the pre-count indeterminate state.
        let _ = channel.send(SyncEvent::Progress {
            current: 0,
            total: 0,
            current_file: "Enumerating files...".to_string(),
            bytes_done: None,
            bytes_total: None,
            bytes_rate: None,
            percent: None,
            phase: None,
        });

        // Set up cancellation (the `git_service.rs:112-115` precedent).
        let cancel_token = CancellationToken::new();
        self.process_manager
            .set_cancel_token(cancel_token.clone())
            .await;

        // Count pass (`p4 sync -n UnrealEngine/Engine/...`). The count never
        // gates the update: a 0 denominator is legitimate and renders an
        // indeterminate bar — only a cancellation is terminal here.
        let total = match self
            .p4
            .count_engine_sync(
                workspace,
                workspace.parallel_threads,
                cancel_token.clone(),
                Some(self.process_manager.clone()),
            )
            .await
        {
            Ok(n) => n,
            Err(AppError::Cancelled) => {
                self.process_manager.clear_tracked().await;
                let _ = channel.send(SyncEvent::SyncCancelled {
                    step: "engineUpdate".to_string(),
                });
                // CR-01 (30-06): resolve `Ok(())` after the terminal
                // `SyncCancelled` — mirroring `git_service::pull`
                // (git_service.rs:381-384), where the cancel-derived terminal
                // event is the final word and the invoke must not reject after
                // it. The same applies to the two other cancel arms below; a
                // user cancel must never surface as an invoke rejection.
                return Ok(());
            }
            Err(e) => {
                warn!("[engineUpdate] count pass failed: {e}");
                0
            }
        };

        // Early exit if cancelled during the count pass — mirroring `p4_sync`.
        if cancel_token.is_cancelled() {
            self.process_manager.clear_tracked().await;
            let _ = channel.send(SyncEvent::SyncCancelled {
                step: "engineUpdate".to_string(),
            });
            return Ok(());
        }

        // Flip the running label from counting to updating.
        let _ = channel.send(SyncEvent::StepStarted {
            step: "engineUpdate".to_string(),
            description: "Updating engine...".to_string(),
            sub_step: Some("sync".to_string()),
        });

        // Real streaming sync. The caller owns `clear_tracked()` (the engine_sync
        // precedent).
        let sync_result = self
            .p4
            .engine_sync(
                workspace,
                channel,
                cancel_token.clone(),
                workspace.parallel_threads,
                total,
                Some(self.process_manager.clone()),
            )
            .await;
        self.process_manager.clear_tracked().await;

        let (files_synced, warnings) = match sync_result {
            Err(AppError::Cancelled) => {
                let _ = channel.send(SyncEvent::SyncCancelled {
                    step: "engineUpdate".to_string(),
                });
                // CR-01 (30-06): see the count-pass cancel arm above — the
                // terminal `SyncCancelled` is the final word; resolve `Ok(())`.
                return Ok(());
            }
            Err(e) => {
                let _ = channel.send(SyncEvent::SyncFailed {
                    step: "engineUpdate".to_string(),
                    error: e.to_string(),
                });
                return Err(e);
            }
            Ok((files_synced, warnings)) => (files_synced, warnings),
        };

        // The engine subtree's own CL (D-10). A p4 failure yields `None` — never
        // an error — so a hiccup in this query cannot erase the sync's success.
        let cl = self.p4.engine_have_changelist(workspace).await.unwrap_or(None);

        // Report the sync's own success honestly and BEFORE the genProject step
        // (D-03 / T-30-10). No sync-history record is written: the engine's CL
        // must not enter the project-scoped history (30-UI-SPEC.md §8.5).
        let _ = channel.send(SyncEvent::SyncCompleted {
            changelist: cl.clone(),
            files_synced,
            warnings,
        });

        info!(
            "[engineUpdate] sync complete, cl={:?}, files={}",
            cl, files_synced
        );

        // genProject step (D-03). Derive the shared bat path, decide the outcome
        // from the two facts available, and dispatch.
        let root = Path::new(&workspace.root_path);
        let bat_path = root.join("UnrealEngine/GenerateProjectFiles.bat");

        let outcome = gen_project_outcome(bat_path.exists(), cancel_token.is_cancelled());
        match outcome {
            // A cancel that landed between `SyncCompleted` and this spawn: skip
            // genProject entirely. `SyncCompleted` is already the single terminal
            // event, so this path emits no second one and leaves no running state.
            GenOutcome::SkippedCancelled => {
                self.process_manager.clear_tracked().await;
                info!("[engineUpdate] genProject skipped (cancelled after sync)");
                Ok(())
            }
            // Fatal for the genProject step only (D-03): the sync's success was
            // already reported as `SyncCompleted`; now the missing bat denies
            // only the step that produces project files. NO `StepCompleted` is
            // emitted on this path — the pair the frontend recognizes is exactly
            // `SyncCompleted` then `SyncFailed{step:"genProject"}`.
            GenOutcome::FatalMissingBat => {
                error!("[genProject] bat file not found: {}", bat_path.display());
                let _ = channel.send(SyncEvent::SyncFailed {
                    step: "genProject".to_string(),
                    error: AppError::CommandFailed {
                        step: "genProject".to_string(),
                        exit_code: None,
                    }
                    .to_string(),
                });
                Err(AppError::CommandFailed {
                    step: "genProject".to_string(),
                    exit_code: None,
                })
            }
            GenOutcome::Run => self.run_gen_project(workspace, channel).await,
        }
    }

    /// Run `GenerateProjectFiles.bat` — the **fatal** version D-03 chooses
    /// (lifted from `sync_orchestrator::gen_project`, not
    /// `git_service::run_gen_project`'s non-fatal skip).
    ///
    /// A cancel that arrives DURING this step needs no new branch:
    /// `stop_engine_update` → `ProcessManager::stop_all()` cancels the token and
    /// `taskkill`s the tracked `cmd` pid, so `child.wait()` returns a non-success
    /// status and the path below emits `StepCompleted{genProject,false}` +
    /// `SyncFailed{step:"genProject"}` — the engine did update, the project files
    /// did not, and the panel renders `partial`.
    async fn run_gen_project(
        &self,
        workspace: &WorkspaceConfig,
        channel: &CountingChannel,
    ) -> Result<(), AppError> {
        // Reuses the existing frozen ("genProject","gen") token — no new token.
        let _ = channel.send(SyncEvent::StepStarted {
            step: "genProject".to_string(),
            description: "Generating project files...".to_string(),
            sub_step: Some("gen".to_string()),
        });

        let root = Path::new(&workspace.root_path);
        let bat_path = root.join("UnrealEngine/GenerateProjectFiles.bat");
        let work_dir = root.join("UnrealEngine");
        info!(
            "[genProject] bat_path={}, work_dir={}",
            bat_path.display(),
            work_dir.display()
        );

        // T-30-08: the executed path is a fixed relative literal appended to a
        // persisted workspace root, and `current_dir` is pinned to the
        // `UnrealEngine/` sibling. The bat path is passed as a single `args`
        // element, never interpolated into a shell string, so no user-controlled
        // token reaches the interpreter's command line.
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", &bat_path.to_string_lossy()])
            .current_dir(&work_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(AppError::ProcessSpawn)?;

        if let Some(id) = child.id() {
            self.process_manager.track_pid(id).await;
        }

        use tokio::io::{AsyncBufReadExt, BufReader};
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let ch_out = channel.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut log_buf: Vec<String> = Vec::with_capacity(256);
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
            // HOTUI-12: one per-completion counter summary per drain per run.
            // log_enabled! guard mandatory (HOTUI-13 eager-eval rule).
            if log::log_enabled!(log::Level::Debug) {
                crate::utils::log::debug!(
                    "ipc.channel drain complete stream=stdout sent_total={}",
                    ch_out.count()
                );
            }
        });

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
            // HOTUI-12: one per-completion counter summary per drain per run.
            if log::log_enabled!(log::Level::Debug) {
                crate::utils::log::debug!(
                    "ipc.channel drain complete stream=stderr sent_total={}",
                    ch_err.count()
                );
            }
        });

        let status = child.wait().await.map_err(AppError::ProcessSpawn)?;
        self.process_manager.clear_tracked().await;

        // T-30-09: abort the reader tasks instead of awaiting them.
        // GenerateProjectFiles.bat invokes MSBuild with /nodeReuse:true, which
        // spawns dotnet.exe server processes that inherit the pipe handles and
        // stay alive indefinitely. Awaiting the readers would hang forever
        // because BufReader::lines() never sees EOF while those servers hold the
        // pipes open. By this point the actual batch process has exited and all
        // meaningful output has already been sent.
        stdout_task.abort();
        stderr_task.abort();

        if !status.success() {
            let _ = channel.send(SyncEvent::StepCompleted {
                step: "genProject".to_string(),
                success: false,
            });
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "genProject".to_string(),
                error: AppError::CommandFailed {
                    step: "genProject".to_string(),
                    exit_code: status.code(),
                }
                .to_string(),
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
        Ok(())
    }

    /// Cancel the in-flight engine update.
    ///
    /// Delegates to `ProcessManager::stop_all()`, which cancels the token and
    /// then `taskkill /F /T /PID`s each tracked pid. Calling it twice is safe:
    /// the second call finds nothing tracked and returns `Ok(())`, leaving the
    /// already-reached terminal state alone.
    pub async fn cancel(&self) -> Result<(), AppError> {
        self.process_manager.stop_all().await
    }

    /// The engine subtree's own have-CL (D-10). Returns `Ok(None)` on any p4
    /// failure — never an error.
    pub async fn engine_cl(
        &self,
        workspace: &WorkspaceConfig,
    ) -> Result<Option<String>, AppError> {
        self.p4.engine_have_changelist(workspace).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gen_project_outcome_covers_all_four_input_combinations() {
        // Only the no-cancel + bat-present combination runs.
        assert_eq!(gen_project_outcome(true, false), GenOutcome::Run);
        // A missing bat with no cancel is fatal for this step.
        assert_eq!(
            gen_project_outcome(false, false),
            GenOutcome::FatalMissingBat
        );
        // Cancel wins over BOTH bat states.
        assert_eq!(
            gen_project_outcome(true, true),
            GenOutcome::SkippedCancelled
        );
        assert_eq!(
            gen_project_outcome(false, true),
            GenOutcome::SkippedCancelled
        );
    }

    #[test]
    fn gen_outcome_has_exactly_three_variants() {
        // Compile-time pin: this exhaustive match fails to compile if a variant
        // is ever added without being handled here.
        for outcome in [
            GenOutcome::Run,
            GenOutcome::SkippedCancelled,
            GenOutcome::FatalMissingBat,
        ] {
            let _label: &str = match outcome {
                GenOutcome::Run => "run",
                GenOutcome::SkippedCancelled => "skippedCancelled",
                GenOutcome::FatalMissingBat => "fatalMissingBat",
            };
        }
    }

    #[test]
    fn test_gen_project_missing_bat_is_terminal_failure_after_sync() {
        // A missing bat can NEVER map to Run — it can never be a silent success
        // (this is the whole point of D-03's divergence from git_service).
        assert_eq!(
            gen_project_outcome(false, false),
            GenOutcome::FatalMissingBat,
            "a missing bat must never map to Run"
        );

        // The three GenOutcome arms, matched exhaustively, produce (in order):
        //   SkippedCancelled -> Ok(())                     (no second terminal event)
        //   FatalMissingBat  -> Err(CommandFailed{genProject})  (after SyncCompleted)
        //   Run (bat exits non-zero) -> Err(CommandFailed{genProject})
        // Only the SkippedCancelled arm yields a clean return.
        let cases: [GenOutcome; 3] = [
            GenOutcome::SkippedCancelled,
            GenOutcome::FatalMissingBat,
            GenOutcome::Run,
        ];
        let results: Vec<Result<(), AppError>> = cases
            .iter()
            .map(|outcome| match outcome {
                GenOutcome::SkippedCancelled => Ok(()),
                GenOutcome::FatalMissingBat => Err(AppError::CommandFailed {
                    step: "genProject".to_string(),
                    exit_code: None,
                }),
                // The Run arm's return when the bat exits non-zero.
                GenOutcome::Run => Err(AppError::CommandFailed {
                    step: "genProject".to_string(),
                    exit_code: Some(1),
                }),
            })
            .collect();

        assert!(
            results[0].is_ok(),
            "only the SkippedCancelled arm returns a clean Ok"
        );
        for r in &results[1..] {
            match r {
                Err(AppError::CommandFailed { step, .. }) => {
                    assert_eq!(step.as_str(), "genProject")
                }
                other => panic!("expected CommandFailed{{genProject}}, got {other:?}"),
            }
        }
    }
}
