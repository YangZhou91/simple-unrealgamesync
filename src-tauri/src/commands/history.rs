use crate::models::{ChangelistEntry, HistoryRecord};
use crate::services::history::HistoryService;
use crate::services::p4_executor::P4Executor;
use crate::services::workspace::WorkspaceService;
use crate::utils::log::trace_command;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_history(
    app: AppHandle,
    workspace_id: String,
) -> Result<Vec<HistoryRecord>, String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    trace_command("get_history", args_redacted, async move {
        HistoryService::list_records(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_changelists(
    app: AppHandle,
    state: State<'_, Arc<P4Executor>>,
    workspace_id: String,
    batch_size: Option<u32>,
    after_cl: Option<String>,
) -> Result<Vec<ChangelistEntry>, String> {
    // SC#3 gate: Option<u32> renders via .map(|b| b.to_string()).unwrap_or_else
    // (NOT {:?}); Option<String> via as_deref().unwrap_or("none").
    let args_redacted = crate::utils::redact::redact(&format!(
        "workspace_id={workspace_id} batch_size={} after_cl={}",
        batch_size
            .map(|b| b.to_string())
            .unwrap_or_else(|| "default".to_string()),
        after_cl.as_deref().unwrap_or("none")
    ))
    .into_owned();
    trace_command("get_changelists", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;

        state
            .get_changelists(&workspace, batch_size.unwrap_or(25), after_cl.as_deref())
            .await
            .map_err(|e| e.to_string())
    })
    .await
}
