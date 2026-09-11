import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * HIST-02 / D-07 — useWorkspaceHealth generation-guard.
 *
 * The hook wraps the `check_workspace_health` Tauri command (invoked via
 * `@/lib/commands`). These tests pin the public contract WITHOUT a real Tauri
 * runtime by mocking `@tauri-apps/api/core`'s `invoke`.
 *
 * Behaviors pinned:
 *   - idle: report=null, loading=false, error=null
 *   - success: sets report, loading flips true->false
 *   - failure: sets error, loading flips true->false
 *   - concurrent guard: a second runAudit while loading is a no-op
 *   - reset(): clears report + error + loading back to idle AND invalidates
 *     in-flight results
 *   - Wave 0 generation-guard: workspace switch clears immediately; stale
 *     resolve / reject / finally never write; Audit for B after switch invokes
 *     again. checkWorkspaceHealth remains the only command (no cancel IPC).
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
    { category: "unmapped", count: 1, paths: ["ExampleGame/ExampleGame.uproject"] },
    { category: "missing-on-disk", count: 0, paths: [] },
    { category: "not-in-depot", count: 2, paths: ["Config/X.ini", "Source/Y.cpp"] },
    { category: "differs", count: 0, paths: [] },
    { category: "needs-resolve", count: 0, paths: [] },
  ],
  stream: "//ExampleDepot/ExampleGame main",
};

const sampleReportB: WorkspaceHealthReport = {
  ...sampleReport,
  stream: "//DemoOtherDepot/OtherGame main",
};

