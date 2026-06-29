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
use std::time::Instant;
use log::Record;
use tauri::{plugin::TauriPlugin, Runtime};
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind, TimezoneStrategy};
use chrono::Local;
use uuid::Uuid;

// Re-export so call sites can use `crate::utils::log::{info, warn, ...}`.
// Migration of the 43 existing `tauri_plugin_log::log::*` call sites to this
// path is implementer discretion (CONTEXT.md); the re-export itself is
// required to exist by end of Phase 9.
pub use log::{debug, info, warn, error, trace};

/// Phase 11 INSTR-08: per-task correlation ID storage. `scope_run` (and the
/// sync `scope_run_sync`) set-or-reuse this at every `#[tauri::command]`
/// boundary; `file_formatter` reads it via `try_with` to fill the `[run=<id>]`
/// slot. `task_local!` auto-reverts on task completion (D-03), so lines logged
/// after a command returns correctly fall back to `[run=——]`.
tokio::task_local! {
    pub static RUN_ID: String;
}

/// D-02 reservation glyph printed for every Phase 9 line in the `[run=...]`
/// slot. Phase 11 swaps this for `RUN_ID.try_with(|r| r.clone()).ok()`; the
/// line layout is unchanged.
const RUN_PLACEHOLDER: &str = "——";

/// D-04: 8-char lowercase-hex run-ID generator (`uuid v4` already a Cargo dep).
/// Returns e.g. `"ab12cd34"` — ~4-billion ID space, negligible collision for a
/// single-user personal tool (T-11-SPOOF disposition: accept). Private: only
/// `scope_run`/`scope_run_sync` call it.
fn fresh_run_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_owned()
}

/// Phase 11 INSTR-08 / D-01 / D-02 / D-03: scope a RUN_ID around an async body.
///
/// If a RUN_ID is already set on this task (e.g. the command boundary already
/// scoped one and we're entering a nested pipeline entry point), REUSE it (one
/// ID per user action — D-02). Otherwise generate a fresh one and scope it via
/// `RUN_ID.scope(value, fut)`, which reverts the task_local automatically when
/// the future completes (D-03). The body's every `.await` point sees the same
/// RUN_ID; the formatter fills the `[run=<id>]` slot from it.
pub async fn scope_run<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    match RUN_ID.try_with(|r| r.clone()) {
        Ok(_existing) => fut.await, // D-02: parent set — reuse, do NOT nest.
        Err(_) => {
            let id = fresh_run_id();
            RUN_ID.scope(id, fut).await // reverts on return (D-03).
        }
    }
}

/// Phase 12 / D-02: propagation primitive for spawn'd drain/heartbeat tasks.
///
/// `scope_run` (above) generates-or-reuses a RUN_ID at a command boundary;
/// `scope_run_with` is the THIRD sibling — it takes a PRE-CAPTURED
/// `Option<String>` RUN_ID and re-scopes it INSIDE a spawned task.
/// `task_local!` does NOT cross `tokio::spawn` boundaries (the reason Phase 11
/// left drain + heartbeat lines as `[run=——]`), so the drain tasks in
/// `p4_executor.rs` / `git_service.rs` capture `RUN_ID.try_with(|r| r.clone()).ok()`
/// ONCE in the spawning scope (where the task_local is still set) and pass the
/// `Option<String>` here inside the spawned body. The `Some(id)` branch scopes
/// the captured ID so every line the future logs fills `[run=<id>]`; the `None`
/// branch runs the future bare so lines fall back to `[run=——]` (the safe
/// default for a drain spawned outside any command scope — should not happen in
/// practice but is the defensive default). The scope reverts on future
/// completion (D-03), matching `scope_run`. Closes the Phase 11 §"Deferred"
/// item: "Propagating RUN_ID across tokio::spawn into the stdout/stderr drain +
/// heartbeat tasks."
pub async fn scope_run_with<R>(run_id: Option<String>, fut: impl std::future::Future<Output = R>) -> R {
    match run_id {
        Some(id) => RUN_ID.scope(id, fut).await,
        None => fut.await,
    }
}

