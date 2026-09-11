import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import App from "@/App";
import { makeT, renderWithI18n } from "@/lib/i18n";
import type { WorkspaceConfig } from "@/lib/types";

// Phase 26 (26-03 Task 3, SYNC-03 / T-26-12): the App-level ownership proof.
// App.tsx owns the cross-hook coordination — onSyncComplete's current-CL
// refresh + history reload, the App-lifted shared warning slot, rollback
// warning routing, and the global operation lock's Git Pull guard. This
// suite renders the REAL App component with the six hook modules mocked
// (controllable fixtures) and captures the callbacks App passes INTO
// useSync/useHistory from the mock constructor arguments, then invokes them
// to prove the wiring survives the presentation migration.

// Shared mutable fixtures — vi.hoisted runs before the vi.mock factories.
const h = vi.hoisted(() => {
  const stepStatuses = {
    closeUe: "pending",
    closeExcel: "pending",
    cleanDevDir: "pending",
    p4Sync: "pending",
    genProject: "pending",
  } as const;
  return {
    useSyncCalls: [] as Array<{
      onSyncComplete?: (cl: string | null) => void;
      onWarningsChange?: (w: unknown[]) => void;
    }>,
    useHistoryCalls: [] as Array<{
      workspaceId: string | null;
      onRollbackComplete?: (cl: string | null, w: unknown[]) => void;
    }>,
    refreshCurrentCl: vi.fn(),
    loadHistory: vi.fn(),
    startGitPull: vi.fn(() => Promise.resolve()),
    fixtures: {
      workspaces: {
        list: [] as WorkspaceConfig[],
        selected: null as WorkspaceConfig | null,
        currentCl: null as string | null,
      },
      sync: {
        syncState: "idle" as string,
        lastSyncResult: null as
          | { status: string; cl: string | null; fileCount: number; epochMs: number }
          | null,
      },
      history: { isRollingBack: false },
      git: { gitState: "idle" as string },
    },
    stepStatuses,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("0.0.0-test")),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  ask: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(() =>
    Promise.resolve({ get: vi.fn(), set: vi.fn(), save: vi.fn() }),
  ),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn(() => Promise.resolve()),
  disable: vi.fn(() => Promise.resolve()),
  isEnabled: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaces: () => ({
    workspaces: h.fixtures.workspaces.list,
    selectedId: h.fixtures.workspaces.selected?.id ?? null,
    selectedWorkspace: h.fixtures.workspaces.selected,
    isLoading: false,
    currentCl: h.fixtures.workspaces.currentCl,
    refreshCurrentCl: h.refreshCurrentCl,
    selectWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    updateSettings: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSync", () => ({
  useSync: (
    onSyncComplete?: (cl: string | null) => void,
    onWarningsChange?: (w: unknown[]) => void,
  ) => {
    h.useSyncCalls.push({ onSyncComplete, onWarningsChange });
    return {
      syncState: h.fixtures.sync.syncState,
      isCancelling: false,
      currentStep: null,
      currentSubStep: null,
      stepStatuses: h.stepStatuses,
      targetCl: "",
      setTargetCl: vi.fn(),
      syncEngine: false,
      setSyncEngine: vi.fn(),
      progress: { current: 0, total: 0, currentFile: "" },
      logLines: [] as string[],
      errorInfo: null,
      lastSyncResult: h.fixtures.sync.lastSyncResult,
      startSync: vi.fn(),
      stopSync: vi.fn(),
      retryStep: vi.fn(),
      dismissError: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/useHistory", () => ({
  useHistory: (
    workspaceId: string | null,
    onRollbackComplete?: (cl: string | null, w: unknown[]) => void,
  ) => {
    h.useHistoryCalls.push({ workspaceId, onRollbackComplete });
    return {
      records: [] as unknown[],
      isLoading: false,
      isRollingBack: h.fixtures.history.isRollingBack,
      loadHistory: h.loadHistory,
      startRollback: vi.fn(),
    };
  },
}));

vi.mock("@/hooks/useGit", () => ({
  useGit: () => ({
    gitState: h.fixtures.git.gitState,
    logLines: [] as string[],
    errorInfo: null,
    gitProgress: null,
    gitCurrentStep: null,
    gitCurrentSubStep: null,
    startGitPull: h.startGitPull,
    stopGitPull: vi.fn(),
    dismissGitResult: vi.fn(),
  }),
}));

vi.mock("@/hooks/useBehindCheck", () => ({
  useBehindCheck: () => ({
    behindInfo: null,
    behindLoading: false,
    runCheck: vi.fn(async () => {}),
    cancel: vi.fn(),
  }),
}));

vi.mock("@/hooks/useUpdater", () => ({
  useUpdater: () => ({
    info: {
      state: "idle",
      version: null,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
    },
    checkAndInstall: vi.fn(),
  }),
}));

const WORKSPACE: WorkspaceConfig = {
  id: "ws-app-1",
  name: "AppOwnershipWS",
  projectDir: "Proj",
  rootPath: "D:\\AppOwnership",
  p4Client: "app_client",
  p4User: "app_user",
  lastSyncCl: null,
  lastSyncTime: null,
  lastSyncFileCount: null,
  parallelThreads: 4,
  exclusions: [],
  intervalMinutes: 60,
};

function resetFixtures() {
  h.useSyncCalls.length = 0;
  h.useHistoryCalls.length = 0;
  h.refreshCurrentCl.mockClear();
  h.loadHistory.mockClear();
  h.startGitPull.mockClear();
  h.fixtures.workspaces.list = [WORKSPACE];
  h.fixtures.workspaces.selected = WORKSPACE;
  h.fixtures.workspaces.currentCl = null;
  h.fixtures.sync.syncState = "idle";
  h.fixtures.sync.lastSyncResult = null;
  h.fixtures.history.isRollingBack = false;
  h.fixtures.git.gitState = "idle";
}

function lastSyncHooks() {
  return h.useSyncCalls[h.useSyncCalls.length - 1];
}

function lastHistoryHooks() {
  return h.useHistoryCalls[h.useHistoryCalls.length - 1];
}

describe("App SYNC-03 ownership wiring (26-03)", () => {
  beforeEach(resetFixtures);

  it("invoking the captured onSyncComplete refreshes the current CL and reloads history", () => {
    renderWithI18n(<App />);
    const { onSyncComplete } = lastSyncHooks();
    expect(onSyncComplete).toBeDefined();
    act(() => {
      onSyncComplete!("99999");
    });
    expect(h.refreshCurrentCl).toHaveBeenCalledWith("99999");
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("invoking the captured onWarningsChange writes the lifted slot so the idle surface renders the warning summary", () => {
    const t = makeT("en");
    h.fixtures.sync.lastSyncResult = {
      status: "completed",
      cl: "12345",
      fileCount: 7,
      epochMs: 0,
    };
    renderWithI18n(<App />);
    const { onWarningsChange } = lastSyncHooks();
    expect(onWarningsChange).toBeDefined();
    // Empty slot renders no summary.
    expect(
      screen.queryByText(t("sync.summary.header.warnings", { warns: 1 })),
    ).toBeNull();
    act(() => {
      onWarningsChange!([
        { severity: "warning", path: "//Depot/warned.txt", message: "m", count: 1 },
      ]);
    });
    expect(
      screen.getByText(t("sync.summary.header.warnings", { warns: 1 })),
    ).toBeDefined();
    expect(screen.getByText("//Depot/warned.txt")).toBeDefined();
  });

  it("invoking the captured onRollbackComplete refreshes the CL and routes warnings into the same lifted slot", () => {
    const t = makeT("en");
    h.fixtures.sync.lastSyncResult = {
      status: "completed",
      cl: "12345",
      fileCount: 7,
      epochMs: 0,
    };
    renderWithI18n(<App />);
    const { onRollbackComplete } = lastHistoryHooks();
    expect(onRollbackComplete).toBeDefined();
    act(() => {
      onRollbackComplete!("777", [
        { severity: "error", path: "//Depot/errored.txt", message: "m", count: 2 },
      ]);
    });
    expect(h.refreshCurrentCl).toHaveBeenCalledWith("777");
    expect(
      screen.getByText(t("sync.summary.header.errors", { errors: 1 })),
    ).toBeDefined();
    expect(screen.getByText("//Depot/errored.txt")).toBeDefined();
  });

  it("handleGitPull no-ops while the derived operation lock is running", async () => {
    const t = makeT("en");
    const { rerender } = renderWithI18n(<App />);
    // Positive control: unlocked, the Git Pull action reaches startGitPull.
    const pull = screen.getByRole("button", { name: t("sync.git.pull") });
    expect(pull).toBeEnabled();
    await act(async () => {
      fireEvent.click(pull);
    });
    await waitFor(() => expect(h.startGitPull).toHaveBeenCalledTimes(1));
    h.startGitPull.mockClear();

    // Rollback-running lock component: idle panels stay mounted, the SAME
    // derived isOperationRunning lock disables Git Pull, and a click never
    // reaches the mocked startGitPull.
    h.fixtures.history.isRollingBack = true;
    rerender(<App />);
    const locked = screen.getByRole("button", { name: t("sync.git.pull") });
    expect(locked).toBeDisabled();
    fireEvent.click(locked);
    expect(h.startGitPull).not.toHaveBeenCalled();

    // Sync-running lock component: the idle surface (and its Git Pull
    // action) is replaced entirely by the running projection.
    h.fixtures.history.isRollingBack = false;
    h.fixtures.sync.syncState = "running";
    rerender(<App />);
    expect(
      screen.queryByRole("button", { name: t("sync.git.pull") }),
    ).toBeNull();
    expect(h.startGitPull).not.toHaveBeenCalled();
  });
});
