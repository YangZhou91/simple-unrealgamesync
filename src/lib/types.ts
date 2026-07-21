export interface WorkspaceConfig {
  id: string;
  name: string;
  projectDir: string;
  rootPath: string;
  p4Client: string;
  p4User: string;
  lastSyncCl: string | null;
  lastSyncTime: string | null;
  lastSyncFileCount: number | null;
  parallelThreads: number;
  exclusions: string[];
  intervalMinutes: number;
}

export interface P4BehindInfo {
  behind: number;
}

// quick-260713-s44: workspace-health audit types (read-only p4 reconcile + where + resolve)
// 5 categories: unmapped / missing-on-disk / not-in-depot / differs / needs-resolve.
// The 5th (needs-resolve) is surfaced by `p4 resolve -n` — files left in a
// conflict-pending state after a sync (blocker, more severe than differs).
export type WorkspaceHealthCategory =
  | "unmapped"
  | "missing-on-disk"
  | "not-in-depot"
  | "differs"
  | "needs-resolve";

export interface WorkspaceHealthCategoryGroup {
  category: WorkspaceHealthCategory;
  count: number;
  paths: string[];
}

export interface WorkspaceHealthReport {
  categories: WorkspaceHealthCategoryGroup[];
  stream: string | null;
}

/**
 * Severity of an aggregated `WarningEntry`. Mirrors the Rust
 * `WarningSeverity` serde-renamed lowercase wire strings (`"warning"` /
 * `"error"`) at src-tauri/src/models/sync_event.rs:10-16.
 *
 * Phase 13 (WARN-15..AGG-20) → Phase 14 (SUMM-21..23) wire shape.
 */
export type WarningSeverity = "warning" | "error";

/**
 * One aggregated warning row carried on `SyncEvent.syncCompleted.warnings`.
 * Mirrors the 4-field Rust struct at src-tauri/src/models/sync_event.rs:34-41
 * EXACTLY — field names, types, order (`rename_all = "camelCase"`; `u64` →
 * `number`). No extra fields (no `kind`/`id`), no missing fields.
 *
 * - `severity`: Warning or Error (drives the severity-grouped UI)
 * - `path`: depot/local path, RAW (redact() no-ops on `//FY_Depot` / `D:\FYDepot`;
 *   local-diagnosis only, do-not-distribute). Empty-string sentinel for
 *   pathless patterns like `Library file missing.`
 * - `message`: first-seen severity-stripped line
 * - `count`: total occurrences across the `(path, severity)` bucket
 */
export interface WarningEntry {
  severity: WarningSeverity;
  path: string;
  message: string;
  count: number;
}

export type SyncEvent =
  | { event: "stepStarted"; data: { step: string; description: string } }
  | { event: "stepCompleted"; data: { step: string; success: boolean } }
  | { event: "progress"; data: { current: number; total: number; currentFile: string; bytesDone?: number | null; bytesTotal?: number | null; bytesRate?: number | null } }
  | { event: "logLine"; data: { line: string; stream: string } }
  /** Batched log lines — reduces IPC call count from ~226K individual sends to ~1130
   *  batch sends for a typical 226K-file sync. Frontend appends all lines at once. */
  | { event: "logBatch"; data: { lines: string[]; stream: string } }
  | { event: "syncCompleted"; data: { changelist: string | null; filesSynced: number; warnings: WarningEntry[] } }
  | { event: "syncFailed"; data: { step: string; error: string } }
  | { event: "syncCancelled"; data: { step: string } };

export type SyncStep = "closeUe" | "cleanDevDir" | "p4Sync" | "genProject";
export type SyncState = "idle" | "running" | "error" | "cancelled";
export type GitState = "idle" | "running" | "success" | "error";

export interface GitBranchInfo {
  branch: string;
  ahead: number;
  behind: number;
  remote: string;
}
export type StepStatus = "pending" | "active" | "completed" | "failed" | "skipped";

export interface StepInfo {
  step: SyncStep;
  status: StepStatus;
  label: string;
}

export const STEP_LABELS: Record<SyncStep, string> = {
  closeUe: "Closing UE Editor",
  cleanDevDir: "Cleaning Dev Directory",
  p4Sync: "Syncing Files",
  genProject: "Generating Project Files",
};

export const STEP_ORDER: SyncStep[] = ["closeUe", "cleanDevDir", "p4Sync", "genProject"];

export interface HistoryRecord {
  changelist: string;
  timestamp: string;
  fileCount: number;
  workspaceId: string;
  durationMs?: number;
}

export interface ChangelistEntry {
  number: string;
  date: string;
  user: string;
  client: string;
  description: string;
}
