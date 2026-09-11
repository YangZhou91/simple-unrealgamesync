import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { info } from "@tauri-apps/plugin-log";
import { IdlePanel } from "@/components/sync/IdlePanel";
import { ErrorPanel } from "@/components/sync/ErrorPanel";
import { StepIndicator } from "@/components/sync/StepIndicator";
import { SyncDashboard } from "@/components/sync/SyncDashboard";
import { makeT, renderWithI18n, useT } from "@/lib/i18n";

import type { LastSyncResult, StepStatus, SyncStep, WorkspaceConfig, GitBranchInfo, HistoryRecord } from "@/lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

// quick-260710-sxf: mock the log plugin so RunningPanel's render-state effect
// info() calls are observable. The factory returns a thenable so the effect's
// `.catch(() => {})` is safe (a bare vi.fn() returns undefined → `.catch`
// throws). vitest hoists vi.mock above imports, so `import { info }` above
// resolves to this mock. Only `info` is imported by the rendered tree.
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(() => Promise.resolve()),
}));
// react-virtuoso cannot measure in jsdom (documented Phase 14 blind spot —
// same mock as LogViewer.test.tsx): render itemContent rows directly.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: string[];
    itemContent: (index: number, line: string) => React.ReactNode;
  }) => (
    <div>
      {data.map((line, i) => (
        <div key={i}>{itemContent(i, line)}</div>
      ))}
    </div>
  ),
}));

