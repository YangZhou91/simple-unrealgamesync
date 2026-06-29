use crate::error::AppError;
use crate::models::{HistoryRecord, SyncEvent, WorkspaceConfig};
use crate::services::history::HistoryService;
use crate::services::p4_executor::{validate_target_cl, P4Executor, SyncOptions};
use crate::services::process_manager::ProcessManager;
use crate::services::workspace::WorkspaceService;
use crate::utils::log::StepScope;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tauri_plugin_log::log::{error, info, warn};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt as _;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Payload for sync-state app-level events consumed by the tray manager.
#[derive(Clone, serde::Serialize)]
struct SyncStatePayload {
    state: String,
    detail: Option<String>,
}

pub struct SyncOrchestrator {
    p4: P4Executor,
    process_manager: Arc<ProcessManager>,
    pipeline_running: AtomicBool,
}

impl SyncOrchestrator {
    pub fn new(process_manager: Arc<ProcessManager>) -> Self {
        Self {
            p4: P4Executor::new(),
            process_manager,
            pipeline_running: AtomicBool::new(false),
        }
    }

    pub fn is_pipeline_running(&self) -> bool {
        self.pipeline_running.load(Ordering::SeqCst)
    }

    pub async fn run_pipeline(
        &self,
        workspace_id: String,
        target_cl: Option<String>,
        channel: Channel<SyncEvent>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        if self.pipeline_running.swap(true, Ordering::SeqCst) {
            return Err(AppError::Process(
                "A sync pipeline is already running".into(),
            ));
        }

        let result = self
            .run_pipeline_inner(workspace_id, target_cl, channel, app)
            .await;
        self.pipeline_running.store(false, Ordering::SeqCst);
        result
    }

