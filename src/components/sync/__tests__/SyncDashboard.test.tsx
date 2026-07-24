import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { info } from "@tauri-apps/plugin-log";
import { IdlePanel } from "@/components/sync/IdlePanel";
import { ErrorPanel } from "@/components/sync/ErrorPanel";
import { StepIndicator } from "@/components/sync/StepIndicator";
import { SyncDashboard } from "@/components/sync/SyncDashboard";

import type { SyncStep, WorkspaceConfig, GitBranchInfo, HistoryRecord } from "@/lib/types";

// quick-260710-sxf: mock the log plugin so RunningPanel's render-state effect
// info() calls are observable. The factory returns a thenable so the effect's
// `.catch(() => {})` is safe (a bare vi.fn() returns undefined → `.catch`
// throws). vitest hoists vi.mock above imports, so `import { info }` above
// resolves to this mock. Only `info` is imported by the rendered tree.
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(() => Promise.resolve()),
}));

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
  it("renders all 5 steps", () => {
    const statuses = {
      closeUe: "pending" as const,
      closeExcel: "pending" as const,
      cleanDevDir: "pending" as const,
      p4Sync: "pending" as const,
      genProject: "pending" as const,
    };
    render(<StepIndicator stepStatuses={statuses} />);
    expect(screen.getByText("Closing UE Editor")).toBeDefined();
    expect(screen.getByText("Closing Excel")).toBeDefined();
    expect(screen.getByText("Cleaning Dev Directory")).toBeDefined();
    expect(screen.getByText("Syncing Files")).toBeDefined();
    expect(screen.getByText("Generating Project Files")).toBeDefined();
  });
});

describe("SyncDashboard", () => {
  const baseProps = {
    stepStatuses: {
      closeUe: "pending" as const,
      closeExcel: "pending" as const,
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
      closeExcel: null as string | null,
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
      closeExcel: "pending" as const,
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
      closeExcel: null as string | null,
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

// quick-260707-t93: p4SyncOverrun must NOT flip indeterminate when a byte
// signal is live — otherwise the byte bar gets hidden during the post-overrun
// tail (p4 stdout is front-loaded, so count overruns ~13s in while bytes are
// still actively being written for ~5m44s).
describe("RunningPanel p4SyncOverrun byte-bar priority", () => {
  const baseProps = {
    stepStatuses: {
      closeUe: "pending" as const,
      closeExcel: "pending" as const,
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
      closeExcel: null as string | null,
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

  it("Test D: byte bar stays visible when count overruns AND byte signal is live", () => {
    // Spread-from-variable avoids TS excess-property checks on the byte fields
    // (SyncDashboard.progress is narrowly typed {current,total,currentFile}).
    const progress = {
      current: 13660,
      total: 13657,
      currentFile: "",
      bytesDone: 1_454_433_303,
      bytesTotal: 36_600_000_000,
      bytesRate: 76_327_744,
    };
    render(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    // Byte-formatted main line present as the PRIMARY line (ProgressSection
    // formatBytes renders "X.X GB / Y.Y GB · Z.Z MB/s" in the text-foreground
    // main span). The secondary muted span renders fileText; the primary span
    // must be the byte bar, not the indeterminate "13657+ files…" label.
    const primaryLine = screen.getByText(/\d+\.\d+ GB \/ \d+\.\d+ GB/);
    expect(primaryLine).toBeDefined();
    expect(primaryLine.className).toContain("text-foreground");
    expect(primaryLine.className).not.toContain("text-xs");
    // Sanity: when count overruns, fileText is "13657+ files…" and renders as
    // the SECONDARY muted line under the byte bar (showByteBar branch). That
    // secondary line is intentional UI, NOT the indeterminate label.
    expect(primaryLine.textContent).not.toMatch(/13657\+ files/);
  });

  it("Test E: falls back to indeterminate overrun label when count overruns with no byte signal", () => {
    const progress = {
      current: 13660,
      total: 13657,
      currentFile: "",
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
    // Legacy "{total}+ files…" indeterminate fallback preserved.
    expect(screen.getByText(/13657\+ files/)).toBeDefined();
  });
});

// quick-260710-sxf: render-state log — RunningPanel emits a throttled `[ui]
// render` line recording the displayed progress MODE (byteBar/countBar/prep/
// indeterminate) so it is reconstructable from the app log. The mode is otherwise
// un-logged (only prep transitions, count, and the byte signal are). Mirrors
// ProgressSection's render priority (prep > indeterminate > byteBar > countBar).
describe("RunningPanel render-state log (quick-260710-sxf)", () => {
  const baseProps = {
    stepStatuses: {
      closeUe: "pending" as const,
      closeExcel: "pending" as const,
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
      closeExcel: null as string | null,
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

  // mockClear so each test sees only its own render's info() calls (earlier
  // tests in this file also render RunningPanel → render-state effect fires).
  beforeEach(() => {
    (info as unknown as { mockClear: () => void }).mockClear();
  });

  it("emits [ui] render mode=byteBar when byte signal is live during p4Sync", async () => {
    const infoMock = info as unknown as { mock: { calls: unknown[][] } };
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
    // The render-state effect runs after mount; waitFor flushes passive effects.
    await waitFor(() => {
      const calls = infoMock.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some((s) => /\[ui\] render.*mode=byteBar/.test(s)),
      ).toBe(true);
    });
  });

  it("emits [ui] render mode=prep during p4Sync with no byte signal (under 20s)", async () => {
    const infoMock = info as unknown as { mock: { calls: unknown[][] } };
    const progress = {
      current: 50000,
      total: 164038,
      currentFile: "",
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
    await waitFor(() => {
      const calls = infoMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => /\[ui\] render.*mode=prep/.test(s))).toBe(true);
    });
  });
});
