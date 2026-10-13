use crate::models::SyncEvent;
use crate::services::engine_service::EngineService;
use crate::services::workspace::WorkspaceService;
use crate::utils::counting_channel::CountingChannel;
use crate::utils::log::trace_command;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn engine_update(
    app: AppHandle,
    state: State<'_, Arc<EngineService>>,
    workspace_id: String,
    on_event: Channel<SyncEvent>,
) -> Result<(), String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    // The lock acquisition lives inside `EngineService::update`, so a refusal
    // still emits the `cmd.exit err` bookend.
    trace_command("engine_update", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        // D-04 (Phase 12 / HOTUI-12): wrap once at the command boundary so
        // every send in EngineService::update + its drains increments ONE
        // shared Arc<AtomicU64> total.
        let channel = CountingChannel::new(on_event);
        state
            .update(&workspace, &channel)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn stop_engine_update(state: State<'_, Arc<EngineService>>) -> Result<(), String> {
    trace_command("stop_engine_update", String::new(), async move {
        state.cancel().await.map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn engine_status(
    app: AppHandle,
    state: State<'_, Arc<EngineService>>,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    trace_command("engine_status", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        state
            .engine_cl(&workspace)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}
