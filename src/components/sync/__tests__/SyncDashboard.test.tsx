import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IdlePanel } from "@/components/sync/IdlePanel";
import { ErrorPanel } from "@/components/sync/ErrorPanel";
import { StepIndicator } from "@/components/sync/StepIndicator";
import { SyncDashboard } from "@/components/sync/SyncDashboard";

import type { SyncStep, WorkspaceConfig, GitBranchInfo, HistoryRecord } from "@/lib/types";

describe("IdlePanel", () => {
  it("shows Ready to sync when no last result", () => {
    render(
      <IdlePanel
        lastSyncResult={null}
        hasWorkspace={true}
        targetCl=""
        onTargetClChange={() => {}}
        onStartSync={() => {}}
        onGitPull={() => {}}
        isBusy={false}
        gitBranchInfo={null}
        gitBranchLoading={false}
        behindInfo={null}
        behindLoading={false}
      />,
    );
    expect(screen.getByText("Ready to sync")).toBeDefined();
  });

  it("disables Start Sync when no workspace", () => {
    render(
      <IdlePanel
        lastSyncResult={null}
        hasWorkspace={false}
        targetCl=""
        onTargetClChange={() => {}}
        onStartSync={() => {}}
        onGitPull={() => {}}
        isBusy={false}
        gitBranchInfo={null}
        gitBranchLoading={false}
        behindInfo={null}
        behindLoading={false}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /start sync/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows last sync result when present", () => {
    render(
      <IdlePanel
        lastSyncResult={{ cl: "12345", fileCount: 42, time: "today" }}
        hasWorkspace={true}
        targetCl=""
        onTargetClChange={() => {}}
        onStartSync={() => {}}
        onGitPull={() => {}}
        isBusy={false}
        gitBranchInfo={null}
        gitBranchLoading={false}
        behindInfo={null}
        behindLoading={false}
      />,
    );
    expect(screen.getByText(/12345/)).toBeDefined();
    expect(screen.getByText(/42 files/)).toBeDefined();
  });
});

describe("ErrorPanel", () => {
  it("shows error message", () => {
    render(
      <ErrorPanel
        step="p4_sync"
        error="Connection refused"
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Sync Failed")).toBeDefined();
    expect(screen.getByText(/p4_sync failed/)).toBeDefined();
    expect(screen.getByText("Retry Step")).toBeDefined();
    expect(screen.getByText("Dismiss Error")).toBeDefined();
  });
});

describe("StepIndicator", () => {
  it("renders all 4 steps", () => {
    const statuses = {
      closeUe: "pending" as const,
      cleanDevDir: "pending" as const,
      p4Sync: "pending" as const,
      genProject: "pending" as const,
    };
    render(<StepIndicator stepStatuses={statuses} />);
    expect(screen.getByText("Closing UE Editor")).toBeDefined();
    expect(screen.getByText("Cleaning Dev Directory")).toBeDefined();
    expect(screen.getByText("Syncing Files")).toBeDefined();
    expect(screen.getByText("Generating Project Files")).toBeDefined();
  });
});

describe("SyncDashboard", () => {
  const baseProps = {
    stepStatuses: {
      closeUe: "pending" as const,
      cleanDevDir: "pending" as const,
      p4Sync: "pending" as const,
      genProject: "pending" as const,
    },
    progress: { current: 0, total: 0, currentFile: "" },
    logLines: [] as string[],
    currentStep: null as SyncStep | null,
    errorInfo: null as { step: string; error: string } | null,
    lastSyncResult: null as { cl: string | null; fileCount: number; time: string } | null,
    selectedWorkspace: null as WorkspaceConfig | null,
    targetCl: "",
    onTargetClChange: (_cl: string) => {},
    stepDescriptions: {
      closeUe: null as string | null,
      cleanDevDir: null as string | null,
      p4Sync: null as string | null,
      genProject: null as string | null,
    },
    onStartSync: () => {},
    onStopSync: () => {},
    onRetryStep: (_step: string) => {},
    onDismissError: () => {},
    onRollback: () => {},
    historyRecords: [] as HistoryRecord[],
    historyLoading: false,
    historyRollingBack: false,
    gitState: "idle" as const,
    gitLogLines: [] as string[],
    gitErrorInfo: null as { error: string } | null,
    onGitPull: () => {},
    onStopGitPull: () => {},
    onDismissGitResult: () => {},
    gitBranchInfo: null as GitBranchInfo | null,
    gitBranchLoading: false,
    behindInfo: null,
    behindLoading: false,
  };

  it("renders IdlePanel when idle", () => {
    render(<SyncDashboard {...baseProps} syncState="idle" />);
    expect(screen.getByText("Ready to sync")).toBeDefined();
  });

  it("renders ErrorPanel when error", () => {
    render(
      <SyncDashboard
        {...baseProps}
        syncState="error"
        errorInfo={{ step: "p4_sync", error: "Network error" }}
      />,
    );
    expect(screen.getByText("Sync Failed")).toBeDefined();
  });

  it("renders RunningPanel when running", () => {
    render(
      <SyncDashboard
        {...baseProps}
        syncState="running"
      />,
    );
    expect(screen.getByText("Cancel Sync")).toBeDefined();
    // quick-260707-kdf: prep must NOT leak into the null-step / non-p4Sync path.
    expect(screen.queryByText(/正在准备/)).toBeNull();
  });
});

// quick-260707-kdf: prep state — indeterminate bar + "正在准备… 将更新 N 个文件"
// between p4Sync start and the first byte sample (or the 20s fallback).
describe("RunningPanel prep state", () => {
  const baseProps = {
    stepStatuses: {
      closeUe: "pending" as const,
      cleanDevDir: "pending" as const,
      p4Sync: "pending" as const,
      genProject: "pending" as const,
    },
    logLines: [] as string[],
    currentStep: null as SyncStep | null,
    errorInfo: null as { step: string; error: string } | null,
    lastSyncResult: null as { cl: string | null; fileCount: number; time: string } | null,
    selectedWorkspace: null as WorkspaceConfig | null,
    targetCl: "",
    onTargetClChange: (_cl: string) => {},
    stepDescriptions: {
      closeUe: null as string | null,
      cleanDevDir: null as string | null,
      p4Sync: null as string | null,
      genProject: null as string | null,
    },
    onStartSync: () => {},
    onStopSync: () => {},
    onRetryStep: (_step: string) => {},
    onDismissError: () => {},
    onRollback: () => {},
    historyRecords: [] as HistoryRecord[],
    historyLoading: false,
    historyRollingBack: false,
    gitState: "idle" as const,
    gitLogLines: [] as string[],
    gitErrorInfo: null as { error: string } | null,
    onGitPull: () => {},
    onStopGitPull: () => {},
    onDismissGitResult: () => {},
    gitBranchInfo: null as GitBranchInfo | null,
    gitBranchLoading: false,
    behindInfo: null,
    behindLoading: false,
  };

  it("Test A: shows prep label during p4Sync with no byte signal (under 20s)", () => {
    // Spread-from-variable avoids TS excess-property checks on the byte fields
    // (SyncDashboard.progress is narrowly typed {current,total,currentFile};
    // App.tsx passes a wider object at runtime — structural typing admits it).
    const progress = {
      current: 50000,
      total: 164038,
      currentFile: "//FY_Depot/FYGame/Content/SomeFile.uasset",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    render(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    // Prep label present (with the total file count interpolated).
    expect(screen.getByText(/正在准备.*164038/)).toBeDefined();
    // Count-bar main line NOT rendered as the primary line.
    expect(screen.queryByText("50000/164038 files")).toBeNull();
  });

  it("Test C: byte bar takes priority over prep when byte signal arrives", () => {
    const progress = {
      current: 50000,
      total: 164038,
      currentFile: "",
      bytesDone: 300_000_000,
      bytesTotal: 4_000_000_000,
      bytesRate: 45_000_000,
    };
    render(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    // Prep cleared by the byte signal.
    expect(screen.queryByText(/正在准备/)).toBeNull();
    // Byte-formatted main line present (GB scale — exact text owned by formatBytes).
    expect(screen.getByText(/GB|MB/)).toBeDefined();
  });
});
