use std::sync::Arc;

use crate::services::process_manager::ProcessManager;
use crate::utils::tray_locale::{
    collapse_system_locale, compose_completed, compose_failed, tr, tooltip_key_for_state,
    AppLocale, Locale, TrayKey, APP_TITLE,
};
use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager,
};
use tauri_plugin_notification::NotificationExt;

/// Deserialization mirror of the SyncStatePayload emitted by SyncOrchestrator.
/// Structured machine fields only (WIRE-03) — the tray composes localized
/// bodies at fire time; the orchestrator never sends display prose. Must
/// stay in lockstep with the Serialize struct in sync_orchestrator.rs
/// (same field names, same types); the serde-shape test in that file pins
/// the wire contract both mirrors must match.
#[derive(Clone, Deserialize)]
struct SyncStatePayload {
    state: String,
    step: Option<String>,
    error: Option<String>,
    files_synced: Option<u64>,
    cl: Option<String>,
}

/// Retained handles for live tray relabeling (TRAY-02). The `MenuItem`
/// clones point at the SAME native items built in `setup_tray` —
/// `set_text` through a clone relabels the one menu, ids "show"/"quit"
/// and event routing stay untouched.
pub struct TrayHandles<R: tauri::Runtime> {
    pub show: MenuItem<R>,
    pub quit: MenuItem<R>,
    /// Last sync-state tooltip key seen by the listener (default: idle).
    /// `apply_locale_to_tray` recomposes the tooltip from this state, NOT
    /// a reset to idle — switching mid-sync yields the syncing string
    /// (UI-SPEC interaction contract item 3).
    pub last_tooltip_state: std::sync::Mutex<TrayKey>,
}

/// Resolve the boot locale from the `.settings` store key `app.locale`,
/// falling through to system detection (I18N-04 collapse) on absent/invalid
/// values or ANY store error. Fully non-fatal — first run has no
/// `.settings` file and boot must never fail (threat T-18-03 / research
/// Pitfall 9). No `?` operator on this path.
fn resolve_boot_locale(app: &tauri::AppHandle) -> Locale {
    use tauri_plugin_store::StoreExt as _;
    let stored: Option<String> = app
        .store(".settings")
        .ok()
        .and_then(|s| s.get("app.locale"))
        .and_then(|v| v.as_str().map(String::from));
    match stored.as_deref() {
        Some("zh") => Locale::Zh,
        Some("en") => Locale::En,
        _ => collapse_system_locale(sys_locale::get_locale().as_deref()),
    }
}

/// Relabel both tray menu items and recompose the tooltip from the LAST
/// KNOWN sync state, in the CURRENT `AppLocale` (read here, never cached).
///
/// Called by `commands::locale::set_locale` AFTER `AppLocale` is written.
/// Every failure is `log::warn!` + continue — a failed swap must degrade,
/// never fail the command (research Pitfall 5).
///
/// Threading (G-18-6): this is invoked from the async `set_locale` command
/// (a tokio worker). Tauri's `MenuItem::set_text` / `TrayIcon::set_tooltip`
/// wrappers hop to the main thread and **block** on `rx.recv()`. The posted
/// Task runs inside the tao wndproc; `set_tooltip` then calls
/// `Shell_NotifyIconW(NIM_MODIFY)`, which can deadlock with explorer.exe
/// (cross-process SendMessage) and freeze the window. Schedule ONE
/// fire-and-forget `run_on_main_thread` closure instead: `run_on_main_thread`
/// itself does not wait (PostMessage), the command returns immediately, and
/// once the Task is on the main thread the wrappers run inline (no extra
/// blocking hops).
pub fn apply_locale_to_tray(app: &tauri::AppHandle) {
    let app_for_task = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        relabel_tray_on_main(&app_for_task);
    }) {
        log::warn!("apply_locale_to_tray: run_on_main_thread failed: {e}");
    }
}