describe("useWorkspaceHealth", () => {
  beforeEach(() => {
    currentInvokeRef.value = null;
    invokeMock.mockClear();
  });

  // Behavior: idle state on mount.
  it("starts idle: report=null, loading=false, error=null", () => {
    const { result } = renderHook(() => useWorkspaceHealth("ws-1"));
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

    const { result } = renderHook(() => useWorkspaceHealth("ws-1"));

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

    const { result } = renderHook(() => useWorkspaceHealth("ws-1"));

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

    const { result } = renderHook(() => useWorkspaceHealth("ws-1"));

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

    const { result } = renderHook(() => useWorkspaceHealth("ws-1"));

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

  // Wave 0 / Test 1: workspace switch clears immediately, before A's promise settles.
  it("clears to idle immediately on workspaceId change before the in-flight audit settles", async () => {
    let resolveA: (v: WorkspaceHealthReport) => void = () => {};
    currentInvokeRef.value = () =>
      new Promise<WorkspaceHealthReport>((resolve) => {
        resolveA = resolve;
      });

    const { result, rerender } = renderHook(({ id }) => useWorkspaceHealth(id), {
      initialProps: { id: "ws-a" },
    });

    await act(async () => {
      result.current.runAudit("ws-a");
    });
    expect(result.current.loading).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    rerender({ id: "ws-b" });
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    // Still only A's invoke — switch must not auto-audit.
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Leave A's promise unsettled on purpose (D-07: idle before A settles).
    void resolveA;
  });

  // Wave 0 / Test 2: stale resolve after switch never paints A's report under B.
  it("discards a stale resolve after workspace switch", async () => {
    let resolveA: (v: WorkspaceHealthReport) => void = () => {};
    currentInvokeRef.value = () =>
      new Promise<WorkspaceHealthReport>((resolve) => {
        resolveA = resolve;
      });

    const { result, rerender } = renderHook(({ id }) => useWorkspaceHealth(id), {
      initialProps: { id: "ws-a" },
    });

    await act(async () => {
      result.current.runAudit("ws-a");
    });
    rerender({ id: "ws-b" });

    await act(async () => {
      resolveA(sampleReport);
    });
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // Wave 0 / Test 3: stale reject after switch leaves B error null.
  it("discards a stale reject after workspace switch", async () => {
    let rejectA: (e: unknown) => void = () => {};
    currentInvokeRef.value = () =>
      new Promise((_resolve, reject) => {
        rejectA = reject;
      });

    const { result, rerender } = renderHook(({ id }) => useWorkspaceHealth(id), {
      initialProps: { id: "ws-a" },
    });

    await act(async () => {
      result.current.runAudit("ws-a");
    });
    rerender({ id: "ws-b" });

    await act(async () => {
      rejectA(new Error("p4 down"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.report).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // Wave 0 / Test 4: stale finally must not clear B's loading / in-flight guard.
  it("stale finally does not clear a newer audit's loading or in-flight guard", async () => {
    let resolveA: (v: WorkspaceHealthReport) => void = () => {};
    let resolveB: (v: WorkspaceHealthReport) => void = () => {};
    currentInvokeRef.value = (_cmd: string, args?: unknown) => {
      const workspaceId = (args as { workspaceId?: string } | undefined)?.workspaceId;
      return new Promise<WorkspaceHealthReport>((resolve) => {
        if (workspaceId === "ws-a") resolveA = resolve;
        else resolveB = resolve;
      });
    };

    const { result, rerender } = renderHook(({ id }) => useWorkspaceHealth(id), {
      initialProps: { id: "ws-a" },
    });

    await act(async () => {
      result.current.runAudit("ws-a");
    });
    rerender({ id: "ws-b" });
    await act(async () => {
      result.current.runAudit("ws-b");
    });
    expect(result.current.loading).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveA(sampleReport);
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.report).toBeNull();

    // A's finally must not have dropped B's in-flight guard.
    await act(async () => {
      result.current.runAudit("ws-b");
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveB(sampleReportB);
    });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.report).toEqual(sampleReportB);
  });

  // Wave 0 / Test 5: after switch, Audit for B invokes again.
  it("after switch, runAudit for B invokes checkWorkspaceHealth again", async () => {
    let resolveA: (v: WorkspaceHealthReport) => void = () => {};
    let resolveB: (v: WorkspaceHealthReport) => void = () => {};
    currentInvokeRef.value = (_cmd: string, args?: unknown) => {
      const workspaceId = (args as { workspaceId?: string } | undefined)?.workspaceId;
      return new Promise<WorkspaceHealthReport>((resolve) => {
        if (workspaceId === "ws-a") resolveA = resolve;
        else resolveB = resolve;
      });
    };

    const { result, rerender } = renderHook(({ id }) => useWorkspaceHealth(id), {
      initialProps: { id: "ws-a" },
    });

    await act(async () => {
      result.current.runAudit("ws-a");
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "check_workspace_health", {
      workspaceId: "ws-a",
    });

    rerender({ id: "ws-b" });
    await act(async () => {
      result.current.runAudit("ws-b");
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "check_workspace_health", {
      workspaceId: "ws-b",
    });

    await act(async () => {
      resolveA(sampleReport);
      resolveB(sampleReportB);
    });
  });

  // Wave 0 / Test 7: reset invalidates in-flight — late A resolve must not setReport.
  it("reset() returns idle and a late resolve does not setReport", async () => {
    let resolveA: (v: WorkspaceHealthReport) => void = () => {};
    currentInvokeRef.value = () =>
      new Promise<WorkspaceHealthReport>((resolve) => {
        resolveA = resolve;
      });

    const { result } = renderHook(() => useWorkspaceHealth("ws-1"));

    await act(async () => {
      result.current.runAudit("ws-1");
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      result.current.reset();
    });
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveA(sampleReport);
    });
    expect(result.current.report).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("ignores runAudit when id does not match the hook workspaceId", async () => {
    currentInvokeRef.value = () => Promise.resolve(sampleReport);

    const { result } = renderHook(() => useWorkspaceHealth("ws-1"));

    await act(async () => {
      result.current.runAudit("ws-other");
    });
    expect(invokeMock).toHaveBeenCalledTimes(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.report).toBeNull();
  });
});
