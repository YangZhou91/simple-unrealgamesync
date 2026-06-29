//! D-04 (Phase 12 / HOTUI-12): a `Channel<SyncEvent>` wrapper that counts
//! every `.send()` into ONE shared `Arc<AtomicU64>` total.
//!
//! The freeze brief `logline-ipc-flood.md` names raw IPC *volume* (hundreds of
//! thousands of `channel.send(SyncEvent::LogLine)` calls saturating WebView2's
//! `ExecuteScript` queue) as the freeze signal. The `LogBatch` mitigation
//! already bounds that volume at the IPC layer; `CountingChannel` makes the
//! bound *observable* at the log layer — without re-creating the flood there
//! (per-event `debug!` is structurally impossible: there is no `debug!` inside
//! `send()`).
//!
//! ## Why a wrapper over inline counter edits at ~66 send sites
//!
//! The operator's rationale: editing each `channel.send(SyncEvent::...)` call
//! site by hand to increment a counter is error-prone and recreates the exact
//! "manual bookkeeping at many sites" anti-pattern Phase 11's D-15
//! `trace_command` macro was built to avoid. Centralizing the count in ONE type
//! makes it automatic at every send site that uses the type — and the count is
//! then sampled (Task 2 / Plan 12-01) as a `debug!` line from the existing 5s
//! p4-sync heartbeat and as a per-completion summary for the force-sync +
//! git/genProject drain families.
//!
//! ## D-04 load-bearing property — clones share ONE counter
//!
//! Each `tokio::spawn`'d drain/heartbeat task that sends IPC receives a
//! `CountingChannel` clone (`let ch = channel.clone();`); the underlying
//! `Arc<AtomicU64>` is Arc-shared, so stdout + stderr + heartbeat + the
//! orchestrator's sends ALL increment ONE total. The `Clone` impl below Arc-
//! clones the counter; the inner `Channel` is already cheaply cloneable.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::ipc::Channel;

use crate::models::SyncEvent;

/// Newtype wrapper over `Channel<SyncEvent>` that increments a shared
/// `Arc<AtomicU64>` on every `send()`. See the module docs for the D-04
/// rationale (wrapper over inline edits; clones share one counter).
pub struct CountingChannel {
    counter: Arc<AtomicU64>,
    inner: Channel<SyncEvent>,
}

impl CountingChannel {
    /// Wrap a `Channel<SyncEvent>` with a fresh counter starting at 0. The
    /// command boundary (`start_sync` / `retry_step` / `start_rollback` /
    /// `git_pull`) calls this ONCE per run; every downstream `.clone()` shares
    /// the same counter (D-04).
    pub fn new(inner: Channel<SyncEvent>) -> Self {
        Self {
            counter: Arc::new(AtomicU64::new(0)),
            inner,
        }
    }

    /// Increment the shared counter, then delegate to the inner
    /// `Channel::send`. `Relaxed` ordering is correct (D-04): the counter is a
    /// statistical volume gauge, not a synchronization primitive — there is no
    /// happens-before dependency on the count value. The increment happens
    /// BEFORE the delegate so a failed `Channel::send` still counts the
    /// attempted send (the flood signal is "how many IPC sends were issued",
    /// which includes the ones that error).
    pub fn send(&self, ev: SyncEvent) -> Result<(), tauri::Error> {
        self.counter.fetch_add(1, Ordering::Relaxed);
        self.inner.send(ev)
    }

    /// Read the current counter total (Task 2's heartbeat + drain-completion
    /// samplers call this). `Relaxed` — see `send`.
    pub fn count(&self) -> u64 {
        self.counter.load(Ordering::Relaxed)
    }
}

impl Clone for CountingChannel {
    /// Clone the counter via `Arc::clone` (D-04 load-bearing: clones share ONE
    /// counter) and clone the inner `Channel` (which is already cheaply
    /// cloneable — every drain spawn does `channel.clone()` today).
    fn clone(&self) -> Self {
        Self {
            counter: Arc::clone(&self.counter),
            inner: self.inner.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The D-04 load-bearing property is that `Clone` shares ONE `Arc<AtomicU64>`
    // so that stdout + stderr + heartbeat + orchestrator sends all increment a
    // single total. A live `Channel<SyncEvent>` cannot be constructed in a unit
    // test (it needs a WebviewWindow), so the full send-counts-correctly proof
    // is the Plan 12-04 manual smoke where the `ipc.channel sent total=N` line
    // appears in the log post-sync. Here we cover the counter arithmetic + the
    // Arc-sharing semantics in isolation — the parts that are testable without
    // a runtime.

    #[test]
    fn counter_starts_at_zero_and_increments() {
        // Construct the counter directly (the same shape `new` allocates) and
        // exercise the fetch_add + load pair the production `send`/`count`
        // methods use. This pins the arithmetic + Relaxed ordering without
        // needing a live Channel.
        let counter = Arc::new(AtomicU64::new(0));
        assert_eq!(counter.load(Ordering::Relaxed), 0, "counter must start at 0");
        counter.fetch_add(1, Ordering::Relaxed);
        counter.fetch_add(1, Ordering::Relaxed);
        assert_eq!(counter.load(Ordering::Relaxed), 2, "two increments → 2");
        // A `new(...)` CountingChannel would expose the same starting value via
        // `count()`; the manual smoke (Plan 12-04) verifies the post-send value.
    }

    #[test]
    fn clone_shares_one_counter() {
        // D-04 load-bearing: `Clone` Arc-clones the counter, so two clones
        // observe the same total. This mirrors the production drain-spawn shape
        // (`let ch = channel.clone();` in a `tokio::spawn`) where stdout/stderr/
        // heartbeat/orchestrator all share ONE Arc<AtomicU64>.
        let counter = Arc::new(AtomicU64::new(0));
        let clone_a = Arc::clone(&counter);
        let clone_b = Arc::clone(&counter);

        // Increment via clone_a (as the stdout drain would).
        clone_a.fetch_add(5, Ordering::Relaxed);
        // clone_b (e.g. the heartbeat sampler) observes the increment.
        assert_eq!(
            clone_b.load(Ordering::Relaxed),
            5,
            "clone_b must see clone_a's increment (D-04 shared counter)"
        );
        // And the original observes it too.
        assert_eq!(
            counter.load(Ordering::Relaxed),
            5,
            "original counter must see the clone's increment (D-04 shared counter)"
        );
    }
}