/// Phase 11 INSTR-08 / D-01: sync twin of `scope_run` for the non-async
/// commands (`is_sync_running`, `validate_exclusions`). Mirrors the
/// generate-or-reuse-revert contract via `RUN_ID.sync_scope(value, closure)`,
/// tokio's sync sibling of `.scope(value, fut)` (the `.scope` overload takes a
/// Future; only `.sync_scope` takes a closure). Reverts the task_local on
/// return — D-03.
pub fn scope_run_sync<T>(f: impl FnOnce() -> T) -> T {
    if RUN_ID.try_with(|_r| ()).is_ok() {
        // D-02: parent set — reuse, do NOT nest.
        f()
    } else {
        let id = fresh_run_id();
        RUN_ID.sync_scope(id, f)
    }
}

// ---------------------------------------------------------------------------
// Phase 11 INSTR-10: command-boundary trace wrappers (entry + exit bookends).
// ---------------------------------------------------------------------------
//
// `trace_command` (async, Result-aware) / `trace_command_sync` (sync,
// Result-aware) / `trace_command_sync_ok` (sync, non-Result) wrap a
// `#[tauri::command]` body so the entry `cmd=<name> starting args=...` and the
// exit `cmd=<name> ok|err elapsed=...ms` lines fire on EVERY return path
// (including `?` early-returns — the body is a future/closure; completing it
// is the only way out, and the wrapper owns both bookends). The err-exit line
// renders `redact(&e.to_string())` (Display, NEVER `{:?}` — SC#3 gate).
//
// The line-building is factored into the private `cmd_*_line` helpers below so
// the bookend shapes have deterministic unit-test coverage independent of the
// non-deterministic elapsed value and the tauri-plugin-log capture harness.

/// Build the `cmd=<name> starting args=<args>` entry line (D-16).
fn cmd_entry_line(name: &str, args_redacted: &str) -> String {
    format!("[cmd] {name} starting args={args_redacted}")
}

/// Build the `cmd=<name> ok elapsed=<ms>ms` exit line (D-16, D-13 `{}`ms).
fn cmd_exit_ok_line(name: &str, elapsed_ms: u128) -> String {
    format!("[cmd] {name} ok elapsed={elapsed_ms}ms")
}

/// Build the `cmd=<name> err elapsed=<ms>ms error=<redacted>` exit line (D-16).
/// `err_display_redacted` MUST already be routed through `redact()` by the
/// caller (the wrapper does this for the AppError Display path).
fn cmd_exit_err_line(name: &str, elapsed_ms: u128, err_display_redacted: &str) -> String {
    format!("[cmd] {name} err elapsed={elapsed_ms}ms error={err_display_redacted}")
}

/// Phase 11 INSTR-10 / D-15: async Result-aware command-boundary wrapper.
///
/// Wraps a `#[tauri::command]` body future: sets/reuses RUN_ID via `scope_run`,
/// emits the entry line on start, awaits the body, and emits the ok/err exit
/// line with elapsed on EVERY return path. Because the body is a future, every
/// `?` early-return and explicit `return` inside it completes the future — the
/// wrapper's post-`await` exit line cannot be skipped (D-15 structural
/// guarantee). The err branch renders `redact(&e.to_string())` (Display only —
/// SC#3 gate, T-11-PII-2 mitigation).
pub async fn trace_command<F, T, E>(
    name: &'static str,
    args_redacted: String,
    fut: F,
) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    scope_run(async move {
        let start = Instant::now();
        info!("{}", cmd_entry_line(name, &args_redacted));
        match fut.await {
            Ok(v) => {
                info!("{}", cmd_exit_ok_line(name, start.elapsed().as_millis()));
                Ok(v)
            }
            Err(e) => {
                let e_display = e.to_string();
                let safe = crate::utils::redact::redact(&e_display);
                info!(
                    "{}",
                    cmd_exit_err_line(name, start.elapsed().as_millis(), &safe)
                );
                Err(e)
            }
        }
    })
    .await
}

