/// System locale detection for first-launch language initialization.

/// The `tauri-plugin-os` plugin already registers a `locale` command
/// (via `os:default` capability) that returns the OS BCP-47 locale tag.
/// This module provides a project-scoped alias `get_system_locale`
/// that delegates to the same underlying `sys_locale::get_locale()`.

/// We depend on `sys-locale` directly (a transitive dep of tauri-plugin-os)
/// to call the same function the plugin's built-in command calls.

use crate::services::tray_manager::apply_locale_to_tray;
use crate::utils::tray_locale::{AppLocale, Locale};
use sys_locale::get_locale as sys_get_locale;
use tauri::State;

#[tauri::command]
pub async fn get_system_locale() -> Option<String> {
    sys_get_locale()
}

/// Read the current Rust-side locale (WIRE-04 completeness/diagnostics;
/// no frontend consumer this phase — the webview boot gate keeps its own
/// store read per research Open Q3). Returns `Result` because Tauri
/// requires async commands taking `State<'_>` to return a Result.
#[tauri::command]
pub async fn get_locale(state: State<'_, AppLocale>) -> Result<String, String> {
    Ok(match state.get() {
        Locale::Zh => "zh".to_string(),
        Locale::En => "en".to_string(),
    })
}

/// Flip the Rust-side locale and relabel the tray live.
///
/// Validates against the closed set zh|en — any other value is a command
/// error, never a silent default (ASVS V5, threat T-18-01). Writes
/// `AppLocale` FIRST and relabels the tray SECOND: a `set_text`/
/// `set_tooltip` failure is logged inside `apply_locale_to_tray` and never
/// fails this command, never rolls back the locale state (research
/// Pitfall 5). This command NEVER writes or saves the plugin-store — the
/// frontend `localeSettings.saveLocale` is the sole persistence writer
/// (single-writer rule, research 2.3).
#[tauri::command]
pub async fn set_locale(
    app: tauri::AppHandle,
    state: State<'_, AppLocale>,
    locale: String,
) -> Result<(), String> {
    let parsed = match locale.as_str() {
        "zh" => Locale::Zh,
        "en" => Locale::En,
        _ => return Err(format!("invalid locale: {locale}")),
    };
    state.set(parsed);
    // Fire-and-forget main-thread relabel (see apply_locale_to_tray). Must not
    // block this tokio worker on Shell_NotifyIconW / explorer (G-18-6).
    apply_locale_to_tray(&app);
    Ok(())
}
