//! Logger plumbing foundation (Phase 9, D-01..D-03, D-06, D-07).
//!
//! Lifts the `tauri-plugin-log` Builder configuration out of the bare
//! `Builder::default().build()` at `lib.rs:26` (whose 40KB default cap and
//! default single-file rotation wiped pre-incident evidence in every open
//! debug brief) and replaces it with a purpose-built plugin:
//!
//! - file target at `%LOCALAPPDATA%\com.simpleugs.app\logs\p4-updater.log`
//!   carrying the uniform line layout `<ts> <LEVEL> <module>: [run=——] <msg>`
//!   with a reserved `[run=——]` slot (D-02) that Phase 11 swaps for the
//!   `task_local! RUN_ID`;
//! - `KeepSome(5)` + 5MB rotation (SC#4 mandate — 5 rotated + 1 active);
//! - global `Debug` level with D-06 noise filters (`hyper`/`reqwest`/`tao`/
//!   `wry`/`wgpu`) so transport/webview chatter does not bury business lines;
//! - dev-only `Stdout` target (D-07) gated by `#[cfg(debug_assertions)]`.
//!
//! Plan 02 consumes the helper by swapping the registration at `lib.rs:26`.

use std::fmt::Arguments;
use log::Record;
use tauri::{plugin::TauriPlugin, Runtime};
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};
use chrono::Local;

// Re-export so call sites can use `crate::utils::log::{info, warn, ...}`.
// Migration of the 43 existing `tauri_plugin_log::log::*` call sites to this
// path is implementer discretion (CONTEXT.md); the re-export itself is
// required to exist by end of Phase 9.
pub use log::{debug, info, warn, error, trace};

/// D-02 reservation glyph printed for every Phase 9 line in the `[run=...]`
/// slot. Phase 11 swaps this for `RUN_ID.try_with(|r| r.clone()).ok()`; the
/// line layout is unchanged.
const RUN_PLACEHOLDER: &str = "——";

/// Build the configured `tauri-plugin-log` plugin that replaces the bare
/// `Builder::default().build()` at `src-tauri/src/lib.rs:26`.
///
/// The formatter is attached to the FILE target only (per-target
/// `Target::format()`), NOT to `Builder::format()` — the dev-only stdout
/// target stays raw (D-07) and Phase 10's redaction drops in by swapping
/// `file_formatter` alone. Phase 11 swaps `RUN_PLACEHOLDER` for
/// `RUN_ID.try_with(...)` with zero line-layout change.
pub fn build_logger_plugin<R: Runtime>() -> TauriPlugin<R> {
    // D-01/D-02/D-03: file-target formatter owning the uniform line layout.
    // `FormatCallback` is re-exported by `tauri_plugin_log` (its `fern`
    // backend), so name it through that path rather than importing `fern`
    // directly (fern is only a transitive dep, not an explicit Cargo dep).
    let file_formatter = |out: tauri_plugin_log::fern::FormatCallback,
                          message: &Arguments,
                          record: &Record| {
        // D-03: millisecond-precision local timestamp.
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        // D-01: last `::`-segment of the module path (fallback to target).
        let module_full = record.module_path().unwrap_or(record.target());
        let module_short = module_full.rsplit("::").next().unwrap_or(module_full);
        // D-02: reserved `[run=——]` slot — unconditional in Phase 9.
        out.finish(format_args!(
            "{ts} {level} {module}: [run={run}] {msg}",
            ts = ts,
            level = record.level(),
            module = module_short,
            run = RUN_PLACEHOLDER,
            msg = message,
        ));
    };

    let file_target = Target::new(TargetKind::LogDir {
        file_name: Some("p4-updater".into()),
    })
    .format(file_formatter);

    // `mut` is only needed under `debug_assertions` for the stdout push below;
    // in release builds the push is cfg-gated out and rustc would otherwise
    // emit `unused_mut`. `#[allow(unused_mut)]` keeps both profiles warning-free
    // without restructuring the dev/release fork.
    #[allow(unused_mut)]
    let mut targets: Vec<Target> = vec![file_target];
    // D-07: dev-only raw stdout (no formatter) — release ships file-only.
    #[cfg(debug_assertions)]
    targets.push(Target::new(TargetKind::Stdout));

    Builder::new()
        .targets(targets)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .max_file_size(5_000_000)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(log::LevelFilter::Debug)
        // D-06: silence known-chatty transport/webview crates so business
        // lines stay readable at global Debug.
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Info)
        .level_for("wgpu", log::LevelFilter::Warn)
        .build()
}