// Phase 26 (26-03 Task 3): shared fixture for the projection-priority,
// restart-vs-retry, and raw-sibling coverage blocks.
const dashProps = {
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
  lastSyncResult: null as LastSyncResult | null,
  selectedWorkspace: null as WorkspaceConfig | null,
  targetCl: "",
  onTargetClChange: (_cl: string) => {},
  currentSubStep: null as string | null,
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

const WORKSPACE: WorkspaceConfig = {
  id: "ws-1",
  name: "FixtureWS",
  projectDir: "Proj",
  rootPath: "D:\\Fixture",
  p4Client: "fixture_client",
  p4User: "fixture_user",
  lastSyncCl: null,
  lastSyncTime: null,
  lastSyncFileCount: null,
  parallelThreads: 4,
  exclusions: [],
  intervalMinutes: 60,
};

describe("IdlePanel", () => {
  // Phase 26 (26-01): the standalone Ready-to-sync strip is gone — the
  // canonical P4 card heading is the idle marker.
  it("shows the canonical P4 card heading when no last result", () => {
    renderWithI18n(
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
    expect(screen.getByText("Perforce project")).toBeDefined();
  });

  it("disables Start Sync when no workspace", () => {
    renderWithI18n(
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
    renderWithI18n(
      <IdlePanel
        lastSyncResult={{ status: "completed", cl: "12345", fileCount: 42, epochMs: 0 }}
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
  it("shows dictionary title, failedAt with translated step label, raw error, retry, dismiss", () => {
    const t = makeT("en");
    renderWithI18n(
      <ErrorPanel
        step="p4Sync"
        error="Connection refused"
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(t("sync.error.title"))).toBeDefined();
    // failedAt chrome line interpolates the TRANSLATED label (steps.p4Sync.all
    // via resolveSubStep with empty targetCl), never the machine token.
    expect(
      screen.getByText(t("sync.error.failedAt", { step: t("steps.p4Sync.all") })),
    ).toBeDefined();
    expect(screen.queryByText(/p4Sync failed/)).toBeNull();
    // Raw AppError payload renders as a sibling node, still visible.
    expect(screen.getByText("Connection refused")).toBeDefined();
    expect(screen.getByText(t("sync.error.retry"))).toBeDefined();
    expect(screen.getByText(t("sync.error.dismiss"))).toBeDefined();
  });

  it("networkCheck shows sync.error.networkCheck, not steps.unknown; retryKind restart shows restart label", () => {
    const t = makeT("en");
    renderWithI18n(
      <ErrorPanel
        step="networkCheck"
        error="timeout"
        retryKind="restart"
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByText(t("sync.error.failedAt", { step: t("sync.error.networkCheck") })),
    ).toBeDefined();
    // Pitfall 4: networkCheck must NOT resolve to steps.unknown ("Working…").
    expect(screen.queryByText(t("steps.unknown"))).toBeNull();
    expect(screen.getByText(t("sync.error.restart"))).toBeDefined();
    expect(screen.queryByText(t("sync.error.retry"))).toBeNull();
  });

  it("zh smoke: title equals sync.error.title", () => {
    const tZh = makeT("zh");
    renderWithI18n(
      <ErrorPanel
        step="p4Sync"
        error="Connection refused"
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
      { locale: "zh" },
    );
    expect(screen.getByText(tZh("sync.error.title"))).toBeDefined();
    // raw payload stays visible under zh too
    expect(screen.getByText("Connection refused")).toBeDefined();
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
    const t = makeT("en");
    renderWithI18n(<StepIndicator stepStatuses={statuses} targetCl="" />);
    expect(screen.getByText(t("steps.closeUe.check"))).toBeDefined();
    expect(screen.getByText(t("steps.closeExcel.check"))).toBeDefined();
    expect(screen.getByText(t("steps.cleanDevDir.clean"))).toBeDefined();
    expect(screen.getByText(t("steps.p4Sync.all"))).toBeDefined();
    expect(screen.getByText(t("steps.genProject.gen"))).toBeDefined();
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
    lastSyncResult: null as LastSyncResult | null,
    selectedWorkspace: null as WorkspaceConfig | null,
    targetCl: "",
    onTargetClChange: (_cl: string) => {},
    currentSubStep: null as string | null,
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
    renderWithI18n(<SyncDashboard {...baseProps} syncState="idle" />);
    expect(screen.getByText("Perforce project")).toBeDefined();
  });

  it("renders ErrorPanel when error", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="error"
        errorInfo={{ step: "p4Sync", error: "Network error" }}
      />,
    );
    expect(screen.getByText(t("sync.error.title"))).toBeDefined();
  });

  it("dashboard remains the dictionary-driven Sync, History, and Health tab owner", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard {...baseProps} syncState="idle" selectedWorkspace={null} />,
    );
    expect(screen.getByRole("tab", { name: new RegExp(t("sync.tab.sync"), "i") })).toBeDefined();
    expect(screen.getByRole("tab", { name: new RegExp(t("sync.tab.history"), "i") })).toBeDefined();
    expect(screen.getByRole("tab", { name: new RegExp(t("sync.tab.health"), "i") })).toBeDefined();
    expect(screen.queryByText(t("sync.dash.noWorkspace"))).toBeNull();
  });

  it("renders RunningPanel when running", () => {
    const t = makeT("en");
    const tZh = makeT("zh");
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
      />,
    );
    expect(screen.getByText(t("sync.cancel"))).toBeDefined();
    // quick-260707-kdf: prep must NOT leak into the null-step / non-p4Sync
    // path. The zh dictionary value with n=0 is the negative (the non-p4Sync
    // path never composes a prep label at all).
    expect(screen.queryByText(tZh("sync.prep", { n: 0 }))).toBeNull();
  });
});

// quick-260707-kdf: prep state — indeterminate bar + dictionary prep label
// (t("sync.prep", { n })) between p4Sync start and the first byte sample
// (or the 20s fallback).
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
    lastSyncResult: null as LastSyncResult | null,
    selectedWorkspace: null as WorkspaceConfig | null,
    targetCl: "",
    onTargetClChange: (_cl: string) => {},
    currentSubStep: null as string | null,
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
    const t = makeT("en");
    // Spread-from-variable avoids TS excess-property checks on the byte fields
    // (SyncDashboard.progress is narrowly typed {current,total,currentFile};
    // App.tsx passes a wider object at runtime — structural typing admits it).
    const progress = {
      current: 50000,
      total: 164038,
      currentFile: "//Example_Depot/ExampleGame/Content/SomeFile.uasset",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    // Prep label present (dictionary key with the total file count interpolated).
    expect(
      screen.getByText(t("sync.prep", { n: 164038 })),
    ).toBeDefined();
    // Count-bar main line NOT rendered as the primary line (dictionary count chrome).
    expect(
      screen.queryByText(
        t("sync.files.count", { current: 50000, total: 164038 }),
      ),
    ).toBeNull();
  });

  it("Test C: byte bar takes priority over prep when byte signal arrives", () => {
    const t = makeT("en");
    const progress = {
      current: 50000,
      total: 164038,
      currentFile: "",
      bytesDone: 300_000_000,
      bytesTotal: 4_000_000_000,
      bytesRate: 45_000_000,
    };
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    // Prep cleared by the byte signal (neither en nor zh prep value renders).
    expect(screen.queryByText(t("sync.prep", { n: 164038 }))).toBeNull();
    expect(screen.queryByText(makeT("zh")("sync.prep", { n: 164038 }))).toBeNull();
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
    lastSyncResult: null as LastSyncResult | null,
    selectedWorkspace: null as WorkspaceConfig | null,
    targetCl: "",
    onTargetClChange: (_cl: string) => {},
    currentSubStep: null as string | null,
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
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    // Byte-formatted main line present as the PRIMARY line (ProgressSection)
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
    const t = makeT("en");
    const progress = {
      current: 13660,
      total: 13657,
      currentFile: "",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    // Dictionary overrun indeterminate fallback (sync.files.overrun — same
    // key as the count-bar overrun text) preserved.
    expect(
      screen.getByText(t("sync.files.overrun", { n: 13657 })),
    ).toBeDefined();
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
    lastSyncResult: null as LastSyncResult | null,
    selectedWorkspace: null as WorkspaceConfig | null,
    targetCl: "",
    onTargetClChange: (_cl: string) => {},
    currentSubStep: null as string | null,
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
    renderWithI18n(
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
    renderWithI18n(
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

describe("RunningPanel dictionary labels (WIRE-01)", () => {
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
    lastSyncResult: null as LastSyncResult | null,
    selectedWorkspace: null as WorkspaceConfig | null,
    targetCl: "",
    onTargetClChange: (_cl: string) => {},
    currentSubStep: null as string | null,
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

  function RunningLocaleHarness({
    currentStep,
    stepStatuses,
  }: {
    currentStep: SyncStep;
    stepStatuses: Record<SyncStep, StepStatus>;
  }) {
    const { setLocale } = useT();
    return (
      <div>
        <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
          zh
        </button>
        <SyncDashboard
          {...baseProps}
          syncState="running"
          currentStep={currentStep}
          stepStatuses={stepStatuses}
        />
      </div>
    );
  }

  it("shows genProject dictionary label on the running line", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="genProject"
      />,
    );
    // chip + running line share steps.genProject.gen
    expect(screen.getAllByText(t("steps.genProject.gen"))).toHaveLength(2);
  });

  it("shows forceSync dictionary label Force-syncing Engine… not Force-syncing…", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep={"forceSync" as SyncStep}
      />,
    );
    expect(screen.getByText(t("steps.forceSync.force"))).toBeDefined();
    expect(screen.queryByText("Force-syncing…")).toBeNull();
  });

  it("pending p4Sync chip with targetCl 310771 is Syncing to CL 310771", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        targetCl="310771"
      />,
    );
    expect(
      screen.getByText(t("steps.p4Sync.toCl", { cl: "310771" })),
    ).toBeDefined();
  });

  it("locale switch setLocale zh re-labels genProject chip + running line without remounting stepStatuses", () => {
    const statuses = {
      closeUe: "completed" as const,
      closeExcel: "completed" as const,
      cleanDevDir: "completed" as const,
      p4Sync: "completed" as const,
      genProject: "active" as const,
    };
    const tEn = makeT("en");
    renderWithI18n(
      <RunningLocaleHarness currentStep="genProject" stepStatuses={statuses} />,
    );
    expect(screen.getAllByText(tEn("steps.genProject.gen"))).toHaveLength(2);
    fireEvent.click(screen.getByTestId("switch-zh"));
    const tZh = makeT("zh");
    expect(screen.getAllByText(tZh("steps.genProject.gen"))).toHaveLength(2);
    expect(screen.queryByText(tEn("steps.genProject.gen"))).toBeNull();
  });

  it("p4Sync overrun with no byte signal still shows the dictionary overrun label", () => {
    const t = makeT("en");
    const progress = {
      current: 13660,
      total: 13657,
      currentFile: "",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    renderWithI18n(
      <SyncDashboard
        {...baseProps}
        syncState="running"
        currentStep="p4Sync"
        progress={progress}
      />,
    );
    expect(
      screen.getByText(t("sync.files.overrun", { n: 13657 })),
    ).toBeDefined();
  });
});