    async fn run_pipeline_inner(
        &self,
        workspace_id: String,
        target_cl: Option<String>,
        channel: Channel<SyncEvent>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        let workspace = WorkspaceService::get(&app, &workspace_id).await?;

        // Network pre-check (silent -- not a StepIndicator step, per D-01)
        info!("[sync] workspace={}", workspace.name);
        let step = StepScope::new("networkCheck");
        if let Err(e) = self.p4.check_connectivity(&workspace).await {
            error!("[sync] step=networkCheck failed: {e}");
            step.failed();
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "networkCheck".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "networkCheck", e)),
                },
            );
            return Err(e);
        }
        step.done("");
        let _ = app.emit(
            "sync-state",
            SyncStatePayload {
                state: "syncing".into(),
                detail: None,
            },
        );

        // Build SyncOptions from workspace config + target_cl
        let options = SyncOptions {
            target_cl: target_cl.clone(),
            parallel_threads: workspace.parallel_threads,
            exclusions: workspace.exclusions.clone(),
        };

        // Step 1: Close UE Editor
        info!("[sync] workspace={}", workspace.name);
        let step = StepScope::new("closeUe");
        if let Err(e) = self.close_ue(&channel).await {
            error!("[sync] step=closeUe failed: {e}");
            step.failed();
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "closeUe".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "closeUe", e)),
                },
            );
            return Err(e);
        }
        step.done("");

        // Step 2: Clean Dev Directory
        let step = StepScope::new("cleanDevDir");
        info!("[sync] root={}", workspace.root_path);
        if let Err(e) = self.clean_dev_dir(&workspace, &channel).await {
            error!("[sync] step=cleanDevDir failed: {e}");
            step.failed();
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "cleanDevDir".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "cleanDevDir", e)),
                },
            );
            return Err(e);
        }
        step.done("");

        // Step 3: p4 sync
        let step = StepScope::new("p4Sync");
        info!(
            "[sync] target_cl={}",
            options.target_cl.as_deref().unwrap_or("none")
        );
        let cancel_token = CancellationToken::new();
        self.process_manager
            .set_cancel_token(cancel_token.clone())
            .await;

        let files_result = self
            .p4_sync(&workspace, &channel, cancel_token, &options)
            .await;
        self.process_manager.clear_tracked().await;

        if let Err(e) = files_result {
            if matches!(e, AppError::Cancelled) {
                step.cancelled();
                let _ = channel.send(SyncEvent::SyncCancelled {
                    step: "p4Sync".to_string(),
                });
                let _ = app.emit(
                    "sync-state",
                    SyncStatePayload {
                        state: "idle".into(),
                        detail: Some("cancelled".to_string()),
                    },
                );
                return Ok(());
            }
            error!("[sync] step=p4Sync failed: {e}");
            step.failed();
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "p4Sync".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "p4Sync", e)),
                },
            );
            return Err(e);
        }
        let files_synced = files_result.unwrap();
        step.done(&format!("files_synced={files_synced}"));

        // Step 3b: Force sync Engine files (non-fatal, per D-03)
        // Only runs when an explicit changelist is provided. An empty changelist
        // means a lightweight project-only update — skip the Engine force sync
        // entirely (and emit no forceSync events) per FORCESYNC-COND-01.
        if target_cl.is_some() {
            let step = StepScope::new("forceSync");
            let force_cancel = CancellationToken::new();
            self.process_manager
                .set_cancel_token(force_cancel.clone())
                .await;
            let _ = self
                .force_sync_engine_step(&workspace, &channel, force_cancel)
                .await;
            self.process_manager.clear_tracked().await;
            step.done("");
        } else {
            info!("[sync] step=forceSync skipped (no target changelist)");
        }

        // Step 4: GenerateProjectFiles
        let step = StepScope::new("genProject");
        if let Err(e) = self.gen_project(&workspace, &channel).await {
            error!("[sync] step=genProject failed: {e}");
            step.failed();
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "genProject".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "genProject", e)),
                },
            );
            return Err(e);
        }
        step.done("");

        // Use target_cl directly when specified — get_have_changelist would return
        // the wrong CL because excluded paths (Binaries, etc.) remain at higher CLs
        let cl = if target_cl.is_some() {
            target_cl.clone()
        } else {
            self.p4.get_have_changelist(&workspace).await.ok().flatten()
        };
        info!(
            "[sync] pipeline complete, cl={}, files={files_synced}",
            cl.as_deref().unwrap_or("none")
        );
        let _ = channel.send(SyncEvent::SyncCompleted {
            changelist: cl.clone(),
            files_synced,
        });
        let _ = app.emit(
            "sync-state",
            SyncStatePayload {
                state: "idle".into(),
                detail: Some(format!(
                    "Sync completed: {} files synced to CL@{}",
                    files_synced,
                    cl.as_deref().unwrap_or("?")
                )),
            },
        );

        // Update workspace with last sync info
        let cl_for_update = cl.clone();
        let _ = WorkspaceService::update(&app, &workspace_id, |ws| {
            ws.last_sync_cl = cl_for_update;
            ws.last_sync_time = Some(now_string());
            ws.last_sync_file_count = Some(files_synced);
        })
        .await;

        // Save history record after successful sync
        if let Some(ref cl_value) = cl {
            let _ = HistoryService::save_record(
                &app,
                HistoryRecord {
                    changelist: cl_value.clone(),
                    timestamp: now_string(),
                    file_count: files_synced,
                    workspace_id: workspace_id.clone(),
                },
            )
            .await;
        }

        Ok(())
    }

    pub async fn rollback_pipeline(
        &self,
        workspace_id: String,
        target_cl: String,
        channel: Channel<SyncEvent>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        if self.pipeline_running.swap(true, Ordering::SeqCst) {
            return Err(AppError::Process(
                "A sync pipeline is already running".into(),
            ));
        }

        let result = self
            .rollback_pipeline_inner(workspace_id, target_cl, channel, app)
            .await;
        self.pipeline_running.store(false, Ordering::SeqCst);
        result
    }

    async fn rollback_pipeline_inner(
        &self,
        workspace_id: String,
        target_cl: String,
        channel: Channel<SyncEvent>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        // Validate target_cl
        validate_target_cl(&target_cl)?;

        let workspace = WorkspaceService::get(&app, &workspace_id).await?;

        // Network pre-check (silent -- not a StepIndicator step)
        info!(
            "[sync] workspace={}, step=networkCheck starting",
            workspace.name
        );
        if let Err(e) = self.p4.check_connectivity(&workspace).await {
            error!("[sync] step=networkCheck failed: {e}");
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "networkCheck".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "networkCheck", e)),
                },
            );
            return Err(e);
        }
        info!("[sync] step=networkCheck done");
        let _ = app.emit(
            "sync-state",
            SyncStatePayload {
                state: "syncing".into(),
                detail: None,
            },
        );

        // Step 1: Close UE Editor
        if let Err(e) = self.close_ue(&channel).await {
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "closeUe".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "closeUe", e)),
                },
            );
            return Err(e);
        }

        // Step 2: p4 sync @CL (NO clean_dev_dir -- D-06)
        let cancel_token = CancellationToken::new();
        self.process_manager
            .set_cancel_token(cancel_token.clone())
            .await;

        let options = SyncOptions {
            target_cl: Some(target_cl.clone()),
            parallel_threads: workspace.parallel_threads,
            exclusions: workspace.exclusions.clone(),
        };

        let files_result = self
            .p4_sync(&workspace, &channel, cancel_token, &options)
            .await;
        self.process_manager.clear_tracked().await;

        if let Err(e) = files_result {
            if matches!(e, AppError::Cancelled) {
                let _ = channel.send(SyncEvent::SyncCancelled {
                    step: "p4Sync".to_string(),
                });
                let _ = app.emit(
                    "sync-state",
                    SyncStatePayload {
                        state: "idle".into(),
                        detail: Some("cancelled".to_string()),
                    },
                );
                return Ok(());
            }
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "p4Sync".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "p4Sync", e)),
                },
            );
            return Err(e);
        }
        let files_synced = files_result.unwrap();

        // Step 2b: Force sync Engine files (non-fatal, per D-04)
        info!("[sync-rollback] step=forceSync starting");
        let force_cancel = CancellationToken::new();
        self.process_manager
            .set_cancel_token(force_cancel.clone())
            .await;
        let _ = self
            .force_sync_engine_step(&workspace, &channel, force_cancel)
            .await;
        self.process_manager.clear_tracked().await;
        info!("[sync-rollback] step=forceSync done");

        // Step 3: GenerateProjectFiles
        if let Err(e) = self.gen_project(&workspace, &channel).await {
            let _ = channel.send(SyncEvent::SyncFailed {
                step: "genProject".to_string(),
                error: e.to_string(),
            });
            let _ = app.emit(
                "sync-state",
                SyncStatePayload {
                    state: "error".into(),
                    detail: Some(format!("Sync failed at step {}: {}", "genProject", e)),
                },
            );
            return Err(e);
        }

        let cl = Some(target_cl.clone());
        let _ = channel.send(SyncEvent::SyncCompleted {
            changelist: cl.clone(),
            files_synced,
        });
        let _ = app.emit(
            "sync-state",
            SyncStatePayload {
                state: "idle".into(),
                detail: Some(format!(
                    "Sync completed: {} files synced to CL@{}",
                    files_synced,
                    cl.as_deref().unwrap_or("?")
                )),
            },
        );

        // Update workspace with last sync info
        let cl_for_update = cl.clone();
        let _ = WorkspaceService::update(&app, &workspace_id, |ws| {
            ws.last_sync_cl = cl_for_update;
            ws.last_sync_time = Some(now_string());
            ws.last_sync_file_count = Some(files_synced);
        })
        .await;

        // Save history record after successful rollback
        if let Some(ref cl_value) = cl {
            let _ = HistoryService::save_record(
                &app,
                HistoryRecord {
                    changelist: cl_value.clone(),
                    timestamp: now_string(),
                    file_count: files_synced,
                    workspace_id: workspace_id.clone(),
                },
            )
            .await;
        }

        Ok(())
    }

    pub async fn retry_step(
        &self,
        workspace_id: String,
        step: String,
        target_cl: Option<String>,
        channel: Channel<SyncEvent>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        if self.pipeline_running.swap(true, Ordering::SeqCst) {
            return Err(AppError::Process(
                "A sync pipeline is already running".into(),
            ));
        }

        let result = self
            .retry_step_inner(workspace_id, step, target_cl, channel, app)
            .await;
        self.pipeline_running.store(false, Ordering::SeqCst);
        result
    }

    async fn retry_step_inner(
        &self,
        workspace_id: String,
        step: String,
        target_cl: Option<String>,
        channel: Channel<SyncEvent>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        let workspace = WorkspaceService::get(&app, &workspace_id).await?;

        match step.as_str() {
            "closeUe" => self.close_ue(&channel).await?,
            "cleanDevDir" => self.clean_dev_dir(&workspace, &channel).await?,
            "p4Sync" => {
                let options = SyncOptions {
                    target_cl: target_cl.clone(),
                    parallel_threads: workspace.parallel_threads,
                    exclusions: workspace.exclusions.clone(),
                };
                let cancel_token = CancellationToken::new();
                self.process_manager
                    .set_cancel_token(cancel_token.clone())
                    .await;
                let result = self
                    .p4_sync(&workspace, &channel, cancel_token, &options)
                    .await;
                self.process_manager.clear_tracked().await;
                result?;
            }
            "genProject" => self.gen_project(&workspace, &channel).await?,
            "forceSync" => {
                let cancel_token = CancellationToken::new();
                self.process_manager
                    .set_cancel_token(cancel_token.clone())
                    .await;
                let _ = self
                    .force_sync_engine_step(&workspace, &channel, cancel_token)
                    .await;
                self.process_manager.clear_tracked().await;
            }
            _ => return Err(AppError::Process(format!("Unknown step: {}", step))),
        }

        Ok(())
    }

    async fn close_ue(&self, channel: &Channel<SyncEvent>) -> Result<(), AppError> {
        let _ = channel.send(SyncEvent::StepStarted {
            step: "closeUe".to_string(),
            description: "Checking for UE Editor...".to_string(),
        });

        // Use tasklist to find any UnrealEditor process (handles all variants).
        // tasklist truncates long names but the PID column is always present.
        let output = tokio::process::Command::new("tasklist")
            .args(["/NH"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            .map_err(AppError::ProcessSpawn)?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if !line.contains("UnrealEditor") {
                continue;
            }
            // Format: "name.exe    PID Console    N mem K"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                let name = parts[0];
                let pid = parts[1];
                info!("[closeUe] found {name} (PID {pid}), killing...");
                let kill_output = tokio::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", pid])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .await
                    .map_err(AppError::ProcessSpawn)?;
                if !kill_output.status.success() {
                    let stderr = String::from_utf8_lossy(&kill_output.stderr);
                    warn!("[closeUe] taskkill PID {pid} failed: {}", stderr.trim());
                }
            }
        }

        let _ = channel.send(SyncEvent::StepCompleted {
            step: "closeUe".to_string(),
            success: true,
        });

        Ok(())
    }

    async fn clean_dev_dir(
        &self,
        workspace: &WorkspaceConfig,
        channel: &Channel<SyncEvent>,
    ) -> Result<(), AppError> {
        let _ = channel.send(SyncEvent::StepStarted {
            step: "cleanDevDir".to_string(),
            description: "Cleaning Dev Directory...".to_string(),
        });

        // Find the project dir at root/<project> or root/UnrealEngine/<project>
        let root = Path::new(&workspace.root_path);
        let project_candidates = [
            root.join(format!("UnrealEngine/{}", workspace.project_dir)),
            root.join(&workspace.project_dir),
        ];
        let project_path = project_candidates
            .iter()
            .find(|p| p.exists())
            .unwrap_or(&project_candidates[1]);

        let devs_path = project_path.join("Content/Developers");

        if devs_path.exists() {
            let canonical_root = Path::new(&workspace.root_path)
                .canonicalize()
                .map_err(AppError::ProcessSpawn)?;

            let mut entries = tokio::fs::read_dir(&devs_path)
                .await
                .map_err(AppError::ProcessSpawn)?;

            while let Some(entry) = entries.next_entry().await.map_err(AppError::ProcessSpawn)? {
                let entry_path = entry.path();
                let file_name = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");

                if file_name == workspace.p4_user {
                    continue;
                }

                let canonical_entry = match entry_path.canonicalize() {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                if !canonical_entry.starts_with(&canonical_root) {
                    continue;
                }

                if entry_path.is_dir() {
                    tokio::fs::remove_dir_all(&entry_path)
                        .await
                        .map_err(AppError::ProcessSpawn)?;
                }
            }
        }

        let _ = channel.send(SyncEvent::StepCompleted {
            step: "cleanDevDir".to_string(),
            success: true,
        });

        Ok(())
    }

    async fn p4_sync(
        &self,
        workspace: &WorkspaceConfig,
        channel: &Channel<SyncEvent>,
        cancel: CancellationToken,
        options: &SyncOptions,
    ) -> Result<u64, AppError> {
        let description = match &options.target_cl {
            Some(cl) => format!("Syncing to CL #{}...", cl),
            None => "Syncing from Perforce...".to_string(),
        };
        let _ = channel.send(SyncEvent::StepStarted {
            step: "p4Sync".to_string(),
            description,
        });

        let total = Arc::new(AtomicU64::new(0));

        let ws = workspace.clone();
        let total_clone = total.clone();
        let options_clone = SyncOptions {
            target_cl: options.target_cl.clone(),
            parallel_threads: options.parallel_threads,
            exclusions: options.exclusions.clone(),
        };
        let cancel_clone = cancel.clone();

        // Notify user that we're enumerating files (dry run phase)
        let _ = channel.send(SyncEvent::Progress {
            current: 0,
            total: 0,
            current_file: "Enumerating files...".to_string(),
        });

        // Run dry_run first to get total file count BEFORE starting sync
        // This ensures Progress events during sync have accurate total for percentage display
        // Timeout and cancellation are handled inside dry_run_sync
        let pm_for_dry_run = self.process_manager.clone();
        let dry_run_handle = tokio::spawn(async move {
            let executor = P4Executor::new();
            match executor
                .dry_run_sync(&ws, &options_clone, cancel_clone, Some(pm_for_dry_run))
                .await
            {
                Ok(count) => {
                    info!("[dry_run] completed, total files: {count}");
                    total_clone.store(count, Ordering::Relaxed);
                }
                Err(AppError::Cancelled) => warn!("[dry_run] cancelled"),
                Err(e) => warn!("[dry_run] failed: {e}, progress total will be 0"),
            }
        });

        // Await dry_run to complete before starting sync
        if let Err(e) = dry_run_handle.await {
            warn!("[dry_run] task join error: {e}");
        }

        // Early exit if cancelled during dry_run — no point starting the real sync
        if cancel.is_cancelled() {
            return Err(AppError::Cancelled);
        }

        let files_synced = self
            .p4
            .sync(
                workspace,
                channel,
                cancel,
                options,
                total.clone(),
                Some(self.process_manager.clone()),
            )
            .await;

        // Forward final total to frontend for completion state.
        // Clamp: use max(dry_run_total, actual_synced) so the final progress
        // event never shows current > total when the real sync outruns the
        // dry-run estimate (e.g. new CLs landed between preview and actual sync).
        let dry_run_total = total.load(Ordering::Relaxed);
        let actual_count = files_synced.as_ref().copied().unwrap_or(0);
        let clamped_total = dry_run_total.max(actual_count);
        if clamped_total > 0 {
            let _ = channel.send(SyncEvent::Progress {
                current: actual_count,
                total: clamped_total,
                current_file: String::new(),
            });
        }

        let _ = channel.send(SyncEvent::StepCompleted {
            step: "p4Sync".to_string(),
            success: files_synced.is_ok(),
        });

        files_synced
    }

    /// Non-fatal force sync step for Engine subtree.
    /// Always returns Ok(()) — logs and reports status but cannot fail the pipeline (per D-07).
    async fn force_sync_engine_step(
        &self,
        workspace: &WorkspaceConfig,
        channel: &Channel<SyncEvent>,
        cancel: CancellationToken,
    ) -> Result<(), AppError> {
        let _ = channel.send(SyncEvent::StepStarted {
            step: "forceSync".to_string(),
            description: "Force syncing Engine files...".to_string(),
        });

        match self
            .p4
            .force_sync_engine(
                workspace,
                channel,
                cancel,
                Some(self.process_manager.clone()),
            )
            .await
        {
            Ok(()) => {
                let _ = channel.send(SyncEvent::StepCompleted {
                    step: "forceSync".to_string(),
                    success: true,
                });
                Ok(())
            }
            Err(e) => {
                warn!("[forceSync] failed (non-fatal): {e}");
                let _ = channel.send(SyncEvent::LogLine {
                    line: format!("Force sync warning (non-fatal): {e}"),
                    stream: "stderr".to_string(),
                });
                let _ = channel.send(SyncEvent::StepCompleted {
                    step: "forceSync".to_string(),
                    success: false,
                });
                Ok(())
            }
        }
    }

    async fn gen_project(
        &self,
        workspace: &WorkspaceConfig,
        channel: &Channel<SyncEvent>,
    ) -> Result<(), AppError> {
        let _ = channel.send(SyncEvent::StepStarted {
            step: "genProject".to_string(),
            description: "Generating project files...".to_string(),
        });

        // GenerateProjectFiles.bat lives in the UnrealEngine/ subdirectory
        let root = Path::new(&workspace.root_path);
        let bat_path = root.join("UnrealEngine/GenerateProjectFiles.bat");
        let work_dir = root.join("UnrealEngine");
        info!(
            "[genProject] bat_path={}, work_dir={}",
            bat_path.display(),
            work_dir.display()
        );

        if !bat_path.exists() {
            error!("[genProject] bat file not found: {}", bat_path.display());
            return Err(AppError::CommandFailed {
                step: "genProject".to_string(),
                exit_code: None,
            });
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

        // Track the cmd process PID so stop_all can kill it
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
        });

        let status = child.wait().await.map_err(AppError::ProcessSpawn)?;
        self.process_manager.clear_tracked().await;

        // Abort stdout/stderr reader tasks instead of awaiting them.
        // GenerateProjectFiles.bat invokes MSBuild with /nodeReuse:true, which
        // spawns dotnet.exe server processes that inherit the pipe handles and
        // stay alive indefinitely.  Awaiting the reader tasks would hang
        // forever because BufReader::lines() never sees EOF while those
        // servers hold the pipes open.  By this point the actual batch process
        // has exited and all meaningful output has already been sent.
        stdout_task.abort();
        stderr_task.abort();

        if !status.success() {
            let _ = channel.send(SyncEvent::StepCompleted {
                step: "genProject".to_string(),
                success: false,
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
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Check if a step name is a known/retryable pipeline step.
/// Used to validate retry requests without needing a full app harness.
pub fn is_known_step(step: &str) -> bool {
    matches!(
        step,
        "closeUe" | "cleanDevDir" | "p4Sync" | "forceSync" | "genProject"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_known_step_all_valid() {
        assert!(is_known_step("closeUe"));
        assert!(is_known_step("cleanDevDir"));
        assert!(is_known_step("p4Sync"));
        assert!(is_known_step("forceSync"));
        assert!(is_known_step("genProject"));
    }

    #[test]
    fn test_is_known_step_rejects_unknown() {
        assert!(!is_known_step("unknown"));
        assert!(!is_known_step("networkCheck"));
        assert!(!is_known_step(""));
        assert!(!is_known_step("FORCE"));
    }
}
