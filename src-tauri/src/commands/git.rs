use crate::models::SyncEvent;
use crate::services::git_service::{GitService, GitStatusInfo};
use crate::services::workspace::WorkspaceService;
use crate::utils::log::trace_command;
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
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    // git_pull's freeze is the app-freeze-post-sync brief — the entry/exit pair
    // makes a hang greppable via [run=<id>] + the missing exit line.
    trace_command("git_pull", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        state
            .pull(&workspace, &on_event)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_status(
    app: AppHandle,
    state: State<'_, Arc<GitService>>,
    workspace_id: String,
) -> Result<GitStatusInfo, String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    trace_command("git_status", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        state.status(&workspace).await.map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn stop_git_pull(state: State<'_, Arc<GitService>>) -> Result<(), String> {
    trace_command("stop_git_pull", String::new(), async move {
        state.cancel().await.map_err(|e| e.to_string())
    })
    .await
}
