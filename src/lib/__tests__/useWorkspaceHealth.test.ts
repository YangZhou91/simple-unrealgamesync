import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * quick-260713-s44 — RED phase tests for useWorkspaceHealth.
 *
 * The hook wraps the `check_workspace_health` Tauri command (invoked via
 * `@/lib/commands`). These tests pin the public contract WITHOUT a real Tauri
 * runtime by mocking `@tauri-apps/api/core`'s `invoke`. The hook's own
 * in-flight guard (useRef boolean) prevents a double-invoke when runAudit is
 * called while a previous audit is still loading.
 *
 * Behaviors pinned:
 *   - idle: report=null, loading=false, error=null
 *   - success: sets report, loading flips true->false
 *   - failure: sets error, loading flips true->false
 *   - concurrent guard: a second runAudit while loading is a no-op (invoke called once)
 *   - reset(): clears report + error + loading back to idle
 */

// vi.hoisted runs BEFORE the vi.mock factories (which are themselves hoisted
// above all other top-level code), so symbols declared here are initialized in
// time for the factories to close over them. `currentInvoke` is the per-test
// behavior slot the factory reads at call time.
const hoisted = vi.hoisted(() => {
  let currentInvoke: ((cmd: string, args?: unknown) => Promise<unknown>) | null = null;
  const invokeMock = vi.fn((cmd: string, args?: unknown) => {
    if (currentInvoke) {
      return currentInvoke(cmd, args);
    }
    return Promise.resolve(null);
  });
  return {
    invokeMock,
    currentInvokeRef: {
      get value() {
        return currentInvoke;
      },
      set value(v: ((cmd: string, args?: unknown) => Promise<unknown>) | null) {
        currentInvoke = v;
      },
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: hoisted.invokeMock,
}));

const { invokeMock, currentInvokeRef } = hoisted;

import { useWorkspaceHealth } from "@/hooks/useWorkspaceHealth";
import type { WorkspaceHealthReport } from "@/lib/types";

const sampleReport: WorkspaceHealthReport = {
  categories: [
    { category: "unmapped", count: 1, paths: ["FYGame/FYGame.uproject"] },
    { category: "missing-on-disk", count: 0, paths: [] },
    { category: "not-in-depot", count: 2, paths: ["Config/X.ini", "Source/Y.cpp"] },
    { category: "differs", count: 0, paths: [] },
  ],
  stream: "//FYDepot/FYGame main",
};

describe("useWorkspaceHealth", () => {
  beforeEach(() => {
    currentInvokeRef.value = null;
    invokeMock.mockClear();
  });

  // Behavior: idle state on mount.
  it("starts idle: report=null, loading=false, error=null", () => {
    const { result } = renderHook(() => useWorkspaceHealth());
    expect(result.current.report).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  // Behavior: successful audit sets report, loading flips true->false.
  it("sets report on successful audit and flips loading", async () => {
    let resolveAudit: (v: WorkspaceHealthReport) => void = () => {};
    currentInvokeRef.value = () =>
      new Promise<WorkspaceHealthReport>((resolve) => {
        resolveAudit = resolve;
      });

    const { result } = renderHook(() => useWorkspaceHealth());

    // Kick off the audit — loading flips true immediately.
    await act(async () => {
      result.current.runAudit("ws-1");
    });
    expect(result.current.loading).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("check_workspace_health", {
      workspaceId: "ws-1",
    });

    // Resolve the audit — loading flips false, report is set.
    await act(async () => {
      resolveAudit(sampleReport);
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.report).toEqual(sampleReport);
    expect(result.current.error).toBeNull();
  });

  // Behavior: failed audit sets error, loading flips false, report stays null.
  it("sets error on failed audit and flips loading false", async () => {
    let rejectAudit: (e: unknown) => void = () => {};
    currentInvokeRef.value = () =>
      new Promise((_resolve, reject) => {
        rejectAudit = reject;
      });

    const { result } = renderHook(() => useWorkspaceHealth());

    await act(async () => {
      result.current.runAudit("ws-1");
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      rejectAudit(new Error("p4 down"));
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBe("p4 down");
  });

  // Behavior: concurrent guard — a second runAudit while loading is a no-op.
  it("does NOT double-invoke when runAudit is called while loading", async () => {
    let resolveAudit: (v: WorkspaceHealthReport) => void = () => {};
    currentInvokeRef.value = () =>
      new Promise<WorkspaceHealthReport>((resolve) => {
        resolveAudit = resolve;
      });

    const { result } = renderHook(() => useWorkspaceHealth());

    // First call — starts the audit.
    await act(async () => {
      result.current.runAudit("ws-1");
    });
    expect(result.current.loading).toBe(true);

    // Second call while loading — must be a no-op (invoke NOT called again).
    await act(async () => {
      result.current.runAudit("ws-1");
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Resolve to unblock for cleanup.
    await act(async () => {
      resolveAudit(sampleReport);
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  // Behavior: reset() clears report + error + loading back to idle.
  it("reset() clears report + error back to idle", async () => {
    currentInvokeRef.value = () => Promise.resolve(sampleReport);

    const { result } = renderHook(() => useWorkspaceHealth());

    await act(async () => {
      result.current.runAudit("ws-1");
    });
    await waitFor(() => {
      expect(result.current.report).toEqual(sampleReport);
    });

    await act(async () => {
      result.current.reset();
    });
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
