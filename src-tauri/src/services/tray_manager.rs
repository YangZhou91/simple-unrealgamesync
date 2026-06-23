use std::sync::Arc;

use crate::services::process_manager::ProcessManager;
use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager,
};
use tauri_plugin_notification::NotificationExt;

/// Deserialization mirror of the SyncStatePayload emitted by SyncOrchestrator.
#[derive(Clone, Deserialize)]
struct SyncStatePayload {
    state: String,
    detail: Option<String>,
}

pub fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // Create context menu items (per D-03)
    let show_item = MenuItem::with_id(&handle, "show", "Show Window", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;

    let menu = MenuBuilder::new(&handle)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // Load icon using include_bytes for compile-time embedding (per Research Open Question 2)
    let icon = Image::from_bytes(include_bytes!("../../icons/32x32.png"))
        .expect("failed to load tray icon");

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Simple UnrealGameSync - Idle") // D-02: initial tooltip
        .menu(&menu)
        .show_menu_on_left_click(false) // D-01: left-click toggles window, NOT opens menu (Pitfall 6)
        .on_menu_event(|app, event| {
            // Pitfall 5: filter by ID since on_menu_event receives ALL menu events
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    // TRAY-04: Quit kills all tracked processes then exits
                    let pm = app.state::<Arc<ProcessManager>>();
                    let pm = Arc::clone(pm.inner());
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = pm.kill_all_tracked().await;
                        app_clone.exit(0);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // D-01: left-click toggles window visibility
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    // Listen for sync-state events from SyncOrchestrator (D-07, D-08)
    let tray_for_listener = _tray.clone();
    let app_handle = app.handle().clone();
    app.listen("sync-state", move |event| {
        let payload = match serde_json::from_str::<SyncStatePayload>(event.payload()) {
            Ok(p) => p,
            Err(_) => return,
        };

        // D-07/D-08: update tooltip based on sync state
        let tooltip = match payload.state.as_str() {
            "syncing" => "Simple UnrealGameSync - Syncing...",
            "idle" => "Simple UnrealGameSync - Idle",
            "error" => "Simple UnrealGameSync - Error",
            _ => return,
        };
        let _ = tray_for_listener.set_tooltip(Some(tooltip));

        // D-04/D-05: fire notification only when window is hidden
        if payload.state == "idle" || payload.state == "error" {
            if let Some(window) = app_handle.get_webview_window("main") {
                // Default true: if we can't determine visibility, assume visible
                // and skip notification (safer than spamming)
                if !window.is_visible().unwrap_or(true) {
                    let body = payload
                        .detail
                        .unwrap_or_else(|| match payload.state.as_str() {
                            "idle" => "Sync completed".to_string(),
                            "error" => "Sync failed".to_string(),
                            _ => String::new(),
                        });
                    let _ = app_handle
                        .notification()
                        .builder()
                        .title("Simple UnrealGameSync")
                        .body(&body)
                        .show();
                }
            }
        }
    });

    Ok(())
}
