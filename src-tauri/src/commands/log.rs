//! Operator-facing log affordance commands (Phase 12, HOTUI-14 / D-06..D-08).
//!
//! The three commands here deliver the v1.4 milestone's operator exit: a
//! freeze/stuck brief can be assembled from a release build in <=2 clicks via
//! "Open logs folder" (D-07 — direct `explorer.exe` spawn at the runtime log
//! dir) and "Export log" (D-08 — native save dialog -> Rust-side `fs::copy`).
//! `get_log_path` returns the absolute path string for the Settings display.
//!
//! All three are `#[tauri::command]` wrappers around a body enclosed by the
//! Phase 11 `trace_command` bookend so every invocation emits
//! `cmd=<name> starting args=` + `cmd=<name> ok|err elapsed=<ms>ms` with a
//! `[run=<id>]` slot (D-15 there). The three commands take NO path-carrying
//! args — the log path is resolved Rust-side via `app.path().app_log_dir()`
//! (the platform's LogDir that `tauri-plugin-log`'s `TargetKind::LogDir` writes
//! to). No OS env-folder literal is hardcoded; the runtime resolver is
//! load-bearing (the header comment in `utils/log.rs:8` cites a specific folder
//! and is NOT trusted here).
//!
//! Trust boundaries (see 12-03-PLAN.md `<threat_model>`):
//! - explorer arg vector is NEVER logged as a Phase 11 business-process
//!   lifecycle line (D-07 — it is an OS call, NOT a spawned-process event);
//!   the `trace_command` bookend is the only emitted log line.
//! - `fs::copy` of the live rotating log is a COPY, never move/truncate; a
//!   mid-write snapshot may carry a partial last line (D-08 accept).
//! - the save-dialog destination is OS-picked (`tauri_plugin_dialog`), not
//!   user-supplied text — no untrusted input crosses the boundary.

use crate::utils::log::trace_command;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

// Windows process trait — needed for `creation_flags` (CREATE_NO_WINDOW) and
// `raw_arg` (passing the `/select,<path>` form verbatim). Mirrors the pattern
// at `services/git_service.rs:15` / `services/p4_executor.rs:17`.
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt as _;

/// Windows CREATE_NO_WINDOW flag — same value the existing p4/git spawns use
/// (see `services/p4_executor.rs:18`, `services/git_service.rs:18`). Prevents
/// a console window flashing for the `explorer` spawn.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// The on-disk log file name produced by `build_logger_plugin`
/// (`utils/log.rs:452` — `TargetKind::LogDir { file_name: Some("simple-unrealgamesync".into()) }`).
/// The plugin appends the `.log` extension automatically.
const LOG_FILE_NAME: &str = "simple-unrealgamesync.log";

/// Resolve the current log file path at runtime via the platform `LogDir`.
///
/// Uses `app.path().app_log_dir()` — the same resolver
/// `tauri-plugin-log`'s `TargetKind::LogDir` writes into — so the returned
/// path is the REAL directory the live log occupies (Windows resolves under
/// the bundle id from `tauri.conf.json:5`). The stale folder-name uncertainty
/// in the `utils/log.rs:8` header comment is sidestepped by asking Tauri's
/// runtime resolver, not by trusting the comment.
fn current_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map(|dir| dir.join(LOG_FILE_NAME))
        .map_err(|e| e.to_string())
}

/// Convert a `Path` to an owned UTF-8 `String` for the JS-facing return values.
fn path_to_string(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "log path is not valid UTF-8".to_string())
}

/// `get_log_path` — return the absolute current log file path as a `String`
/// (for the Settings display). No args; the path is resolved Rust-side.
#[tauri::command]
pub async fn get_log_path(app: AppHandle) -> Result<String, String> {
    trace_command("get_log_path", String::new(), async move {
        let p = current_log_path(&app)?;
        path_to_string(&p)
    })
    .await
}

