import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import type { WorkspaceConfig, SyncEvent, HistoryRecord, ChangelistEntry, GitBranchInfo, P4BehindInfo } from "@/lib/types";

export function addWorkspace(
  name: string,
  rootPath: string,
  projectDir: string,
  p4Client: string,
  p4User: string,
): Promise<WorkspaceConfig> {
  return invoke("add_workspace", { name, rootPath, projectDir, p4Client, p4User });
}

export function getWorkspaces(): Promise<WorkspaceConfig[]> {
  return invoke("get_workspaces");
}

export function deleteWorkspace(id: string): Promise<void> {
  return invoke("delete_workspace", { id });
}

export function switchWorkspace(id: string): Promise<WorkspaceConfig> {
  return invoke("switch_workspace", { id });
}

export function startSync(
  workspaceId: string,
  onEvent: Channel<SyncEvent>,
  targetCl?: string,
): Promise<void> {
  return invoke("start_sync", {
    workspaceId,
    onEvent,
    targetCl: targetCl || null,
  });
}

export function stopSync(): Promise<void> {
  return invoke("stop_sync");
}

export function isSyncRunning(): Promise<boolean> {
  return invoke("is_sync_running");
}

export function getCurrentCl(workspaceId: string): Promise<string | null> {
  return invoke("get_current_cl", { workspaceId });
}

export function retryStep(
  workspaceId: string,
  step: string,
  onEvent: Channel<SyncEvent>,
  targetCl?: string,
): Promise<void> {
  return invoke("retry_step", {
    workspaceId,
    step,
    onEvent,
    targetCl: targetCl || null,
  });
}

export function updateWorkspaceSettings(
  id: string,
  parallelThreads: number,
  exclusions: string[],
  intervalMinutes: number,
): Promise<WorkspaceConfig> {
  return invoke("update_workspace_settings", {
    workspaceId: id,
    parallelThreads,
    exclusions,
    intervalMinutes,
  });
}

export function checkSyncBehind(workspaceId: string): Promise<P4BehindInfo> {
  return invoke("check_sync_behind", { workspaceId });
}

export function cancelSyncBehind(): Promise<void> {
  return invoke("cancel_sync_behind");
}

export function validateExclusions(
  rootPath: string,
  projectDir: string,
  exclusions: string[],
): Promise<string[]> {
  return invoke("validate_exclusions", { rootPath, projectDir, exclusions });
}

export function getHistory(workspaceId: string): Promise<HistoryRecord[]> {
  return invoke("get_history", { workspaceId });
}

export function getChangelists(
  workspaceId: string,
  batchSize?: number,
  afterCl?: string,
): Promise<ChangelistEntry[]> {
  return invoke("get_changelists", {
    workspaceId,
    batchSize: batchSize ?? null,
    afterCl: afterCl ?? null,
  });
}

export function startRollback(
  workspaceId: string,
  targetCl: string,
  onEvent: Channel<SyncEvent>,
): Promise<void> {
  return invoke("start_rollback", { workspaceId, targetCl, onEvent });
}

export function gitPull(
  workspaceId: string,
  onEvent: Channel<SyncEvent>,
): Promise<void> {
  return invoke("git_pull", { workspaceId, onEvent });
}

export function gitStatus(workspaceId: string): Promise<GitBranchInfo> {
  return invoke("git_status", { workspaceId });
}

export function stopGitPull(): Promise<void> {
  return invoke("stop_git_pull");
}

// HOTUI-14 (Phase 12 D-06/D-07/D-08): operator-facing log affordances.
// All three resolve the log path Rust-side; the JS only fires the command and
// (for exportLog) shows the returned destination path. The save dialog inside
// exportLog is invoked Rust-side — the JS does NOT call @tauri-apps/plugin-dialog.
export function openLogsFolder(): Promise<void> {
  return invoke("open_logs_folder");
}

export function exportLog(): Promise<string> {
  return invoke("export_log");
}

export function getLogPath(): Promise<string> {
  return invoke("get_log_path");
}
