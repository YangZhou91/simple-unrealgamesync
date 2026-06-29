use crate::models::SyncEvent;
use crate::services::p4_executor;
use crate::services::p4_executor::{P4Executor, SyncOptions};
use crate::services::process_manager::ProcessManager;
use crate::services::sync_orchestrator::SyncOrchestrator;
use crate::services::workspace::WorkspaceService;
use crate::utils::log::{trace_command, trace_command_sync_ok};
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
    // SC#3 gate: Option<String> renders via the as_deref().unwrap_or("none")
    // shim — NEVER `{:?}`. workspace_id is opaque (not identity), passes redact
    // unchanged. Routed through the Phase-10 redact net (T-11-PII).
    let args_redacted = crate::utils::redact::redact(&format!(
        "workspace_id={workspace_id} target_cl={}",
        target_cl.as_deref().unwrap_or("none")
    ))
    .into_owned();
    // D-02 reuse-parent: the wrapper's scope_run sets RUN_ID once and the
    // pipeline inherits it via the inherited task_local across the .await.
    trace_command("start_sync", args_redacted, async move {
        if let Some(ref cl) = target_cl {
            p4_executor::validate_target_cl(cl).map_err(|e| e.to_string())?;
        }
        state
            .run_pipeline(workspace_id, target_cl, on_event, app)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn stop_sync(state: State<'_, Arc<ProcessManager>>) -> Result<(), String> {
    // No path-carrying args — only State. Empty args string, no redact needed.
    trace_command("stop_sync", String::new(), async move {
        state.stop_all().await.map_err(|e| e.to_string())
    })
    .await
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
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    // dry_run_sync (p4_executor) already emits step=dryRun via Plan 11-02's
    // StepScope; this wrapper adds the command-level cmd= bookend around the
    // whole invocation. RUN_ID set here is inherited by dry_run_sync.
    trace_command("check_sync_behind", args_redacted, async move {
        let ws = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;

        let options = SyncOptions {
            target_cl: None,
            parallel_threads: ws.parallel_threads,
            exclusions: ws.exclusions.clone(),
        };

        let (request_id, token) = state.begin_behind_check().await;
        let result = state.dry_run_sync(&ws, &options, token, None).await;
        state.finish_behind_check(request_id).await;
        let count = result.map_err(|e| e.to_string())?;

        Ok(P4BehindInfo { behind: count })
    })
    .await
}

#[tauri::command]
pub async fn cancel_sync_behind(state: State<'_, Arc<P4Executor>>) -> Result<(), String> {
    trace_command("cancel_sync_behind", String::new(), async move {
        state.cancel_behind_check().await;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_current_cl(
    app: AppHandle,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let args_redacted = crate::utils::redact::redact(&format!("workspace_id={workspace_id}"))
        .into_owned();
    trace_command("get_current_cl", args_redacted, async move {
        let workspace = WorkspaceService::get(&app, &workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(workspace.last_sync_cl)
    })
    .await
}

/// Returns whether a sync pipeline is currently running on the backend.
/// Used by the frontend to detect stale UI state when the WebView was
/// suspended (e.g. window minimized) and Channel events were lost.
#[tauri::command]
pub fn is_sync_running(state: State<'_, Arc<SyncOrchestrator>>) -> bool {
    // SYNC command (pub fn, not async) — uses trace_command_sync_ok (the sync,
    // non-Result variant). No path-carrying args (State only), no redact needed.
    trace_command_sync_ok("is_sync_running", String::new(), || {
        state.is_pipeline_running()
    })
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
    let args_redacted = crate::utils::redact::redact(&format!(
        "workspace_id={workspace_id} step={step} target_cl={}",
        target_cl.as_deref().unwrap_or("none")
    ))
    .into_owned();
    // D-02 reuse-parent site: retry_step → retry_step_inner. The wrapper's
    // scope_run sets RUN_ID; the inner inherits it.
    trace_command("retry_step", args_redacted, async move {
        if let Some(ref cl) = target_cl {
            p4_executor::validate_target_cl(cl).map_err(|e| e.to_string())?;
        }
        state
            .retry_step(workspace_id, step, target_cl, on_event, app)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn start_rollback(
    app: AppHandle,
    state: State<'_, Arc<SyncOrchestrator>>,
    workspace_id: String,
    target_cl: String,
    on_event: Channel<SyncEvent>,
) -> Result<(), String> {
    // target_cl is String (not Option) here — plain `{target_cl}` is safe.
    let args_redacted =
        crate::utils::redact::redact(&format!("workspace_id={workspace_id} target_cl={target_cl}"))
            .into_owned();
    // D-02 reuse-parent site: start_rollback → rollback_pipeline → _inner.
    trace_command("start_rollback", args_redacted, async move {
        state
            .rollback_pipeline(workspace_id, target_cl, on_event, app)
            .await
            .map_err(|e| e.to_string())
    })
    .await
}