fn relabel_tray_on_main(app: &tauri::AppHandle) {
    let locale = app
        .try_state::<AppLocale>()
        .map(|s| s.get())
        .unwrap_or_else(|| collapse_system_locale(sys_locale::get_locale().as_deref()));

    if let Some(h) = app.try_state::<TrayHandles<tauri::Wry>>() {
        if let Err(e) = h.show.set_text(tr(locale, TrayKey::ShowWindow)) {
            log::warn!("tray show set_text failed: {e}");
        }
        if let Err(e) = h.quit.set_text(tr(locale, TrayKey::Quit)) {
            log::warn!("tray quit set_text failed: {e}");
        }
    } else {
        // Defensive: TrayHandles is managed in setup_tray before any
        // command can fire; skipping silently if unmanaged.
        log::warn!("apply_locale_to_tray: TrayHandles not managed, skipping menu relabel");
    }

    if let Some(tray) = app.tray_by_id("main") {
        let key = app
            .try_state::<TrayHandles<tauri::Wry>>()
            .map(|h| {
                *h.last_tooltip_state
                    .lock()
                    .expect("tooltip state lock poisoned")
            })
            .unwrap_or(TrayKey::TooltipIdle);
        if let Err(e) = tray.set_tooltip(Some(tr(locale, key))) {
            log::warn!("tray set_tooltip failed: {e}");
        }
    }
}

pub fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // Resolve the boot locale BEFORE building any menu item, then manage
    // AppLocale (WIRE-04): the store read falls through to system
    // detection and can never fail the boot path.
    let locale = resolve_boot_locale(&handle);
    app.manage(AppLocale::new(locale));

    // Create context menu items (per D-03) with localized labels
    let show_item = MenuItem::with_id(
        &handle,
        "show",
        tr(locale, TrayKey::ShowWindow),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(&handle, "quit", tr(locale, TrayKey::Quit), true, None::<&str>)?;

    let menu = MenuBuilder::new(&handle)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // Retain cloned handles for live relabeling (TRAY-02) — the clones
    // point at the same native items wired into the menu above.
    app.manage(TrayHandles {
        show: show_item.clone(),
        quit: quit_item.clone(),
        last_tooltip_state: std::sync::Mutex::new(TrayKey::TooltipIdle),
    });

    // Load icon using include_bytes for compile-time embedding (per Research Open Question 2)
    let icon = Image::from_bytes(include_bytes!("../../icons/32x32.png"))
        .expect("failed to load tray icon");

    let _tray = TrayIconBuilder::with_id("main") // addressable via app.tray_by_id("main") for tooltip relabel/diagnostics
        .icon(icon)
        .tooltip(tr(locale, TrayKey::TooltipIdle)) // D-02: initial tooltip (localized idle)
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

        // D-07/D-08: update tooltip based on sync state — mapped through
        // the template table; the locale is read at EVENT time, never
        // cached. Unrecognized states return early.
        let Some(key) = tooltip_key_for_state(&payload.state) else {
            return;
        };
        let locale = app_handle
            .try_state::<AppLocale>()
            .map(|s| s.get())
            .unwrap_or(Locale::En);
        if let Some(h) = app_handle.try_state::<TrayHandles<tauri::Wry>>() {
            *h.last_tooltip_state
                .lock()
                .expect("tooltip state lock poisoned") = key;
        }
        let _ = tray_for_listener.set_tooltip(Some(tr(locale, key)));

        // D-04/D-05: fire notification only when window is hidden.
        // TRAY-01: the body composes HERE from the template table +
        // structured machine fields, in the language AppLocale held at
        // fire time (read above, never cached) — correct even when the
        // window is hidden mid-sync and the webview is stale. The raw
        // p4/git error rides untranslated after a localized prefix
        // (BND-01); the step token renders verbatim (never a Rust-side
        // step-label dictionary — Phase 19 owns labels). Unrecognized
        // states return before the notification call.
        let body = match payload.state.as_str() {
            "completed" => compose_completed(
                locale,
                payload.files_synced.unwrap_or(0),
                payload.cl.as_deref(),
            ),
            "error" => compose_failed(
                locale,
                payload.step.as_deref().unwrap_or(""),
                payload.error.as_deref().unwrap_or(""),
            ),
            "cancelled" => tr(locale, TrayKey::NotifyCancelled),
            _ => return,
        };
        if let Some(window) = app_handle.get_webview_window("main") {
            // Default true: if we can't determine visibility, assume visible
            // and skip notification (safer than spamming)
            if !window.is_visible().unwrap_or(true) {
                let _ = app_handle
                    .notification()
                    .builder()
                    .title(APP_TITLE)
                    .body(&body)
                    .show();
            }
        }
    });

    Ok(())
}