// Phase 26 (26-03 Task 3, D-01/GIT-01): the EXACT panel priority
// (git non-idle → running → error-with-errorInfo → idle) pinned by tests —
// Git dominance holds even against concurrent incidental sync values.
// Branch-order CODE is untouched; these prove the existing projection.
describe("SyncDashboard projection priority (26-03)", () => {
  it("git running dominates a concurrently running sync", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard {...dashProps} syncState="running" gitState="running" />,
    );
    expect(screen.getByText(t("sync.git.runningTitle"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("sync.git.cancel") }),
    ).toBeDefined();
    expect(screen.queryByText(t("sync.running.title"))).toBeNull();
    expect(
      screen.queryByRole("button", { name: t("sync.cancel") }),
    ).toBeNull();
  });

  it("git success dominates a concurrent sync error with errorInfo set", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard
        {...dashProps}
        syncState="error"
        errorInfo={{ step: "p4Sync", error: "p4 boom detail" }}
        gitState="success"
      />,
    );
    expect(screen.getByText(t("sync.git.success"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("sync.git.back") }),
    ).toBeDefined();
    expect(screen.queryByText(t("sync.error.title"))).toBeNull();
    expect(screen.queryByText("p4 boom detail")).toBeNull();
  });

  it("git error dominates a concurrent sync error with errorInfo set", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard
        {...dashProps}
        syncState="error"
        errorInfo={{ step: "p4Sync", error: "p4 boom detail" }}
        gitState="error"
        gitErrorInfo={{ error: "git boom detail" }}
      />,
    );
    expect(screen.getByText(t("sync.git.failed"))).toBeDefined();
    expect(screen.getByText("git boom detail")).toBeDefined();
    expect(screen.queryByText(t("sync.error.title"))).toBeNull();
    expect(screen.queryByText("p4 boom detail")).toBeNull();
  });
});

