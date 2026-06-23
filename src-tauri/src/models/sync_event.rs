use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
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
    },
    SyncFailed {
        step: String,
        error: String,
    },
    SyncCancelled {
        step: String,
    },
}
