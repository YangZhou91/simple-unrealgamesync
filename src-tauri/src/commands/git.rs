use crate::models::SyncEvent;
use crate::services::git_service::{GitService, GitStatusInfo};
use crate::services::workspace::WorkspaceService;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn git_pull(
    app: AppHandle,
    state: State<'_, Arc<GitService>>,
    workspace_id: String,
    on_event: Channel<SyncEvent>,
) -> Result<(), String> {
    let workspace = WorkspaceService::get(&app, &workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    state
        .pull(&workspace, &on_event)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_status(
    app: AppHandle,
    state: State<'_, Arc<GitService>>,
    workspace_id: String,
) -> Result<GitStatusInfo, String> {
    let workspace = WorkspaceService::get(&app, &workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    state.status(&workspace).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_git_pull(state: State<'_, Arc<GitService>>) -> Result<(), String> {
    state.cancel().await.map_err(|e| e.to_string())
}