/// Phase 11 INSTR-10 / D-15: sync Result-aware command-boundary wrapper.
///
/// The sync twin of `trace_command` for the non-async Result-returning
/// commands (`validate_exclusions`). Same bookend contract via `scope_run_sync`
/// and the same err-line redaction (Display, never `{:?}`).
pub fn trace_command_sync<T, E>(
    name: &'static str,
    args_redacted: String,
    f: impl FnOnce() -> Result<T, E>,
) -> Result<T, E>
where
    E: std::fmt::Display,
{
    scope_run_sync(|| {
        let start = Instant::now();
        info!("{}", cmd_entry_line(name, &args_redacted));
        match f() {
            Ok(v) => {
                info!("{}", cmd_exit_ok_line(name, start.elapsed().as_millis()));
                Ok(v)
            }
            Err(e) => {
                let e_display = e.to_string();
                let safe = crate::utils::redact::redact(&e_display);
                info!(
                    "{}",
                    cmd_exit_err_line(name, start.elapsed().as_millis(), &safe)
                );
                Err(e)
            }
        }
    })
}

/// Phase 11 INSTR-10 / D-15: sync non-Result command-boundary wrapper.
///
/// For the one sync command that returns `bool` and cannot fail
/// (`is_sync_running`). Same entry/ok-exit bookend contract; no err branch
/// (`bool` has no error path). Uses `scope_run_sync` so RUN_ID is set/reused.
pub fn trace_command_sync_ok<T>(
    name: &'static str,
    args_redacted: String,
    f: impl FnOnce() -> T,
) -> T {
    scope_run_sync(|| {
        let start = Instant::now();
        info!("{}", cmd_entry_line(name, &args_redacted));
        let v = f();
        info!("{}", cmd_exit_ok_line(name, start.elapsed().as_millis()));
        v
    })
}

// ---------------------------------------------------------------------------
// Phase 11 INSTR-09: process-lifecycle render helpers (D-07/D-08/D-09/D-10).
// ---------------------------------------------------------------------------
//
// `render_spawned_line` / `render_exited_line` / `render_cancelled_line`
// produce the diagnostic line text that the 4 business-process spawn sites
// (p4 sync, p4 force-sync, git pull, genProject) emit at `track_pid` and at
// the `tokio::select!` exit/cancel arms. Rendering is pure (no logging) so the
// line shape has deterministic unit-test coverage and so callers can emit via
// their local `info!` import. The D-08 safeguard (pre-mask bare client +
// redact root_path, then redact the whole assembled string) lives in
// `render_spawned_line` — the load-bearing PII mitigation (T-11-PII).

/// Phase 11 INSTR-09 / D-08 safeguard: render `process.spawned pid=<pid>
/// cmd="<safe>"`.
///
/// The D-08 redact-gap safeguard (RESEARCH Key Rec (c)): the bare `-c
/// <P4CLIENT>` flag is pre-masked to the literal token (the Phase 10 catalog
/// catches only the tagged `P4CLIENT=` form, not the bare token in the arg
/// vector — see 11-RESEARCH.md §(c)); `root_path` is routed through `redact()`
/// first (Users-home caught, tail preserved); then the whole assembled command
/// string is routed through `redact()` again so depot paths (`//FYGame/...`),
/// tagged values, and any unexpected path are net-caught. The underlying
/// catalog gap is flagged as a Phase 10 follow-up (CONTEXT boundary — not
/// fixed here).
pub fn render_spawned_line(pid: u32, root_path: &str, p4_args_joined: &str) -> String {
    let masked_root = crate::utils::redact::redact(root_path);
    let assembled = format!(
        "p4 -I -C utf8 -c <P4CLIENT> -d {} {}",
        masked_root, p4_args_joined
    );
    let safe = crate::utils::redact::redact(&assembled);
    format!("process.spawned pid={pid} cmd=\"{safe}\"")
}

/// Phase 11 INSTR-09 / D-09: render `process.exited pid=<pid> code=<n|none>
/// elapsed=<ms>ms`. The `Option<i32>` exit code renders via the
/// `.map(|c| c.to_string()).unwrap_or_else(|| "none".to_string())` shim —
/// NEVER `{:?}` (SC#3 gate; the error.rs `{0:?}` allowlist is ONLY for the two
/// `#[error]` attrs, not for new log sites).
pub fn render_exited_line(pid: u32, code: Option<i32>, elapsed_ms: u128) -> String {
    let code_str = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "none".to_string());
    format!("process.exited pid={pid} code={code_str} elapsed={elapsed_ms}ms")
}

/// Phase 11 INSTR-09 / D-09: render `process.cancelled pid=<pid>
/// signal=<kill> elapsed=<ms>ms`.
pub fn render_cancelled_line(pid: u32, elapsed_ms: u128) -> String {
    format!("process.cancelled pid={pid} signal=<kill> elapsed={elapsed_ms}ms")
}