/// `open_logs_folder` — spawn `explorer.exe /select,<log_path>` at the runtime
/// log dir (D-07 direct OS spawn, NOT `tauri-plugin-shell`). Explorer opens
/// with the current log file pre-selected (more useful to the operator than
/// a bare folder open). The explorer arg vector is NEVER logged as a Phase 11
/// business-process lifecycle event — only the `trace_command`
/// `cmd=open_logs_folder` bookend fires (D-07 / T-12-LOG-1 mitigation). The
/// spawn is detached (`.spawn()`, child handle dropped) so a broken/missing
/// explorer returns an `Err` the JS surfaces as a message; it does not block
/// the command (T-12-LOG-5 mitigation).
#[tauri::command]
pub async fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    trace_command("open_logs_folder", String::new(), async move {
        let log_path = current_log_path(&app)?;
        // Pre-select the log file in Explorer (more useful than a bare folder
        // open). `/select,<file>` is the documented explorer.exe verb.
        spawn_explorer_select(&log_path)?;
        Ok(())
    })
    .await
}

/// `export_log` — open a native save dialog and Rust-side `tokio::fs::copy` the
/// current log file to the operator-chosen destination (D-08). A COPY, never
/// move/truncate — the live log keeps rotating normally. Returns the chosen
/// destination path as a `String` (for the JS display). Operator-cancel
/// (dialog dismissed) yields `Err("cancelled")`; the JS side treats that as a
/// no-op, not an error toast.
///
/// The save dialog uses `blocking_save_file()` from `tauri_plugin_dialog`
/// (v2.7.x). `blocking_*` is the correct API inside an async `#[tauri::command]`
/// — the non-blocking `save_file(F)` variant is for the main thread (it would
/// deadlock an async command). The blocking variant spawns the dialog off the
/// main thread via the plugin's `blocking_fn!` macro (verified dialog-2.7.1
/// `src/lib.rs:71-80`).
#[tauri::command]
pub async fn export_log(app: AppHandle) -> Result<String, String> {
    trace_command("export_log", String::new(), async move {
        let src = current_log_path(&app)?;
        let chosen = app
            .dialog()
            .file()
            .add_filter("Log files", &["log"])
            .set_file_name(LOG_FILE_NAME)
            .blocking_save_file();
        let chosen_path = match chosen {
            Some(p) => p.into_path().map_err(|e| e.to_string())?,
            None => return Err("cancelled".to_string()),
        };
        // D-08: COPY, never move/truncate. The live rotating log may yield a
        // partial last line in the snapshot — accepted per the threat register
        // (T-12-LOG-3). The source file is NOT modified.
        tokio::fs::copy(&src, &chosen_path)
            .await
            .map_err(|e| e.to_string())?;
        path_to_string(&chosen_path)
    })
    .await
}

/// Spawn `explorer.exe /select,<path>` with `CREATE_NO_WINDOW` on Windows so
/// no console window flashes. Discards the detached child handle (Explorer
/// outlives the spawn). Uses `std::process::Command` (not `tokio::process`)
/// because the spawn is fire-and-forget — we never read the child's output and
/// never `.await` it; the blocking `spawn()` itself returns once the OS has
/// launched the process.
fn spawn_explorer_select(log_path: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer");
    // `/select,<file>` opens Explorer with <file> highlighted. raw_arg keeps
    // the comma form intact (plain `.arg` would also work on Windows, but
    // raw_arg avoids any future arg-splitting surprise on the comma).
    let select = format!("/select,{}", log_path.display());
    cmd.raw_arg(select);
    apply_no_window(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply the Windows `CREATE_NO_WINDOW` creation flag. No-op on non-Windows
/// (the app is Windows-only per CLAUDE.md, but the cfg keeps the file portable
/// for `cargo check` on other targets during cross-machine review).
#[cfg(target_os = "windows")]
fn apply_no_window(cmd: &mut std::process::Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(target_os = "windows"))]
fn apply_no_window(_cmd: &mut std::process::Command) {}
