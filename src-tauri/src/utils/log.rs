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

/// D-01: reduce a full Rust module path to its last `::`-segment.
///
/// Given e.g. `"simple_unrealgamesync_lib::services::sync_orchestrator"` this
/// returns `"sync_orchestrator"`. A path with no `::` (a bare crate name or a
/// `target()` fallback like `"simple_unrealgamesync_lib"`) is returned
/// unchanged — this is the `unwrap_or` fallback branch, exercised by the
/// single-segment case. Zero-alloc: the returned slice borrows from the input.
fn module_short(module_full: &str) -> &str {
    module_full.rsplit("::").next().unwrap_or(module_full)
}

/// D-02: assemble the non-timestamp portion of a file-target log line.
///
/// Produces `"<LEVEL> <module>: [run=<run>] <msg>"` — the line body that, when
/// prefixed with the D-03 millisecond timestamp and a single space, yields the
/// uniform `<ts> <LEVEL> <module>: [run=——] <msg>` layout every Phase 9 file
/// line carries. The `[run=<run>]` slot is reserved unconditionally (Phase 9
/// passes `RUN_PLACEHOLDER`; Phase 11 swaps the literal for `RUN_ID` with zero
/// layout change). Extracted from the formatter closure so the line-layout
/// contract has `cargo test` coverage; the closure layers the timestamp on top.
///
/// `msg` is generic over `Display` so the closure can pass the fern
/// `&Arguments` it receives directly (no `to_string()` coercion) while tests
/// can pass a plain `&str`. The assembled body is byte-identical to the
/// original inline `format_args!`; the one `String` this allocates is the
/// unavoidable cost of a pure, testable seam — negligible next to the file
/// I/O every emitted line precedes.
fn format_line_body<M: std::fmt::Display>(
    module: &str,
    level: log::Level,
    run: &str,
    msg: M,
) -> String {
    format!("{level} {module}: [run={run}] {msg}")
}

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
        let module = module_short(module_full);
        // D-02: reserved `[run=——]` slot — unconditional in Phase 9.
        //
        // The body is assembled by `format_line_body` (a pure, timestamp-free
        // helper) so the D-01/D-02 line-layout contract has `cargo test`
        // coverage; the timestamp is layered on here because it is inherently
        // non-deterministic and cannot be asserted against a fixed expected
        // value. `{ts} {body}` is byte-identical to inlining the four body
        // fields directly into this `format_args!`.
        let body = format_line_body(module, record.level(), RUN_PLACEHOLDER, message);
        out.finish(format_args!("{ts} {body}", ts = ts, body = body));
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
        // `timezone_strategy` (and `Builder::new`) OVERWRITE `dispatch.format`
        // with a global `{ts}[{level}][{target}] {msg}` formatter that pre-formats
        // every record BEFORE our per-target `file_formatter` runs — yielding a
        // doubly-formatted line (D-01 violation, ~75 chars of redundant nested
        // prefix per line). `clear_format` resets the global format to passthrough
        // `{message}` so only `file_formatter` owns the line layout. It MUST run
        // AFTER `timezone_strategy` (later `.format(...)` setter wins); the call
        // itself stays because `acquire_logger` passes `timezone_strategy` to the
        // `RotatingFile` for dated rotation filenames.
        .clear_format()
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

#[cfg(test)]
mod tests {
    use super::*;

    // ---- D-01: module_short ----

    #[test]
    fn module_short_returns_last_segment_of_multi_segment_path() {
        // Real Phase 9/11 module path shape: <crate>::<mod>::...::<leaf>.
        let got = module_short("simple_unrealgamesync_lib::services::sync_orchestrator");
        assert_eq!(got, "sync_orchestrator");
    }

    #[test]
    fn module_short_returns_input_unchanged_when_no_double_colon() {
        // The `unwrap_or` fallback branch: a bare crate name (e.g. the
        // `target()` fallback used when `module_path()` is None) has no `::`,
        // so the whole input must survive verbatim. This pins the SC#2
        // evidence line shape `ERROR simple_unrealgamesync_lib: [run=——] ...`
        // where `module_path()` was absent and `target()` was the crate name.
        let got = module_short("simple_unrealgamesync_lib");
        assert_eq!(got, "simple_unrealgamesync_lib");
    }

