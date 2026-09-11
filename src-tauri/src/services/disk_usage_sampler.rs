//! OS-level disk-write sampler for the `p4 sync` byte-level progress bar.
//!
//! Purpose: `p4 sync` emits all ~116,814 "-updating" stdout lines in ~13s
//! (~14,000 lines/sec, decoupled from transfer), then runs ~5m44s doing the
//! real transfer with NO further stdout. Any line-based metric (count or
//! byte-weighting the lines) hits ~100% in 13s and is dead for the tail.
//! Perforce reports sync only at file granularity server-side (on their
//! backlog) — no native byte progress. So we get real bytes from the OS, not
//! from p4 stdout.
//!
//! This helper reads the kernel-level per-process `total_written_bytes`
//! counter (cumulative bytes written since process start) for the p4 child
//! PID via sysinfo's `Process::disk_usage()`. Read-only, no privilege
//! escalation (same-user process). The caller samples on a ~0.5s cadence from
//! the p4Sync heartbeat; each sample yields the delta since the previous
//! sample, the accumulated total, and a per-second rate.
//!
//! Field choice: sysinfo `DiskUsage` exposes `total_written_bytes` (cumulative)
//! AND `written_bytes` (bytes since the last refresh). We read the CUMULATIVE
//! field and delta it ourselves. Do NOT switch to `written_bytes` — reading it
//! AND differencing would double-delta the per-refresh value. (sysinfo 0.32.1,
//! src/common/system.rs:964.)
//!
//! T-ep7-01 (counter reset / wraparound): deltas are computed with
//! `saturating_sub` — a reset yields delta 0, never underflow; accumulated
//! bytes stay monotonic.

use std::time::Instant;

/// One sample of the p4 child's disk-write activity.
///
/// - `delta_bytes`: bytes written since the previous sample (0 on first
///   sample or counter reset — never underflows thanks to `saturating_sub`).
/// - `accumulated_bytes`: monotonic total since `DiskUsageSampler::new`.
/// - `rate_bytes_per_sec`: `delta_bytes / elapsed_secs` (elapsed clamped to
///   >=1ms to avoid div-by-zero).
#[derive(Debug, Clone, Copy)]
pub struct SampledBytes {
    pub delta_bytes: u64,
    pub accumulated_bytes: u64,
    pub rate_bytes_per_sec: u64,
}

/// PID-scoped disk-usage sampler. Owns one sysinfo `System` (refreshed each
/// sample) and tracks the previous `written_bytes` + accumulated total +
/// last-sample instant for one p4 child PID. Does NOT scan all processes —
/// `system.process(self.pid)` reads only the target.
pub struct DiskUsageSampler {
    sys: sysinfo::System,
    pid: sysinfo::Pid,
    last_written: u64,
    accumulated: u64,
    last_at: Instant,
}

impl DiskUsageSampler {
    /// Construct a sampler for the given p4 child PID. The system is refreshed
    /// once at construction so the first `sample()` has a baseline `written_bytes`.
    pub fn new(pid: u32) -> Self {
        Self {
            sys: sysinfo::System::new_all(),
            pid: sysinfo::Pid::from(pid as usize),
            last_written: 0,
            accumulated: 0,
            last_at: Instant::now(),
        }
    }

    /// Sample the p4 child's disk activity. Returns `None` when the pid is no
    /// longer alive / not found (process gone — heartbeat treats this as "no
    /// byte signal this tick"). Returns `Some(SampledBytes)` with the delta
    /// since the previous sample, accumulated total, and per-second rate.
    pub fn sample(&mut self) -> Option<SampledBytes> {
        // sysinfo 0.32: refresh ONLY the target pid (efficient — does not scan
        // all processes every 2s). `remove_dead_processes=false` keeps the
        // last-known entry; `system.process(pid)` returns None when the OS
        // no longer reports the pid (process truly gone).
        let pids = [self.pid];
        self.sys
            .refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids), false);
        let proc = self.sys.process(self.pid)?;
        let du = proc.disk_usage();
        // Read the CUMULATIVE counter, not `written_bytes` (which is per-refresh
        // since the last call). We delta the cumulative ourselves below; reading
        // the per-refresh field AND differencing would double-delta it.
        // (sysinfo 0.32.1 DiskUsage: total_written_bytes=Total, written_bytes=since-last-refresh.)
        let current = du.total_written_bytes;
        // T-ep7-01: saturating_sub handles counter reset / wraparound — a
        // reset yields delta 0, never underflow; accumulated stays monotonic.
        let delta = current.saturating_sub(self.last_written);
        self.last_written = current;
        self.accumulated += delta;
        // Clamp elapsed to >=1ms to avoid div-by-zero on sub-millisecond ticks.
        let elapsed = self.last_at.elapsed().as_secs_f64().max(0.001);
        self.last_at = Instant::now();
        let rate = (delta as f64 / elapsed) as u64;
        Some(SampledBytes {
            delta_bytes: delta,
            accumulated_bytes: self.accumulated,
            rate_bytes_per_sec: rate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T-ep7-01 + compile-spike: the only behavior testable without a real
    /// process is "a pid that does not exist returns None". This proves the
    /// sysinfo API compiles + links + runs in the test harness. The real
    /// positive signal — non-zero deltas on a writing p4 process — is
    /// empirically validated by the Task 2 heartbeat `debug!("disk_usage ...")`
    /// instrumentation log on the next real sync, NOT by a unit test, because
    /// no test can synthesize real OS disk writes against a live p4 child.
    #[test]
    fn sampler_for_dead_pid_returns_none() {
        // 0xFFFF_FFFF is a pid that will not exist on any realistic OS.
        let mut sampler = DiskUsageSampler::new(0xFFFF_FFFFu32);
        assert!(sampler.sample().is_none());
    }
}
