//! Per-run synced-file log (quick-260630-srw).
//!
//! During a real `p4 sync`, each matched file line is appended to a per-run
//! file `sync-<run_id>.log` in the app log dir, formatted as
//! `{current}/{total} {redacted_raw_line}`. This gives the operator a
//! persistent, 1:1-correlated per-file record they can cross-reference
//! against the frontend progress bar AFTER a sync (the in-memory LogViewer is
//! lost on WebView suspension and the main `p4-updater.log` is deliberately
//! count-only per the Phase 12 anti-flood decision T-12-DR-1).
//!
//! Design guarantees (mirrors redact.rs / commands/log.rs rationale):
//! - **SEPARATE sink, never `p4-updater.log`** — writing per-file lines to the
//!   main rotating log (KeepSome(5) × 5MB) would flood rotation and reverse
//!   T-12-DR-1. The per-run file is its own sink; the main log is untouched.
//! - **Best-effort, non-fatal** — every operation swallows `io::Error`s. A
//!   sync NEVER fails because the per-run file couldn't be written (the drain
//!   task must not stall on a broken file handle either — on error the writer
//!   latches to `None` so subsequent calls are a cheap no-op, no retry).
//! - **Redact-mandatory** — `format_sync_file_line` routes EVERY raw p4 line
//!   through `crate::utils::redact::redact` BEFORE formatting. The Phase 10
//!   audited boundary (D-05) is reused; no raw depot/local path or username is
//!   ever persisted. `total` is printed verbatim — it is NEVER used as a
//!   divisor (the dry-run estimate may be 0 or an undercount); the format is
//!   purely display.
//! - **Retention** — `prune_sync_run_logs` keeps the `SYNC_RUN_LOG_KEEP` most
//!   recent `sync-*.log` files (by mtime) and is invoked once per run at
//!   `SyncRunFileWriter::open` time, so the log dir cannot grow unbounded.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use crate::utils::redact::redact;

/// Number of `sync-*.log` files to retain when pruning at open time.
/// Small constant per the constraint (operator-owned log dir; older
/// correlation logs are low-value once a newer run lands).
pub const SYNC_RUN_LOG_KEEP: usize = 3;

/// Format one synced-file line as `{current}/{total} {redacted}` (no trailing
/// newline — the caller's `writeln!` adds it, or `write_line` does).
///
/// `raw` is routed through `crate::utils::redact::redact` BEFORE formatting
/// (redact-mandatory — no raw path/username is ever persisted). `total` is
/// printed verbatim; it is NEVER used as a divisor (the dry-run estimate may
/// be 0 or an undercount), so `total=0` cannot panic.
pub fn format_sync_file_line(current: u64, total: u64, raw: &str) -> String {
    // Trim any trailing newline defensively — p4 stdout lines have none, but
    // a future caller might pass a multi-line buffer; one logical line per
    // write keeps the 1:1 correlation with the progress counter intact.
    let redacted = redact(raw);
    let trimmed = redacted.trim_end_matches(['\n', '\r']);
    format!("{current}/{total} {trimmed}")
}

/// Best-effort appender for one per-run sync log file.
///
/// `open` returns `None` when the file cannot be created (dir missing,
/// permissions, etc.) — `None` means "no file logging this run", and the
/// caller proceeds normally. All `write_line`/`flush` io errors are swallowed
/// internally; on the first error the inner writer latches to `None` so later
/// calls become a cheap no-op rather than retrying a broken handle (a broken
/// handle must not stall the p4 stdout drain — T-q01-02 mitigation).
pub struct SyncRunFileWriter {
    writer: Option<BufWriter<File>>,
}

impl SyncRunFileWriter {
    /// Open `sync-<run_id>.log` inside `dir` for writing. Returns `None` on
    /// any io error (best-effort — dir missing, permissions, etc.). Prunes
    /// older `sync-*.log` files beyond `SYNC_RUN_LOG_KEEP` once per run before
    /// returning the writer (retention applied at open time).
    pub fn open(dir: &Path, run_id: &str) -> Option<Self> {
        // Retention first — once per run, best-effort (swallows read/remove
        // errors internally). Pruning before the create keeps the dir tidy
        // even if the new file create subsequently fails.
        prune_sync_run_logs(dir, SYNC_RUN_LOG_KEEP);
        let path = dir.join(format!("sync-{run_id}.log"));
        match File::create(&path) {
            Ok(file) => Some(Self {
                writer: Some(BufWriter::new(file)),
            }),
            Err(_) => None,
        }
    }