    #[test]
    fn module_short_returns_leaf_for_short_two_segment_path() {
        let got = module_short("crate::utils::log");
        assert_eq!(got, "log");
    }

    #[test]
    fn module_short_is_zero_alloc_subslice_of_input() {
        // The returned slice must borrow from the input (no allocation), so it
        // is a sub-slice of the original bytes — the pointer range lies within
        // the input's span.
        let input = "a::b::c";
        let got = module_short(input);
        let input_start = input.as_ptr() as usize;
        let input_end = input_start + input.len();
        let got_start = got.as_ptr() as usize;
        assert!(
            got_start >= input_start && got_start + got.len() <= input_end,
            "module_short must return a sub-slice of the input, not an owned copy"
        );
        assert_eq!(got, "c");
    }

    // ---- D-02: format_line_body (line layout + [run=——] slot) ----

    #[test]
    fn format_line_body_assembles_info_line_with_reserved_run_slot() {
        // Pins the full D-02 body layout — `{level} {module}: [run={run}] {msg}`
        // — including the `——` reservation glyph. Matches the shape documented
        // in 09-HUMAN-UAT.md SC#1 and the SC#2 evidence line body
        // `ERROR simple_unrealgamesync_lib: [run=——] PANIC at ...`
        // (modulo level text).
        let got = format_line_body("sync_orchestrator", log::Level::Info, "——", "[sync] step=p4Sync starting");
        assert_eq!(got, "INFO sync_orchestrator: [run=——] [sync] step=p4Sync starting");
    }

    #[test]
    fn format_line_body_assembles_error_line_matching_sc2_evidence_body() {
        // Reproduces the non-timestamp body of the SC#2 release-evidence line:
        //   `2026-06-27 10:59:04.194 ERROR simple_unrealgamesync_lib: [run=——] PANIC at src\lib.rs:86:13: phase9-verify`
        // (timestamp omitted — non-deterministic). This is the line Phase 10
        // redaction and Phase 11 RUN_ID depend on remaining byte-stable.
        let got = format_line_body(
            "simple_unrealgamesync_lib",
            log::Level::Error,
            "——",
            "PANIC at src\\lib.rs:86:13: phase9-verify",
        );
        assert_eq!(
            got,
            "ERROR simple_unrealgamesync_lib: [run=——] PANIC at src\\lib.rs:86:13: phase9-verify"
        );
    }

    #[test]
    fn format_line_body_preserves_colon_after_module_and_bracket_slot_ordering() {
        // Regression guard for the two easy-to-break layout tokens: the `: `
        // immediately after `<module>` (before `[run=`), and the ordering
        // `[run=<run>] <msg>` (slot before message, not after). A dropped colon
        // or swapped order would compile clean and pass every grep.
        let got = format_line_body("m", log::Level::Warn, "R-42", "hello");
        assert_eq!(got, "WARN m: [run=R-42] hello");
    }

    #[test]
    fn format_line_body_levels_render_uppercase_canonical_names() {
        // `log::Level`'s Display impl emits uppercase canonical names
        // (ERROR/WARN/INFO/DEBUG/TRACE). The D-01 line layout pins uppercase;
        // a future change to a lowercase level representation would silently
        // break log-scraping tooling that expects `<LEVEL>`.
        assert_eq!(
            format_line_body("m", log::Level::Error, "——", "x"),
            "ERROR m: [run=——] x"
        );
        assert_eq!(
            format_line_body("m", log::Level::Warn, "——", "x"),
            "WARN m: [run=——] x"
        );
        assert_eq!(
            format_line_body("m", log::Level::Debug, "——", "x"),
            "DEBUG m: [run=——] x"
        );
        assert_eq!(
            format_line_body("m", log::Level::Trace, "——", "x"),
            "TRACE m: [run=——] x"
        );
    }
}
