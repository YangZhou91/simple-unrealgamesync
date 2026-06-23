use crate::models::{ChangelistEntry, HistoryRecord};
use crate::services::history::HistoryService;
use crate::services::p4_executor::P4Executor;
use crate::services::workspace::WorkspaceService;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_history(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<HistoryRecord>, String> {
    HistoryService::list_records(&app, &workspace_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_changelists(
    app: AppHandle,
    state: State<'_, Arc<P4Executor>>,
    workspace_id: String,
    batch_size: Option<u32>,
    after_cl: Option<String>,
) -> Result<Vec<ChangelistEntry>, String> {
    let workspace = WorkspaceService::get(&app, &workspace_id)
        .await
        .map_err(|e| e.to_string())?;

    state
        .get_changelists(&workspace, batch_size.unwrap_or(25), after_cl.as_deref())
        .await
        .map_err(|e| e.to_string())
}
