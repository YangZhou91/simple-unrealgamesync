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
    // D-05: force RUST_BACKTRACE=1 in release BEFORE any panic can fire so
    // `Backtrace::force_capture()` always yields symbolized frames (not bare
    // addresses). Runs first — before the hook is installed (Pitfall 3) and
    // before any subsequent code in `run()` can panic.
    #[cfg(not(debug_assertions))]
    std::env::set_var("RUST_BACKTRACE", "1");

    // D-04: panic hook routing the panic location/message plus a captured
    // backtrace through `log::error!`. Under release the default
    // `windows_subsystem = "windows"` (main.rs) eats stderr/stdout, so
    // without this hook a panic leaves zero evidence on disk. RESEARCH.md
    // Pitfall 4: `log::error!` no-ops cleanly on the default no-op logger
    // when the hook fires before the plugin attaches — it does NOT panic.
    // The log::error! call below uses the literal prefix the VALIDATION.md
    // SC#2 manual check greps for in the emitted log file.
    std::panic::set_hook(Box::new(|info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("<non-string panic payload>");
        let bt = std::backtrace::Backtrace::force_capture();
        log::error!("PANIC at {loc}: {msg}\n{bt}");
    }));

    let process_manager = Arc::new(ProcessManager::new());
    let sync_orchestrator = Arc::new(SyncOrchestrator::new(process_manager.clone()));
    let p4_executor = Arc::new(P4Executor::new());
    let git_service = Arc::new(GitService::new(process_manager.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(utils::log::build_logger_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_os::init())
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
            commands::sync::check_workspace_health,
            commands::sync::get_current_cl,
            commands::sync::get_workspace_stream,
            commands::sync::is_sync_running,
            commands::sync::retry_step,
            commands::sync::start_rollback,
            commands::history::get_history,
            commands::history::get_changelists,
            commands::git::git_pull,
            commands::git::git_status,
            commands::git::stop_git_pull,
            commands::log::open_logs_folder,
            commands::log::export_log,
            commands::log::get_log_path,
            commands::locale::get_system_locale,
            commands::locale::get_locale,
            commands::locale::set_locale,
        ])
        .setup(|app| {
            tray_manager::setup_tray(app)?;

            // LAUNCH-02: login autostart registers `--minimized` on the HKCU Run
            // command. Hide the main window only when that exact token is present
            // so a normal (user-clicked) launch still opens focused. Tray must
            // already exist so the hidden window still has a Show/Quit surface.
            if std::env::args().any(|arg| arg == "--minimized") {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // Best-effort, non-blocking: prune sync history older than
            // HISTORY_RETENTION_DAYS (30) across ALL history_* keys on launch so the
            // 90->30 reduction clears existing backlog immediately (not just on the
            // next sync). Spawned off the launch critical path — never blocks startup,
            // and prune_all_at_startup swallows its own errors. See quick-260729-pd3.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) =
                    services::history::HistoryService::prune_all_at_startup(&app_handle).await
                {
                    log::warn!("startup history sweep failed: {e}");
                }
            });

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
