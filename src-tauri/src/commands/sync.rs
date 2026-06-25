use crate::models::SyncEvent;
use crate::services::p4_executor;
use crate::services::p4_executor::{P4Executor, SyncOptions};
use crate::services::process_manager::ProcessManager;
use crate::services::sync_orchestrator::SyncOrchestrator;
use crate::services::workspace::WorkspaceService;
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct P4BehindInfo {
    pub behind: u64,
}

#[tauri::command]
pub async fn start_sync(
    app: AppHandle,
    state: State<'_, Arc<SyncOrchestrator>>,
    workspace_id: String,
    target_cl: Option<String>,
    on_event: Channel<SyncEvent>,
) -> Result<(), String> {
    if let Some(ref cl) = target_cl {
        p4_executor::validate_target_cl(cl).map_err(|e| e.to_string())?;
    }
    state
        .run_pipeline(workspace_id, target_cl, on_event, app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_sync(state: State<'_, Arc<ProcessManager>>) -> Result<(), String> {
    state.stop_all().await.map_err(|e| e.to_string())
}

/// Run a Perforce dry-run (`p4 sync -n`) for the idle behind-check.
///
/// Reuses `P4Executor::dry_run_sync` exactly as-is: a fresh CancellationToken,
/// no ProcessManager (so the dry-run PID is NOT tracked by stop_all), and no
/// Channel (so it emits NO sync events). Display-only count of files behind.
#[tauri::command]
pub async fn check_sync_behind(
    app: AppHandle,
    state: State<'_, Arc<P4Executor>>,
    workspace_id: String,
) -> Result<P4BehindInfo, String> {
    let ws = WorkspaceService::get(&app, &workspace_id)
        .await
        .map_err(|e| e.to_string())?;

    let options = SyncOptions {
        target_cl: None,
        parallel_threads: ws.parallel_threads,
        exclusions: ws.exclusions.clone(),
        pin_cl: None,
    };

    let (request_id, token) = state.begin_behind_check().await;
    let result = state.dry_run_sync(&ws, &options, token, None).await;
    state.finish_behind_check(request_id).await;
    let count = result.map_err(|e| e.to_string())?;

    Ok(P4BehindInfo { behind: count })
}

#[tauri::command]
pub async fn cancel_sync_behind(state: State<'_, Arc<P4Executor>>) -> Result<(), String> {
    state.cancel_behind_check().await;
    Ok(())
}

#[tauri::command]
pub async fn get_current_cl(
    app: AppHandle,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let workspace = WorkspaceService::get(&app, &workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(workspace.last_sync_cl)
}

/// Returns whether a sync pipeline is currently running on the backend.
/// Used by the frontend to detect stale UI state when the WebView was
/// suspended (e.g. window minimized) and Channel events were lost.
#[tauri::command]
pub fn is_sync_running(state: State<'_, Arc<SyncOrchestrator>>) -> bool {
    state.is_pipeline_running()
}

#[tauri::command]
pub async fn retry_step(
    app: AppHandle,
    state: State<'_, Arc<SyncOrchestrator>>,
    workspace_id: String,
    step: String,
    target_cl: Option<String>,
    on_event: Channel<SyncEvent>,
) -> Result<(), String> {
    if let Some(ref cl) = target_cl {
        p4_executor::validate_target_cl(cl).map_err(|e| e.to_string())?;
    }
    state
        .retry_step(workspace_id, step, target_cl, on_event, app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_rollback(
    app: AppHandle,
    state: State<'_, Arc<SyncOrchestrator>>,
    workspace_id: String,
    target_cl: String,
    on_event: Channel<SyncEvent>,
) -> Result<(), String> {
    state
        .rollback_pipeline(workspace_id, target_cl, on_event, app)
        .await
        .map_err(|e| e.to_string())
}