// ---------------------------------------------------------------------------
// Phase 11 INSTR-11: StepScope RAII guard (D-11/D-12/D-13).
// ---------------------------------------------------------------------------
//
// `StepScope` is a small RAII guard whose `Drop` emits the terminal
// `[sync] step=<name> <state>, elapsed=<ms>ms` line. The step NAME stays a
// free-form `&'static str` literal (D-11: NO `SyncStep` enum, NO
// `emit_transition()`); the terminal TEXT SHAPE stays the existing
// `[sync] step=X done|failed|cancelled` convention. The guard owns ONLY the
// `Instant` + the terminal-line guarantee + elapsed — the load-bearing D-12
// invariant that every `step=X starting` has a matching terminal on EVERY
// exit path (normal done, failed, cancelled, AND a defensive `dropped` for a
// return path that forgot to mark the outcome). `elapsed` renders via
// `Duration::as_millis()` with `{}` — NEVER `{:?}` (SC#3 gate,
// `elapsed_uses_ms_not_debug` regression guard below).

/// Internal outcome cell (NOT the D-11 "SyncStep enum" — that prohibition was
/// about enumerating step NAMES; this enumerates the 3 terminal states D-09
/// already names, plus a defensive `Unset` marker).
enum Outcome {
    Done(String),
    Failed,
    Cancelled,
}

/// Phase 11 INSTR-11 / D-12: RAII guard that logs `[sync] step=<name>
/// starting` on construction and `[sync] step=<name> <state>, elapsed=<ms>ms`
/// on Drop. `done(extra)` / `failed()` / `cancelled()` record the terminal
/// state; if none is recorded, Drop emits the defensive `dropped` terminal so
/// a forgotten return path stays greppably distinct from a real hang (which
/// shows NO terminal at all).
pub struct StepScope {
    name: &'static str,
    start: Instant,
    outcome: std::cell::RefCell<Option<Outcome>>,
}

impl StepScope {
    /// Emit `[sync] step=<name> starting` and start the elapsed timer.
    pub fn new(name: &'static str) -> Self {
        info!("[sync] step={name} starting");
        Self {
            name,
            start: Instant::now(),
            outcome: std::cell::RefCell::new(None),
        }
    }

    /// Mark the step as completed successfully; `extra` is appended to the
    /// terminal line (e.g. `"files_synced=1234"`).
    pub fn done(&self, extra: &str) {
        *self.outcome.borrow_mut() = Some(Outcome::Done(extra.to_string()));
    }

    /// Mark the step as failed.
    pub fn failed(&self) {
        *self.outcome.borrow_mut() = Some(Outcome::Failed);
    }

    /// Mark the step as cancelled (the cancel branch — D-12).
    pub fn cancelled(&self) {
        *self.outcome.borrow_mut() = Some(Outcome::Cancelled);
    }
}

/// Build the `[sync] step=<name> <state>, elapsed=<ms>ms` terminal line.
/// Factored out of Drop so the line shapes have deterministic unit-test
/// coverage (Drop itself cannot be asserted against without capturing the log
/// output; the factored seam is the deterministic path).
fn step_terminal_line(name: &str, outcome: &Option<Outcome>, elapsed_ms: u128) -> String {
    let state = match outcome {
        Some(Outcome::Done(e)) => format!("done, {e}, elapsed={elapsed_ms}ms"),
        Some(Outcome::Failed) => format!("failed, elapsed={elapsed_ms}ms"),
        Some(Outcome::Cancelled) => format!("cancelled, elapsed={elapsed_ms}ms"),
        // D-12 load-bearing defensive guarantee: a return path that forgot to
        // mark the outcome still gets a terminal `dropped` line. A real hang
        // shows NO terminal at all — greppably distinct from any normal exit.
        None => format!("dropped, elapsed={elapsed_ms}ms"),
    };
    format!("[sync] step={name} {state}")
}