    /// Append one `{current}/{total} {redacted}\n` line. Best-effort: on any
    /// io error the inner writer latches to `None` (no retry on a broken
    /// handle — the drain must not stall). A no-op once latched.
    pub fn write_line(&mut self, current: u64, total: u64, raw: &str) {
        let Some(w) = self.writer.as_mut() else {
            return;
        };
        // format_sync_file_line yields no trailing newline; writeln! adds it.
        if writeln!(w, "{}", format_sync_file_line(current, total, raw)).is_err() {
            // Broken handle — latch to None so subsequent calls are a cheap
            // no-op instead of retrying (T-q01-02 DoS mitigation).
            self.writer = None;
        }
    }

    /// Flush the BufWriter. Best-effort: swallows errors, does NOT latch to
    /// None (a transient flush failure should not permanently silence the
    // writer — the next write may succeed).
    pub fn flush(&mut self) {
        if let Some(w) = self.writer.as_mut() {
            let _ = w.flush();
        }
    }
}

impl Drop for SyncRunFileWriter {
    fn drop(&mut self) {
        // Final best-effort flush on drop — ignore errors.
        if let Some(w) = self.writer.as_mut() {
            let _ = w.flush();
        }
    }
}

/// Prune `sync-*.log` files in `dir`, keeping the `keep` most recent by mtime
/// (ties broken by name). Best-effort: a missing dir, a read error, or a
/// per-file remove error (locked file) is swallowed — pruning one locked file
/// must not abort pruning the rest.
pub fn prune_sync_run_logs(dir: &Path, keep: usize) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return, // missing dir / unreadable — no-op
    };

    // Collect (path, mtime, file_name) for sync-*.log entries.
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime, String)> = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if !name.starts_with("sync-") || !name.ends_with(".log") {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        files.push((entry.path(), mtime, name.to_string()));
    }

    // Sort newest-first: mtime descending; ties broken by name descending.
    files.sort_by(|a, b| match b.1.cmp(&a.1) {
        std::cmp::Ordering::Equal => b.2.cmp(&a.2),
        other => other,
    });

    // Remove every entry at index >= keep. Swallow per-file removal errors
    // (a locked file must not abort pruning the rest).
    for (path, _, _) in files.iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    /// Build a uniquely-named temp subdir so parallel tests don't collide.
    fn unique_temp_dir(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("p4_test_sync_run_log_{}_{}_{}", std::process::id(), label, n));
        // Start clean in case a prior test run left it behind.
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir create failed");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    fn set_mtime(path: &Path, instant: SystemTime) {
        // Set the modified timestamp via std::fs::FileTimes (stable since
        // 1.75) so prune ordering is deterministic regardless of filesystem
        // mtime resolution. Errors are swallowed — tests assert on the
        // resulting ordering and will fail loudly if the set silently no-ops.
        let times = std::fs::FileTimes::new().set_modified(instant);
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
            let _ = f.set_times(times);
        }
    }

    // ---- format_sync_file_line: redaction + format ----

    #[test]
    fn format_line_redacts_users_home_path() {
        // A Users-prefix path the static catalog catches deterministically
        // regardless of the host's %USERNAME%: C:\Users\alice\... -> <PATH>\...
        let out = format_sync_file_line(5, 100, r"C:\Users\alice\workspaces\FYGame\Foo.uasset");
        assert!(
            out.contains("<PATH>"),
            "expected <PATH> token in {out:?}"
        );
        assert!(
            !out.contains("alice"),
            "raw username must not survive in {out:?}"
        );
        assert!(
            out.starts_with("5/100 "),
            "expected '5/100 ' prefix in {out:?}"
        );
    }

    #[test]
    fn format_line_never_contains_trailing_newline() {
        // format_sync_file_line yields the body only; writeln! in write_line
        // adds the newline. Verify no embedded trailing newline here.
        let out = format_sync_file_line(1, 10, "//FYGame/Main/Content/Maps/Foo.uasset");
        assert!(!out.ends_with('\n'), "no trailing newline in {out:?}");
        assert!(!out.ends_with('\r'), "no trailing CR in {out:?}");
    }

    #[test]
    fn format_line_total_zero_does_not_panic() {
        // Dry-run undercount case: total may be 0. It is printed verbatim and
        // NEVER used as a divisor — so total=0 cannot panic.
        let out = format_sync_file_line(5, 0, r"C:\Users\alice\workspaces\FYGame\Foo.uasset");
        assert!(
            out.starts_with("5/0 "),
            "expected '5/0 ' prefix for total=0 in {out:?}"
        );
        assert!(out.contains("<PATH>"));
    }

    #[test]
    fn format_line_preserves_non_path_content() {
        // A clean business line: no redaction fires, the body survives intact.
        let out = format_sync_file_line(3, 7, "no secrets here");
        assert_eq!(out, "3/7 no secrets here");
    }

    // ---- SyncRunFileWriter::open: None on missing dir, Some on real dir ----

    #[test]
    fn open_returns_none_for_nonexistent_dir() {
        let missing = std::env::temp_dir().join(format!(
            "p4_test_sync_run_log_missing_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Do NOT create the dir — open must return None (best-effort).
        let writer = SyncRunFileWriter::open(&missing, "abc123");
        assert!(writer.is_none(), "open on a missing dir must return None");
    }

    #[test]
    fn open_returns_some_for_real_dir_and_names_file_correctly() {
        let dir = unique_temp_dir("open_some");
        let writer = SyncRunFileWriter::open(&dir, "runXYZ");
        assert!(writer.is_some(), "open on a real dir must return Some");
        let expected = dir.join("sync-runXYZ.log");
        assert!(
            expected.exists(),
            "expected file {expected:?} to exist after open"
        );
        drop(writer);
        cleanup(&dir);
    }

    // ---- write_line appends one formatted line ----

    #[test]
    fn write_line_appends_one_formatted_line_verbatim() {
        let dir = unique_temp_dir("write_one");
        let mut writer =
            SyncRunFileWriter::open(&dir, "run1").expect("open on real dir returns Some");
        writer.write_line(1, 4, r"C:\Users\alice\workspaces\FYGame\A.uasset");
        writer.write_line(2, 4, r"C:\Users\alice\workspaces\FYGame\B.uasset");
        writer.flush();
        drop(writer);

        let content =
            fs::read_to_string(dir.join("sync-run1.log")).expect("read per-run file");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2, "expected 2 lines, got {lines:?}");
        // Each line: {current}/{total} {redacted}. Username masked via <PATH>.
        assert!(lines[0].starts_with("1/4 "), "line 0 prefix: {}", lines[0]);
        assert!(lines[1].starts_with("2/4 "), "line 1 prefix: {}", lines[1]);
        assert!(
            !content.contains("alice"),
            "raw username must not be persisted: {content:?}"
        );
        cleanup(&dir);
    }

    // ---- flush / Drop does not panic ----

    #[test]
    fn flush_and_drop_do_not_panic() {
        let dir = unique_temp_dir("drop");
        let mut writer =
            SyncRunFileWriter::open(&dir, "run_drop").expect("open on real dir returns Some");
        writer.write_line(7, 9, r"C:\Users\alice\workspaces\FYGame\C.uasset");
        writer.flush();
        // Drop after explicit flush — must not panic.
        drop(writer);

        // Re-open a second writer to the SAME path, then drop WITHOUT a flush
        // — the Drop impl must still do a final best-effort flush (no panic).
        let mut writer2 =
            SyncRunFileWriter::open(&dir, "run_drop2").expect("open on real dir returns Some");
        writer2.write_line(1, 1, r"C:\Users\alice\workspaces\FYGame\D.uasset");
        drop(writer2);
        cleanup(&dir);
    }

    // ---- prune: keep N newest, no-op on empty / missing dir ----

    #[test]
    fn prune_keeps_n_newest_by_mtime() {
        let dir = unique_temp_dir("prune_keep");
        // Pre-create 5 sync-*.log files with DISTINGUISHABLE, increasing mtimes
        // (oldest AAAA -> newest EEEE). set_times gives deterministic ordering
        // regardless of filesystem mtime resolution.
        let names = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"];
        let base = SystemTime::UNIX_EPOCH;
        for (i, n) in names.iter().enumerate() {
            let path = dir.join(format!("sync-{n}.log"));
            fs::write(&path, b"x").expect("write fixture file");
            // Oldest (AAAA) gets the smallest offset; newest (EEEE) largest.
            set_mtime(&path, base + std::time::Duration::from_secs(10 + i as u64));
        }

        prune_sync_run_logs(&dir, 3);

        // Keep the 3 newest (CCCC, DDDD, EEEE); prune the 2 oldest (AAAA, BBBB).
        assert!(
            !dir.join("sync-AAAA.log").exists(),
            "oldest (AAAA) should be pruned"
        );
        assert!(
            !dir.join("sync-BBBB.log").exists(),
            "second-oldest (BBBB) should be pruned"
        );
        assert!(dir.join("sync-CCCC.log").exists(), "CCCC should survive");
        assert!(dir.join("sync-DDDD.log").exists(), "DDDD should survive");
        assert!(dir.join("sync-EEEE.log").exists(), "EEEE should survive");
        cleanup(&dir);
    }

    #[test]
    fn prune_on_dir_with_no_sync_logs_is_noop() {
        let dir = unique_temp_dir("prune_empty");
        // Add a non-matching file so the dir is non-empty but has no sync-*.log.
        fs::write(dir.join("p4-updater.log"), b"x").unwrap();
        fs::write(dir.join("other.txt"), b"x").unwrap();

        prune_sync_run_logs(&dir, 3);

        // Non-matching files survive untouched.
        assert!(dir.join("p4-updater.log").exists(), "non-matching file must survive");
        assert!(dir.join("other.txt").exists(), "non-matching file must survive");
        cleanup(&dir);
    }

    #[test]
    fn prune_on_nonexistent_dir_is_noop() {
        let missing = std::env::temp_dir().join(format!(
            "p4_test_sync_run_log_prune_missing_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Must not panic on a missing dir.
        prune_sync_run_logs(&missing, 3);
    }

    #[test]
    fn open_invokes_prune_so_older_runs_are_reclaimed_at_open() {
        // Integration: pre-create 5 sync-*.log fixtures, then open a 6th writer
        // (run_id "NEWEST"). open() prunes to KEEP=3 BEFORE creating the new
        // file, so after open the dir should contain the new file + the 2
        // newest pre-existing fixtures (3 total) — wait, KEEP=3 includes the
        // new file only if it pre-existed; prune runs BEFORE create, so the
        // 3 newest fixtures survive + the new file = 4 files. Verify the 2
        // OLDEST fixtures are gone and the NEWEST file exists.
        let dir = unique_temp_dir("open_prunes");
        let names = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"];
        let base = SystemTime::UNIX_EPOCH;
        for (i, n) in names.iter().enumerate() {
            let path = dir.join(format!("sync-{n}.log"));
            fs::write(&path, b"x").unwrap();
            set_mtime(&path, base + std::time::Duration::from_secs(10 + i as u64));
        }

        let writer = SyncRunFileWriter::open(&dir, "NEWEST").expect("open returns Some");
        drop(writer);

        // 2 oldest fixtures pruned; 3 newest fixtures survive; NEWEST file created.
        assert!(!dir.join("sync-AAAA.log").exists(), "AAAA should be pruned at open");
        assert!(!dir.join("sync-BBBB.log").exists(), "BBBB should be pruned at open");
        assert!(dir.join("sync-CCCC.log").exists());
        assert!(dir.join("sync-DDDD.log").exists());
        assert!(dir.join("sync-EEEE.log").exists());
        assert!(dir.join("sync-NEWEST.log").exists());
        cleanup(&dir);
    }
}
