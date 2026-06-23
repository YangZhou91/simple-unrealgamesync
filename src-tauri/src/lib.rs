pub mod commands;
pub mod error;
pub mod models;
pub mod services;
pub mod utils;

use services::git_service::GitService;
use services::p4_executor::P4Executor;
use services::process_manager::ProcessManager;
use services::sync_orchestrator::SyncOrchestrator;
use services::tray_manager;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let process_manager = Arc::new(ProcessManager::new());
    let sync_orchestrator = Arc::new(SyncOrchestrator::new(process_manager.clone()));
    let p4_executor = Arc::new(P4Executor::new());
    let git_service = Arc::new(GitService::new(process_manager.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(sync_orchestrator)
        .manage(process_manager)
        .manage(p4_executor)
        .manage(git_service)
        .invoke_handler(tauri::generate_handler![
            commands::workspace::add_workspace,
            commands::workspace::get_workspaces,
            commands::workspace::delete_workspace,
            commands::workspace::switch_workspace,
            commands::workspace::update_workspace_settings,
            commands::workspace::validate_exclusions,
            commands::sync::start_sync,
            commands::sync::stop_sync,
            commands::sync::check_sync_behind,
            commands::sync::cancel_sync_behind,
            commands::sync::get_current_cl,
            commands::sync::is_sync_running,
            commands::sync::retry_step,
            commands::sync::start_rollback,
            commands::history::get_history,
            commands::history::get_changelists,
            commands::git::git_pull,
            commands::git::git_status,
            commands::git::stop_git_pull,
        ])
        .setup(|app| {
            tray_manager::setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // D-06: hide to tray, no confirmation dialog (TRAY-01)
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