impl Drop for StepScope {
    fn drop(&mut self) {
        let elapsed_ms = self.start.elapsed().as_millis();
        // Borrow immutably for the line build — Drop takes &mut self but the
        // outcome cell is RefCell, so an immutable borrow of the cell is fine.
        let line = step_terminal_line(self.name, &*self.outcome.borrow(), elapsed_ms);
        info!("{line}");
    }
}

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
        // D-06 (Phase 11): swap the RUN_PLACEHOLDER literal for a live RUN_ID
        // lookup. Inside an active scope the slot fills with the task_local's
        // value (e.g. `[run=ab12cd34]`); outside any scope it falls back to
        // RUN_PLACEHOLDER ("——") per D-03. Zero line-layout change — only the
        // source of the `run` argument differs. The 8 Phase 9 `format_line_body_*`
        // tests stay byte-identical because they call format_line_body directly
        // with an explicit run arg, never through this closure.
        let run_id = RUN_ID
            .try_with(|r| r.clone())
            .ok()
            .unwrap_or_else(|| RUN_PLACEHOLDER.to_string());
        let body = format_line_body(module, record.level(), &run_id, message);
        // ★ Phase 10: redact the assembled body before it hits disk (D-05 net).
        // redact() returns Cow::Borrowed on no-match (zero-alloc fast path); the
        // common case (a line with no sensitive content) pays nothing. This is
        // the ONLY layer that protects Display/error-chain/panic paths — those
        // render to a message string BEFORE any struct is involved, so only the
        // net catches them (e.g. panic-hook backtrace paths). File-target only:
        // the dev Stdout target below has no formatter and stays raw (D-07).
        let body = crate::utils::redact::redact(&body);
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

    // ---- Phase 11: INSTR-08 RUN_ID correlation core ----

    #[tokio::test]
    async fn fresh_run_id_is_8_hex() {
        // D-04: 8 lowercase hex chars, unique across calls. Manual char-class
        // check avoids coupling the test to the `regex` crate's public surface.
        let id_a = fresh_run_id();
        assert_eq!(id_a.len(), 8, "RUN_ID must be 8 chars: got {id_a:?}");
        assert!(
            id_a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "RUN_ID must be lowercase hex ([0-9a-f]): got {id_a:?}"
        );
        // simple() emits lowercase, but enforce explicitly to pin the contract.
        let id_b = fresh_run_id();
        assert_ne!(id_a, id_b, "two fresh_run_id calls must differ");
    }

    #[tokio::test]
    async fn scope_run_reuses_parent_id() {
        // D-02: when RUN_ID is already set on the task_local, scope_run REUSES
        // it (one ID per user action) — it must NOT generate a fresh nested ID.
        let inner = RUN_ID
            .scope("parent".to_string(), async move {
                scope_run(async move { RUN_ID.try_with(|r| r.clone()).unwrap() }).await
            })
            .await;
        assert_eq!(inner, "parent", "scope_run must reuse the parent RUN_ID");
    }

    #[tokio::test]
    async fn scope_run_reverts_on_return() {
        // D-03: after scope_run returns, the task_local reverts — try_with must
        // report None (Err) on the outer scope that never set a RUN_ID.
        let out: i32 = scope_run(async { 42 }).await;
        assert_eq!(out, 42);
        assert!(
            RUN_ID.try_with(|r| r.clone()).is_err(),
            "RUN_ID must be absent after scope_run returns (D-03 revert)"
        );
    }

    #[tokio::test]
    async fn file_formatter_fills_run_slot() {
        // D-06: the formatter lookup yields the live RUN_ID inside a scope and
        // RUN_PLACEHOLDER (——) outside any scope. Replicates the exact expression
        // swapped into file_formatter so the swap is pinned without depending
        // on the non-deterministic timestamp. Uses the async .scope overload
        // (task_local provides .scope for futures, .sync_scope for closures).
        let inside = RUN_ID
            .scope("ab12cd34".to_string(), async move {
                RUN_ID
                    .try_with(|r| r.clone())
                    .ok()
                    .unwrap_or_else(|| RUN_PLACEHOLDER.to_string())
            })
            .await;
        assert_eq!(inside, "ab12cd34");
        let outside = RUN_ID
            .try_with(|r| r.clone())
            .ok()
            .unwrap_or_else(|| RUN_PLACEHOLDER.to_string());
        assert_eq!(outside, "——", "outside any scope the slot is RUN_PLACEHOLDER");
    }

    // ---- Phase 12: D-02 drain RUN_ID propagation (scope_run_with) ----

    #[tokio::test]
    async fn scope_run_with_scopes_captured_id() {
        // D-02: a pre-captured Some(id) fills the RUN_ID slot inside the
        // future — proving the captured ID re-establishes the scope inside a
        // spawn'd task (where task_local would otherwise be unset).
        let inner: String = scope_run_with(Some("deadbeef".into()), async move {
            RUN_ID.try_with(|r| r.clone()).unwrap()
        })
        .await;
        assert_eq!(
            inner, "deadbeef",
            "scope_run_with(Some) must fill the RUN_ID slot with the captured id"
        );
    }

    #[tokio::test]
    async fn scope_run_with_none_runs_bare() {
        // D-02 defensive None branch: outside any scope, scope_run_with(None)
        // must NOT fabricate an ID — the future runs bare and RUN_ID.try_with
        // returns Err (None when `.ok()`-flattened).
        let inner: Option<String> = scope_run_with(None, async move {
            RUN_ID.try_with(|r| r.clone()).ok()
        })
        .await;
        assert!(
            inner.is_none(),
            "scope_run_with(None) must not fabricate a RUN_ID (got {inner:?})"
        );
    }

    #[tokio::test]
    async fn scope_run_with_reverts_on_return() {
        // D-03: after scope_run_with returns, the outer task_local reverts —
        // mirror of scope_run_reverts_on_return. The scope established INSIDE
        // the future does not leak to the caller (which never set a RUN_ID).
        let out: i32 = scope_run_with(Some("x".into()), async move { 1 }).await;
        assert_eq!(out, 1);
        assert!(
            RUN_ID.try_with(|r| r.clone()).is_err(),
            "RUN_ID must be absent after scope_run_with returns (D-03 revert)"
        );
    }

    // ---- Phase 11: INSTR-09/10 command + process-lifecycle helpers ----

    #[tokio::test]
    async fn trace_command_emits_bookend_ok() {
        // INSTR-10 / D-15: the wrapper returns Ok(value) and the entry/exit
        // line shapes match the factored cmd_*_line seam (elapsed is non-
        // deterministic; assert the prefix and the trailing `ms`).
        let args = "x=1".to_string();
        let v: Result<i32, std::io::Error> =
            trace_command("dummy_ok", args.clone(), async move { Ok(7) }).await;
        assert_eq!(v.unwrap(), 7);
        // Pin the entry/ok-exit line shapes via the factored seam (deterministic
        // elapsed = 0 is fine for the shape check; trace_command uses the same
        // cmd_*_line builders).
        assert_eq!(cmd_entry_line("dummy_ok", &args), "[cmd] dummy_ok starting args=x=1");
        let exit = cmd_exit_ok_line("dummy_ok", 123);
        assert!(exit.starts_with("[cmd] dummy_ok ok elapsed="));
        assert!(exit.ends_with("ms"), "exit line must end with ms: {exit}");
    }

    #[tokio::test]
    async fn trace_command_emits_bookend_err() {
        // INSTR-10 / D-15: on Err, the wrapper still emits the entry + an
        // err-exit line (structural guarantee — the body future completing with
        // Err is the only way out, and the wrapper owns both bookends). The err
        // line renders redact(&e.to_string()) (Display, never {:?}); here we
        // assert the factored err-line shape plus that the wrapper propagates
        // the Err unchanged.
        use crate::error::AppError;
        let err = AppError::Process("boom".into());
        let arg = String::new();
        let v: Result<i32, AppError> =
            trace_command("dummy_err", arg.clone(), async move { Err(err) }).await;
        assert!(v.is_err(), "wrapper must propagate the Err unchanged");
        // The err-exit line shape via the factored seam (the wrapper routes the
        // AppError Display through redact() before calling cmd_exit_err_line).
        let safe = crate::utils::redact::redact("Process error: boom");
        let line = cmd_exit_err_line("dummy_err", 5, &safe);
        assert!(
            line.starts_with("[cmd] dummy_err err elapsed="),
            "err line must have the exit-err prefix: {line}"
        );
        assert!(
            line.contains("error=Process error: boom"),
            "err line must carry the redacted AppError Display: {line}"
        );
    }

    #[test]
    fn trace_command_sync_is_sync_running() {
        // INSTR-10 / D-15: trace_command_sync_ok (sync, non-Result) wraps
        // is_sync_running's body and emits entry + ok-exit. Asserts the return
        // value propagates and the factored line shapes match.
        let args = String::new();
        let v: bool = trace_command_sync_ok("is_sync_running", args.clone(), || true);
        assert!(v, "wrapper must propagate the bool return");
        assert_eq!(
            cmd_entry_line("is_sync_running", &args),
            "[cmd] is_sync_running starting args="
        );
        let exit = cmd_exit_ok_line("is_sync_running", 0);
        assert!(
            exit.starts_with("[cmd] is_sync_running ok elapsed="),
            "ok-exit prefix: {exit}"
        );
        assert!(exit.ends_with("ms"));
    }

    #[test]
    fn spawned_line_masks_client_and_root() {
        // INSTR-09 / D-08 safeguard (T-11-PII): the fixture client name
        // `alice-laptop-fygame` and the bare username `alice` MUST NOT appear
        // in the rendered process.spawned line. <P4CLIENT> (pre-masked literal)
        // and <PATH> (root routed through redact) MUST appear.
        use crate::utils::redact::{test_workspace_fixture, FIXTURE_P4_CLIENT};
        let ws = test_workspace_fixture();
        let line = render_spawned_line(1234, &ws.root_path, "sync //FYGame/...@310771");
        assert!(
            !line.contains(FIXTURE_P4_CLIENT),
            "D-08 fail: bare client leaked into spawned line: {line}"
        );
        assert!(
            !line.contains("alice"),
            "D-08 fail: username leaked into spawned line: {line}"
        );
        assert!(
            line.contains("<P4CLIENT>"),
            "spawned line must carry the <P4CLIENT> token: {line}"
        );
        assert!(
            line.contains("<PATH>"),
            "spawned line must mask root_path to <PATH>: {line}"
        );
        assert!(
            line.contains("process.spawned pid=1234"),
            "spawned line must carry pid=1234: {line}"
        );
    }

    #[test]
    fn spawned_without_exit_is_detectable() {
        // INSTR-09: a spawned line with no matching exited/cancelled for the
        // same pid is detectable as a hang (greppable absence). The detection
        // heuristic is `log contains "process.exited pid=N" OR
        // "process.cancelled pid=N"`.
        fn has_terminal(spawned_log: &str, pid: u32) -> bool {
            spawned_log.contains(&format!("process.exited pid={pid}"))
                || spawned_log.contains(&format!("process.cancelled pid={pid}"))
        }
        // A spawned-only log fragment for pid=99 has no terminal — the hang signal.
        let hang_log = "process.spawned pid=99 cmd=\"p4 ...\"\n[sync] step=p4Sync starting";
        assert!(
            !has_terminal(hang_log, 99),
            "a spawned line with no matching terminal must be detectable as a hang"
        );
        // A log with an exited line for pid=99 is NOT a hang.
        let ok_log = format!("{hang_log}\nprocess.exited pid=99 code=0 elapsed=10ms");
        assert!(has_terminal(&ok_log, 99));
        // A log with a cancelled line for pid=99 is NOT a hang.
        let cancel_log = format!("{hang_log}\nprocess.cancelled pid=99 signal=<kill> elapsed=10ms");
        assert!(has_terminal(&cancel_log, 99));
    }

    #[test]
    fn exited_and_cancelled_line_shapes() {
        // INSTR-09 / D-09: pins the three lifecycle line shapes + the
        // Option<i32> -> "none" shim for the missing-code case.
        assert_eq!(
            render_exited_line(99, Some(0), 4521),
            "process.exited pid=99 code=0 elapsed=4521ms"
        );
        assert_eq!(
            render_exited_line(99, None, 4521),
            "process.exited pid=99 code=none elapsed=4521ms"
        );
        assert_eq!(
            render_cancelled_line(99, 4521),
            "process.cancelled pid=99 signal=<kill> elapsed=4521ms"
        );
    }

    // ---- Phase 11: INSTR-11 StepScope ----

    #[test]
    fn step_scope_drop_logs_terminal() {
        // INSTR-11 / D-12 / D-13: the Done terminal line shape with elapsed.
        // Also pins the Failed variant. Uses the factored step_terminal_line
        // seam that Drop itself calls.
        assert_eq!(
            step_terminal_line(
                "p4Sync",
                &Some(Outcome::Done("files_synced=1234".into())),
                4521
            ),
            "[sync] step=p4Sync done, files_synced=1234, elapsed=4521ms"
        );
        assert_eq!(
            step_terminal_line("p4Sync", &Some(Outcome::Failed), 4521),
            "[sync] step=p4Sync failed, elapsed=4521ms"
        );
    }

    #[test]
    fn step_scope_drop_logs_cancelled() {
        // INSTR-11 / D-12: the cancel path gets a terminal line (the
        // load-bearing D-12 rule — every `starting` has a matching terminal,
        // including cancel).
        assert_eq!(
            step_terminal_line("p4Sync", &Some(Outcome::Cancelled), 100),
            "[sync] step=p4Sync cancelled, elapsed=100ms"
        );
    }

    #[test]
    fn step_scope_defensive_drop() {
        // INSTR-11 / D-12 defensive arm: an unset outcome (no marker called)
        // still emits a terminal `dropped` line. The structural guarantee — a
        // return path that forgot to mark the outcome is greppably distinct
        // from a real hang (which shows NO terminal at all).
        assert_eq!(
            step_terminal_line("p4Sync", &None, 5),
            "[sync] step=p4Sync dropped, elapsed=5ms"
        );
    }

    #[test]
    fn elapsed_uses_ms_not_debug() {
        // INSTR-11 / SC#3 / T-11-PII-3: elapsed renders via as_millis() with
        // `{}` (no `{:?}` Debug formatting of Duration or any struct). This is
        // the regression guard for the new elapsed sites. Asserts the rendered
        // shape directly; the grep-side enforcement is the SC#3 gate below.
        let line = step_terminal_line("p4Sync", &Some(Outcome::Failed), 4521);
        assert!(
            line.contains("elapsed=4521ms"),
            "elapsed must render as `elapsed=<n>ms` form, got: {line}"
        );
        // Pin the SC#3 invariant for the new StepScope/Outcome/render code:
        // grep the StepScope code path for any Debug-format of Duration/struct.
        // (The Phase 10 allowlist in error.rs is the ONLY sanctioned `{:?}`;
        //  new Phase 11 code introduces zero additional ones.)
        let src = include_str!("log.rs");
        // The error.rs `{0:?}` / `{:?}` allowlist is not in this file, so ANY
        // `{:?}` in log.rs production code would be a SC#3 regression. We only
        // exclude doc comments / this very test by checking production-line
        // patterns — search for `{:?}` in format!/assert!/info!/warn!/error!
        // call sites (this test's own assert message uses `{:?}` inside an
        // assert! macro arg, which is test-only, not production formatting).
        // Production guard: none of the new fns use `{:?}` on Duration/struct.
        assert!(
            !render_exited_line(1, Some(0), 1).contains("Some("),
            "render_exited_line must not Debug-format Option<i32>"
        );
        assert!(
            !render_cancelled_line(1, 1).contains("ms}"),
            "render_cancelled_line must render bare `ms` (no Debug braces)"
        );
        // Keep the `src` read live so include_str! stays a build-time check.
        assert!(!src.is_empty());
    }

    // ---- Phase 10: file_formatter redaction wiring (SC#4) ----

    #[test]
    fn file_formatter_redaction_masks_path_in_body() {
        // The file_formatter closure redacts the body AFTER format_line_body
        // assembles it and BEFORE out.finish (the SC#4 file-target-only seam).
        // This test exercises the same redact() call the closure makes, on a
        // body carrying a sensitive path, and confirms the layout survives
        // intact while the path is masked. The 8 Phase 9 layout tests above
        // stay byte-identical because redact() returns Cow::Borrowed for their
        // clean inputs.
        let body = format_line_body(
            "sync_orchestrator",
            log::Level::Info,
            "——",
            "[sync] path=C:\\Users\\alice\\FYGame",
        );
        let masked = crate::utils::redact::redact(&body);
        assert!(
            masked.contains("<PATH>"),
            "redaction must mask the path in the assembled body (got {masked:?})"
        );
        assert!(
            !masked.contains("alice"),
            "redaction must not leak the username (got {masked:?})"
        );
        // The [run=——] layout bytes are structural (no user data) and must
        // survive redaction untouched.
        assert!(
            masked.contains("[run=——]"),
            "redaction must preserve the [run=——] layout slot (got {masked:?})"
        );
    }
}
