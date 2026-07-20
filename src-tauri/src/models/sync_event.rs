use serde::{Deserialize, Serialize};

/// Two-valued severity for an aggregated `WarningEntry`. Serializes to the
/// lowercase wire strings `"warning"` / `"error"` so Phase 14 can hand-write a
/// matching TypeScript union `"warning" | "error"` (PATTERNS.md Pattern A).
///
/// Eq + Copy are load-bearing: the `WarningCollector` dedup key is
/// `(String, WarningSeverity)` (D-01) and `Copy` lets the classify match in
/// `ingest()` bind by value.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum WarningSeverity {
    #[serde(rename = "warning")]
    Warning,
    #[serde(rename = "error")]
    Error,
}

/// One aggregated warning row carried on `SyncEvent::SyncCompleted`. Mirrors
/// the `ChangelistEntry` derive shape (`models/history.rs:14-22`): Clone +
/// Debug + Serialize + Deserialize + `#[serde(rename_all = "camelCase")]` +
/// all-pub fields.
///
/// EXACTLY 4 fields per D-03 (no `kind`/category enum — YAGNI for v1.5):
///   - `severity`: Warning or Error (drives the severity-grouped UI)
///   - `path`: depot/local path, RAW (do-not-distribute; `redact()` no-ops on
///     `//FY_Depot/` + `D:\FYDepot`); empty string sentinel for pathless
///     patterns like `Library file missing.`
///   - `message`: first-seen severity-stripped line (D-02 — deterministic)
///   - `count`: total occurrences across the `(path, severity)` bucket; `u64`
///     saturates (Pitfall 5)
///
/// `Debug` on the struct itself is fine — the redaction happens at the enum
/// `SyncCompleted` arm, NOT here.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningEntry {
    pub severity: WarningSeverity,
    pub path: String,
    pub message: String,
    pub count: u64,
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum SyncEvent {
    StepStarted {
        step: String,
        description: String,
    },
    StepCompleted {
        step: String,
        success: bool,
    },
    Progress {
        current: u64,
        total: u64,
        current_file: String,
        // quick-260701-ep7: optional byte-level signal. ADDITIVE — serialized
        // as bytesDone/bytesTotal/bytesRate via the enum's rename_all_fields=
        // camelCase. None for every non-heartbeat emit; the p4Sync heartbeat
        // fills them from DiskUsageSampler + the `p4 sync -N` denominator.
        bytes_done: Option<u64>,
        bytes_total: Option<u64>,
        bytes_rate: Option<u64>,
    },
    LogLine {
        line: String,
        stream: String,
    },
    /// Batched log lines — reduces IPC call count from ~226K to ~1130 for a
    /// typical 226K-file sync. Each batch contains up to 500 lines accumulated
    /// over 200ms. Frontend appends all lines to the log buffer in one operation.
    LogBatch {
        lines: Vec<String>,
        stream: String,
    },
    SyncCompleted {
        changelist: Option<String>,
        files_synced: u64,
        // Phase 13 (WARN-15..AGG-20): aggregated p4 warning/error rows from
        // the sync + force-sync drains, deduped by (path, severity), bounded
        // to MAX_WARNINGS (500). Empty Vec when the sync was silent — Phase 14
        // renders nothing. The enum's `rename_all_fields = "camelCase"`
        // serializes this as `warnings` automatically.
        warnings: Vec<WarningEntry>,
    },
    SyncFailed {
        step: String,
        error: String,
    },
    SyncCancelled {
        step: String,
    },
}