// Phase 26 (26-03 Task 3, D-03/SYNC-03): networkCheck failure offers
// restart-the-whole-sync semantics; every other failed step offers a single
// step retry — two distinct typed actions with distinct callbacks.
describe("SyncDashboard restart-versus-retry routing (26-03)", () => {
  it("networkCheck failure renders the restart label and fires onStartSync only", () => {
    const t = makeT("en");
    const onStartSync = vi.fn();
    const onRetryStep = vi.fn();
    renderWithI18n(
      <SyncDashboard
        {...dashProps}
        syncState="error"
        errorInfo={{ step: "networkCheck", error: "connection refused" }}
        selectedWorkspace={WORKSPACE}
        onStartSync={onStartSync}
        onRetryStep={onRetryStep}
      />,
    );
    expect(
      screen.getByRole("button", { name: t("sync.error.restart") }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: t("sync.error.retry") }),
    ).toBeNull();
    // The typed failed-at sentence uses the dedicated networkCheck key.
    expect(
      screen.getByText(
        t("sync.error.failedAt", { step: t("sync.error.networkCheck") }),
      ),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: t("sync.error.restart") }),
    );
    expect(onStartSync).toHaveBeenCalledTimes(1);
    expect(onRetryStep).not.toHaveBeenCalled();
  });

  it("a step failure (p4Sync) renders the step label and fires onRetryStep with that step", () => {
    const t = makeT("en");
    const onStartSync = vi.fn();
    const onRetryStep = vi.fn();
    renderWithI18n(
      <SyncDashboard
        {...dashProps}
        syncState="error"
        errorInfo={{ step: "p4Sync", error: "boom" }}
        selectedWorkspace={WORKSPACE}
        onStartSync={onStartSync}
        onRetryStep={onRetryStep}
      />,
    );
    expect(
      screen.getByText(
        t("sync.error.failedAt", { step: t("steps.p4Sync.all") }),
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("sync.error.retry") }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: t("sync.error.restart") }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: t("sync.error.retry") }),
    );
    expect(onRetryStep).toHaveBeenCalledWith("p4Sync");
    expect(onStartSync).not.toHaveBeenCalled();
  });
});

// Phase 26 (26-03 Task 3, D-04/UI-SPEC §8): the raw backend error renders as
// its own element beside the typed chrome — never inside the sentence.
describe("SyncDashboard raw-error sibling (26-03)", () => {
  it("the raw sync error renders as its own mono element beside the typed failed-at sentence", () => {
    const t = makeT("en");
    renderWithI18n(
      <SyncDashboard
        {...dashProps}
        syncState="error"
        errorInfo={{ step: "p4Sync", error: "raw p4 failure payload" }}
      />,
    );
    const failedAtNode = screen.getByText(
      t("sync.error.failedAt", { step: t("steps.p4Sync.all") }),
    );
    const rawNode = screen.getByText("raw p4 failure payload");
    expect(rawNode).not.toBe(failedAtNode);
    expect(rawNode.className).toContain("font-mono");
    expect(rawNode.className).toContain("[overflow-wrap:anywhere]");
  });
});
