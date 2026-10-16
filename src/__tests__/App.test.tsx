import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// Phase 31 (D-04/D-09, PTHS-01): the App-level enginePath wiring. The shared
// invoke mock at L56-59 is the blanket `vi.fn(() => Promise.resolve())`, which
// resolves `undefined` — type-dishonest for a token assertion and enough to
// leave the probe at "unknown" (RESEARCH Pitfall 5). Inside THIS describe only,
// re-implement it cmd-aware so `engine_path` answers a real token, then restore
// the blanket impl in afterEach so no other describe is affected.
describe("App enginePath wiring (Phase 31)", () => {
  // Phase 31 gap-closure (IN-02): the mock now receives BOTH invoke arguments,
  // so `engine_path`/`engine_status` can be routed per `args.workspaceId`. The
  // escape root cause behind gaps #1/#2 was a mock that ignored the id and
  // therefore could not express a genuine A->B switch at all.
  type CmdAwareInvoke = {
    mockImplementation: (
      fn: (cmd: string, args?: unknown) => Promise<unknown>,
    ) => void;
    mock: { calls: unknown[][] };
  };

  async function setInvoke(
    impl: (cmd: string, args?: unknown) => Promise<unknown>,
  ) {
    const core = await import("@tauri-apps/api/core");
    (vi.mocked(core.invoke) as unknown as CmdAwareInvoke).mockImplementation(impl);
  }

  function argWorkspaceId(args: unknown): string | undefined {
    return (args as { workspaceId?: string } | undefined)?.workspaceId;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // A second workspace fixture, local to this describe — the A->B switch
  // scenarios are the escape root cause (every prior scenario cold-booted one
  // workspace and never switched between two resolved ones).
  const WORKSPACE_B: WorkspaceConfig = {
    ...WORKSPACE,
    id: "ws-app-2",
    name: "AppOwnershipWS2",
  };

  async function invokeMock() {
    const core = await import("@tauri-apps/api/core");
    return vi.mocked(core.invoke) as unknown as CmdAwareInvoke;
  }

  function enginePathCalls(inv: CmdAwareInvoke) {
    return inv.mock.calls.filter((c) => c[0] === "engine_path").length;
  }

  beforeEach(async () => {
    resetFixtures();
    await setInvoke((cmd) =>
      cmd === "engine_path" ? Promise.resolve("none") : Promise.resolve(),
    );
  });

  afterEach(async () => {
    await setInvoke(() => Promise.resolve());
  });

  it('threads the resolved token to the idle surface (engine_path -> "none" renders the muted line)', async () => {
    const t = makeT("en");
    renderWithI18n(<App />);
    await waitFor(() => {
      expect(screen.getByText(t("sync.enginePath.none"))).toBeDefined();
    });
    // ...and neither card survives alongside it.
    expect(screen.queryByRole("button", { name: t("sync.git.pull") })).toBeNull();
    expect(
      screen.queryByRole("button", { name: t("sync.engineP4.updateButton") }),
    ).toBeNull();
  });

  it("resets to the both-cards default when the workspace is deselected (D-09)", async () => {
    const t = makeT("en");
    const { rerender } = renderWithI18n(<App />);
    await waitFor(() => {
      expect(screen.getByText(t("sync.enginePath.none"))).toBeDefined();
    });

    h.fixtures.workspaces.selected = null;
    rerender(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("sync.git.pull") })).toBeDefined();
    });
    expect(
      screen.getByRole("button", { name: t("sync.engineP4.updateButton") }),
    ).toBeDefined();
    // "no workspace" is NEVER "none" — the muted line must not render.
    expect(screen.queryByText(t("sync.enginePath.none"))).toBeNull();
  });

  it("keeps the both-cards default and never errors the UI when the probe rejects", async () => {
    const t = makeT("en");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setInvoke((cmd) =>
      cmd === "engine_path"
        ? Promise.reject(new Error("engine_path probe failed"))
        : Promise.resolve(),
    );

    renderWithI18n(<App />);

    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    // Both cards stay; no muted line; no error surface, no crash.
    expect(screen.getByRole("button", { name: t("sync.git.pull") })).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("sync.engineP4.updateButton") }),
    ).toBeDefined();
    expect(screen.queryByText(t("sync.enginePath.none"))).toBeNull();

    errSpy.mockRestore();
  });

  it("re-probes after a sync terminal (D-04 completion leg)", async () => {
    renderWithI18n(<App />);
    const inv = await invokeMock();
    await waitFor(() => expect(enginePathCalls(inv)).toBeGreaterThan(0));
    const before = enginePathCalls(inv);

    const { onSyncComplete } = lastSyncHooks();
    expect(onSyncComplete).toBeDefined();
    await act(async () => {
      onSyncComplete!("99999");
    });

    expect(enginePathCalls(inv)).toBeGreaterThan(before);
  });

  // Gap #1 (31-VERIFICATION must-have truth #6, CR-01): on a genuine A->B
  // workspace switch the token must be reset to "unknown" BEFORE the new probe
  // is awaited, so B's WHOLE in-flight window renders the both-cards default —
  // never A's resolved single card. B's probe is held pending so the assertion
  // observes the in-flight window rather than the settled state; under the
  // pre-fix code A's `"git"` token persists and the P4 button stays absent.
  it("resets the token to the both-cards default on a workspace switch (gap #1)", async () => {
    const t = makeT("en");
    const aProbe = deferred<"git" | "p4" | "none">();
    const bProbe = deferred<"git" | "p4" | "none">();
    await setInvoke((cmd, args) => {
      if (cmd !== "engine_path") return Promise.resolve();
      return argWorkspaceId(args) === WORKSPACE_B.id
        ? bProbe.promise
        : aProbe.promise;
    });
    h.fixtures.workspaces.list = [WORKSPACE, WORKSPACE_B];
    h.fixtures.workspaces.selected = WORKSPACE;

    const { rerender } = renderWithI18n(<App />);

    // A resolves to "git" -> the Git card only, P4 absent.
    await act(async () => {
      aProbe.resolve("git");
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: t("sync.engineP4.updateButton") }),
      ).toBeNull();
    });
    expect(screen.getByRole("button", { name: t("sync.git.pull") })).toBeDefined();

    // Switch to B while B's probe is STILL PENDING.
    h.fixtures.workspaces.selected = WORKSPACE_B;
    rerender(<App />);

    // The discriminator is the P4 button: it renders for "unknown" and "p4".
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: t("sync.engineP4.updateButton") }),
      ).toBeDefined();
    });
    expect(screen.getByRole("button", { name: t("sync.git.pull") })).toBeDefined();
    expect(screen.queryByText(t("sync.enginePath.none"))).toBeNull();

    // Settle B to "none" -> the muted neither-line.
    await act(async () => {
      bProbe.resolve("none");
    });
    await waitFor(() => {
      expect(screen.getByText(t("sync.enginePath.none"))).toBeDefined();
    });
  });

  // The negative half of the reset policy (D-04 cadence): a re-probe of the
  // SAME workspace must NOT reset the token — the current card stays on screen
  // for the whole re-probe window. This case fails if the identity guard is
  // replaced by an unconditional `setEnginePath("unknown")` at the top of the
  // fetch (that variant flips the surface to both-cards mid-re-probe).
  it("keeps the current card while a same-workspace re-probe is in flight (no reset)", async () => {
    const t = makeT("en");
    let answer: () => Promise<"git" | "p4" | "none"> = () =>
      Promise.resolve("git");
    await setInvoke((cmd) =>
      cmd === "engine_path" ? answer() : Promise.resolve(),
    );

    renderWithI18n(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("sync.git.pull") })).toBeDefined();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: t("sync.engineP4.updateButton") }),
      ).toBeNull();
    });

    // Flip the SAME workspace's answer to a held-pending promise — no identity
    // change, so the reset policy must leave the resolved "git" card alone.
    const held = deferred<"git" | "p4" | "none">();
    answer = () => held.promise;

    const { onSyncComplete } = lastSyncHooks();
    expect(onSyncComplete).toBeDefined();
    await act(async () => {
      onSyncComplete!("99999");
    });

    expect(screen.getByRole("button", { name: t("sync.git.pull") })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: t("sync.engineP4.updateButton") }),
    ).toBeNull();
    expect(screen.queryByText(t("sync.enginePath.none"))).toBeNull();

    await act(async () => {
      held.resolve("git");
    });
  });
});