/// Manual `Debug` for `SyncEvent` — the REDACT-06 / D-05 defense-in-depth
/// backstop for the IPC event enum.
///
/// serde's `#[serde(tag = "event", content = "data")]` is orthogonal to `Debug`
/// (research Pitfall 2): serde controls `Serialize`/`Deserialize` only, and the
/// live UI legitimately shows real `current_file` paths via serde (CONTEXT
/// "specifics" — redaction is log-file-only by SC#4 / D-07). This manual
/// `Debug` does NOT touch IPC; it masks the OBVIOUS sensitive fields for the
/// `{:?}` leak path only.
///
/// Per D-05, the format-layer `redact()` net (Wave 1) is the audited boundary.
/// This struct-level `Debug` is a pragmatic, testable backstop: it masks
/// `Progress.current_file` (file path), `LogLine.line` / `LogBatch.lines` (log
/// content), and `SyncFailed.error` (may carry a path), while keeping step
/// names / counts / stream / changelist so `Debug` remains useful.
impl std::fmt::Debug for SyncEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncEvent::StepStarted { step, description } => f
                .debug_struct("StepStarted")
                .field("step", &step)
                .field("description", &description)
                .finish(),
            SyncEvent::StepCompleted { step, success } => f
                .debug_struct("StepCompleted")
                .field("step", &step)
                .field("success", &success)
                .finish(),
            SyncEvent::Progress {
                current,
                total,
                current_file: _,
                bytes_done,
                bytes_total,
                bytes_rate,
            } => f
                .debug_struct("Progress")
                .field("current", &current)
                .field("total", &total)
                .field("current_file", &"<redacted>")
                .field("bytes_done", &bytes_done)
                .field("bytes_total", &bytes_total)
                .field("bytes_rate", &bytes_rate)
                .finish(),
            SyncEvent::LogLine { line: _, stream } => f
                .debug_struct("LogLine")
                .field("line", &"<redacted>")
                .field("stream", &stream)
                .finish(),
            SyncEvent::LogBatch { lines, stream } => f
                .debug_struct("LogBatch")
                .field("lines", &format!("<{} redacted lines>", lines.len()))
                .field("stream", &stream)
                .finish(),
            SyncEvent::SyncCompleted {
                changelist,
                files_synced,
                warnings,
            } => f
                .debug_struct("SyncCompleted")
                .field("changelist", &changelist)
                .field("files_synced", &files_synced)
                // Phase 13 REDACT-06 / D-05: replace the WHOLE Vec with a count
                // sentinel. Paths in `WarningEntry.path` are RAW (redact() at
                // utils/redact.rs:52 no-ops on this project's `//FY_Depot/` +
                // `D:\FYDepot` depots — memory redact-catalog-noops-on-project-
                // paths), so routing through redact() would leak every path.
                // Mirrors the LogBatch arm at lines 104-108.
                .field(
                    "warnings",
                    &format!("<{} warning entries redacted>", warnings.len()),
                )
                .finish(),
            SyncEvent::SyncFailed { step, .. } => f
                .debug_struct("SyncFailed")
                .field("step", &step)
                .field("error", &"<redacted>")
                .finish(),
            SyncEvent::SyncCancelled { step } => f
                .debug_struct("SyncCancelled")
                .field("step", &step)
                .finish(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SC#2: manual Debug does not leak sensitive variants (REDACT-06 / D-05) ----

    #[test]
    fn debug_does_not_leak_sensitive_variants() {
        // The format-layer redact() net is the audited boundary (Wave 1); this
        // struct-level Debug is the pragmatic backstop. It MUST mask the obvious
        // sensitive fields (current_file / LogLine.line / LogBatch.lines /
        // SyncFailed.error) so {:?} cannot leak them even before the net sees
        // the rendered string.
        let progress = SyncEvent::Progress {
            current: 1,
            total: 10,
            current_file: r"C:\Users\alice\FYGame\Content\Maps\Foo.uasset".into(),
            bytes_done: None,
            bytes_total: None,
            bytes_rate: None,
        };
        let log_line = SyncEvent::LogLine {
            line: "secret alice line".into(),
            stream: "stdout".into(),
        };
        let log_batch = SyncEvent::LogBatch {
            lines: vec!["alice a".into(), "alice b".into()],
            stream: "stderr".into(),
        };
        let sync_failed = SyncEvent::SyncFailed {
            step: "p4Sync".into(),
            error: "alice path failure".into(),
        };

        for (label, variant, variant_name) in [
            ("Progress", &progress, "Progress"),
            ("LogLine", &log_line, "LogLine"),
            ("LogBatch", &log_batch, "LogBatch"),
            ("SyncFailed", &sync_failed, "SyncFailed"),
        ] {
            let dbg = format!("{:?}", variant);
            assert!(
                !dbg.contains("alice"),
                "{label} Debug leaked username: {dbg}"
            );
            assert!(
                !dbg.contains(r"C:\Users"),
                "{label} Debug leaked path: {dbg}"
            );
            assert!(
                dbg.contains(variant_name),
                "{label} Debug must still identify the variant"
            );
        }

        // LogLine keeps `stream`; LogBatch keeps `stream` + a count.
        assert!(
            format!("{:?}", log_line).contains("stdout"),
            "LogLine Debug must keep stream"
        );
        let batch_dbg = format!("{:?}", log_batch);
        assert!(batch_dbg.contains("stderr"), "LogBatch Debug must keep stream");
        assert!(
            batch_dbg.contains("2 redacted lines"),
            "LogBatch Debug must show count: {batch_dbg}"
        );
        // SyncFailed keeps `step`.
        assert!(
            format!("{:?}", sync_failed).contains("p4Sync"),
            "SyncFailed Debug must keep step"
        );
    }

    #[test]
    fn debug_keeps_non_identity_fields() {
        // Regression: prove KEEP fields are retained (not over-masking). Step
        // names, success flag, counts, and CL numbers are non-identity.
        let step_completed = SyncEvent::StepCompleted {
            step: "p4Sync".into(),
            success: true,
        };
        let dbg = format!("{:?}", step_completed);
        assert!(dbg.contains("p4Sync"));
        assert!(dbg.contains("StepCompleted"));
        assert!(dbg.contains("true"));
    }

    // ---- Phase 13 — AGG-20 / REDACT-06 (D-05): warnings field + Debug arm ----

    #[test]
    fn test_sync_completed_serializes_warnings() {
        // The new warnings field MUST ride `SyncCompleted` and serialize
        // camelCase as `warnings` (enum's rename_all_fields), with
        // each entry's nested shape {severity, path, message, count}.
        let event = SyncEvent::SyncCompleted {
            changelist: Some("123".into()),
            files_synced: 5,
            warnings: vec![WarningEntry {
                severity: WarningSeverity::Warning,
                path: "//p".into(),
                message: "m".into(),
                count: 2,
            }],
        };
        let json = serde_json::to_string(&event).expect("serialize SyncCompleted");
        assert!(
            json.contains("\"warnings\""),
            "JSON missing camelCase `warnings` field: {json}"
        );
        assert!(
            json.contains("\"severity\":\"warning\""),
            "WarningSeverity must serialize lowercase: {json}"
        );
        assert!(
            json.contains("\"path\":\"//p\""),
            "WarningEntry.path missing: {json}"
        );
        assert!(
            json.contains("\"message\":\"m\""),
            "WarningEntry.message missing: {json}"
        );
        assert!(json.contains("\"count\":2"), "count missing: {json}");
    }

    #[test]
    fn test_debug_sync_completed_no_path_leak() {
        // RAW paths under //FY_Depot/ + D:\FYDepot are NOT masked by redact()
        // (utils/redact.rs:52 no-ops on this project's depots). The manual
        // Debug arm MUST replace the WHOLE warnings Vec with a count sentinel
        // so {:?} never leaks a raw path or the "alice" canary.
        let event = SyncEvent::SyncCompleted {
            changelist: Some("12345".into()),
            files_synced: 10,
            warnings: vec![WarningEntry {
                severity: WarningSeverity::Warning,
                path: r"//FY_Depot/FYGame/Content/Maps/alice.umap".into(),
                message: "alice no such file(s)".into(),
                count: 3,
            }],
        };
        let dbg = format!("{:?}", event);
        assert!(
            !dbg.contains("alice"),
            "SyncCompleted Debug leaked canary: {dbg}"
        );
        assert!(
            !dbg.contains("FY_Depot"),
            "SyncCompleted Debug leaked depot name: {dbg}"
        );
        assert!(
            dbg.contains("SyncCompleted"),
            "Debug must still identify the variant: {dbg}"
        );
        assert!(
            dbg.contains("1 warning entries redacted"),
            "Debug must show the count sentinel: {dbg}"
        );
    }
}
