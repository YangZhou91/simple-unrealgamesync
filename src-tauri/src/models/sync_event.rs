use serde::{Deserialize, Serialize};

/// Two-valued severity for an aggregated `WarningEntry`. Serializes to the
/// lowercase wire strings `"warning"` / `"error"` so Phase 14 can hand-write a
/// matching TypeScript union `"warning" | "error"` (PATTERNS.md Pattern A).
///
/// Eq + Copy + Hash are load-bearing: the `WarningCollector` dedup key is
/// `(String, WarningSeverity)` (D-01) and `Copy` lets the classify match in
/// `ingest()` bind by value. `Hash` is required for HashMap key.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
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
///   - `path`: raw depot/local path for local display; empty string sentinel for pathless
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
        // Phase 18 (WIRE-02 / D-03): machine-key sub-step token for Phase
        // 19's total (step, subStep) -> dictionary-label mapping. Serialized
        // as `subStep` via the enum's rename_all_fields = "camelCase". None
        // allowed by the type but populated at every send site per D-01
        // (11 sites: 6 sync_orchestrator + 5 git_service; frozen by
        // known_sub_steps() + its token-set test). Plain machine token from
        // a closed vocabulary — no path/identity, no redaction needed
        // (mirrors `step`'s treatment). House style serializes null when
        // None (the Progress.phase precedent) — deliberately NO
        // skip_serializing_if.
        sub_step: Option<String>,
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
        // Phase 15 (GPULL-24): git `%` signal. None for every p4Sync emit.
        // Serialized as `percent` via the enum's rename_all_fields =
        // "camelCase" (L46).
        percent: Option<u8>,
        // Phase 15 (WR-01 fix): git transfer phase LABEL for the bar. None for
        // every p4Sync emit (p4Sync renders no git label); Some("Receiving
        // objects"/"Compressing objects"/"Resolving deltas") for the git drain.
        // Serialized as `phase` via the enum's rename_all_fields = "camelCase".
        // Plain display string — no path/identity, no redaction needed (mirrors
        // the `percent` field's redaction rationale).
        phase: Option<String>,
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
            SyncEvent::StepStarted {
                step,
                description,
                sub_step,
            } => f
                .debug_struct("StepStarted")
                .field("step", &step)
                .field("description", &description)
                // Phase 18 (WIRE-02 / D-03): plain machine token from a
                // closed vocabulary, no path/identity (mirrors step's
                // no-redaction treatment).
                .field("sub_step", &sub_step)
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
                percent,
                phase,
            } => f
                .debug_struct("Progress")
                .field("current", &current)
                .field("total", &total)
                .field("current_file", &"<redacted>")
                .field("bytes_done", &bytes_done)
                .field("bytes_total", &bytes_total)
                .field("bytes_rate", &bytes_rate)
                // Phase 15 (GPULL-24): plain value, no redaction (u8 carries
                // no path/identity).
                .field("percent", &percent)
                // Phase 15 (WR-01 fix): plain display label string, no
                // path/identity (mirrors percent's redaction rationale).
                .field("phase", &phase)
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
                // sentinel. Keep raw local-display paths out of Debug output
                // independently of the persistent logger's redaction filter.
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

    /// Phase 18 (WIRE-02 / D-03, decision "table-above"): the FROZEN
    /// (step, sub_step) token vocabulary every StepStarted send site emits.
    /// Phase 19 keys its dictionary labels as steps.<step>.<sub_step> on this
    /// exact set — a wording-level rename at any site (or here) MUST fail the
    /// frozen-vocabulary test below loudly instead of silently breaking the
    /// (step, subStep) -> label mapping.
    ///
    /// 11 send sites project onto 10 pairs (closeUe and closeExcel share
    /// `check` — the step field disambiguates; genProject shares `gen` across
    /// sync_orchestrator.rs and git_service.rs — same label).
    pub fn known_sub_steps() -> &'static [(&'static str, &'static str)] {
        &[
            ("closeUe", "check"),
            ("closeExcel", "check"),
            ("cleanDevDir", "clean"),
            ("p4Sync", "toCl"),
            ("p4Sync", "all"),
            ("forceSync", "force"),
            ("genProject", "gen"),
            ("gitPull", "run"),
            ("gitPull", "stash"),
            ("gitPull", "preNetwork"),
            ("gitPull", "restoreStash"),
        ]
    }

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
            current_file: r"C:\Users\alice\ExampleGame\Content\Maps\Foo.uasset".into(),
            bytes_done: None,
            bytes_total: None,
            bytes_rate: None,
            percent: None,
            phase: None,
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
        // The manual Debug arm replaces the WHOLE warnings Vec with a count sentinel
        // so {:?} never leaks a raw path or the "alice" canary.
        let event = SyncEvent::SyncCompleted {
            changelist: Some("12345".into()),
            files_synced: 10,
            warnings: vec![WarningEntry {
                severity: WarningSeverity::Warning,
                path: r"//Example_Depot/ExampleGame/Content/Maps/alice.umap".into(),
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
            !dbg.contains("Example_Depot"),
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

    // ---- Phase 15 (WR-01 fix): Progress.phase carries the git phase label ----

    #[test]
    fn progress_phase_serializes_camel_case_and_round_trips() {
        // The new `phase` field MUST serialize as `phase` (enum's
        // rename_all_fields = "camelCase") and carry the git display label.
        // p4Sync emitters leave it None; the git drain sends Some(label).
        let event = SyncEvent::Progress {
            current: 0,
            total: 0,
            current_file: String::new(),
            bytes_done: None,
            bytes_total: None,
            bytes_rate: None,
            percent: Some(67),
            phase: Some("Resolving deltas".to_string()),
        };
        let json = serde_json::to_string(&event).expect("serialize Progress");
        assert!(
            json.contains("\"phase\":\"Resolving deltas\""),
            "JSON missing camelCase `phase` field with label: {json}"
        );
        assert!(
            json.contains("\"percent\":67"),
            "JSON missing `percent`: {json}"
        );
        // None serializes as null — the p4Sync path.
        let none_event = SyncEvent::Progress {
            current: 0,
            total: 0,
            current_file: String::new(),
            bytes_done: None,
            bytes_total: None,
            bytes_rate: None,
            percent: None,
            phase: None,
        };
        let none_json = serde_json::to_string(&none_event).expect("serialize Progress None");
        assert!(
            none_json.contains("\"phase\":null"),
            "p4Sync Progress must serialize phase as null: {none_json}"
        );
    }

    // ---- Phase 18 (WIRE-02 / D-03): StepStarted.sub_step machine token ----

    #[test]
    fn step_started_sub_step_serializes_camel_case_and_null() {
        // The new `sub_step` field MUST serialize as `subStep` (the enum's
        // rename_all_fields = "camelCase") carrying the machine token, with
        // the variant tag unchanged. None serializes as `null` — the SyncEvent
        // house style for optional fields (the Progress.phase precedent
        // asserts ":null"; deliberately NO skip_serializing_if).
        let event = SyncEvent::StepStarted {
            step: "gitPull".to_string(),
            description: "Saving local changes…".to_string(),
            sub_step: Some("stash".to_string()),
        };
        let json = serde_json::to_string(&event).expect("serialize StepStarted");
        assert!(
            json.contains("\"event\":\"stepStarted\""),
            "variant tag must stay stepStarted: {json}"
        );
        assert!(
            json.contains("\"subStep\":\"stash\""),
            "JSON missing camelCase `subStep` with the machine token: {json}"
        );
        // None serializes as null — house style (Progress.phase precedent).
        let none_event = SyncEvent::StepStarted {
            step: "gitPull".to_string(),
            description: "Saving local changes…".to_string(),
            sub_step: None,
        };
        let none_json =
            serde_json::to_string(&none_event).expect("serialize StepStarted sub_step None");
        assert!(
            none_json.contains("\"subStep\":null"),
            "StepStarted must serialize subStep as null when None: {none_json}"
        );
    }

    #[test]
    fn step_started_sub_step_debug_fields_machine_token() {
        // The manual Debug arm (WIRE-02 / D-05: updated in the SAME commit as
        // the field) MUST bind and field `sub_step` as a plain value — the
        // closed token set carries no path/identity, mirroring `step`'s
        // no-redaction treatment. The None counterpart must keep step +
        // description (no over-masking regression).
        let with_token = SyncEvent::StepStarted {
            step: "gitPull".to_string(),
            description: "Saving local changes…".to_string(),
            sub_step: Some("stash".to_string()),
        };
        let dbg = format!("{:?}", with_token);
        assert!(
            dbg.contains("StepStarted"),
            "Debug must still identify the variant: {dbg}"
        );
        assert!(
            dbg.contains("sub_step"),
            "Debug must field sub_step by name: {dbg}"
        );
        assert!(
            dbg.contains("stash"),
            "Debug must show the machine token value: {dbg}"
        );
        let none_event = SyncEvent::StepStarted {
            step: "gitPull".to_string(),
            description: "Saving local changes…".to_string(),
            sub_step: None,
        };
        let none_dbg = format!("{:?}", none_event);
        assert!(
            none_dbg.contains("gitPull"),
            "Debug must keep step when sub_step is None: {none_dbg}"
        );
        assert!(
            none_dbg.contains("Saving local changes"),
            "Debug must keep description when sub_step is None: {none_dbg}"
        );
    }

    #[test]
    fn known_sub_steps_vocabulary_is_frozen() {
        // Phase 18 (WIRE-02 / D-03): the token set is a one-way wire contract.
        // This test freezes the EXACT 11-pair vocabulary (10 distinct tokens —
        // closeUe/closeExcel share `check`, genProject shares `gen` across both
        // service files). Any addition, removal, reordering-as-set-change, or
        // wording-level rename fails here loudly so Phase 19's
        // (step, subStep) -> label mapping can never silently drift.
        let frozen: Vec<(&str, &str)> = vec![
            ("closeUe", "check"),
            ("closeExcel", "check"),
            ("cleanDevDir", "clean"),
            ("p4Sync", "toCl"),
            ("p4Sync", "all"),
            ("forceSync", "force"),
            ("genProject", "gen"),
            ("gitPull", "run"),
            ("gitPull", "stash"),
            ("gitPull", "preNetwork"),
            ("gitPull", "restoreStash"),
        ];
        let live = known_sub_steps();
        assert_eq!(
            live.len(),
            frozen.len(),
            "known_sub_steps() changed size — vocabulary frozen by D-03: {live:?}"
        );
        for pair in &frozen {
            assert!(
                live.contains(pair),
                "known_sub_steps() lost {pair:?} — vocabulary frozen by D-03: {live:?}"
            );
        }
        for pair in live {
            assert!(
                frozen.contains(pair),
                "known_sub_steps() gained {pair:?} — vocabulary frozen by D-03: {frozen:?}"
            );
        }
        // Every token is a stable camelCase machine token — no spaces, no
        // display sentences, no localized text (prohibition P-1).
        for (step, token) in live {
            assert!(
                !token.contains(' ') && !step.contains(' '),
                "tokens must be machine tokens, not display strings: {step:?}/{token:?}"
            );
        }
    }
}
