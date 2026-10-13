import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEngineUpdate } from "@/hooks/useEngineUpdate";
import * as commands from "@/lib/commands";
import type { SyncEvent } from "@/lib/types";

// The hook imports `Channel` from @tauri-apps/api/core; substitute a fake that
// simply records `onmessage` so the test can feed SyncEvents synchronously.
vi.mock("@tauri-apps/api/core", () => {
  class Channel {
    onmessage: ((event: unknown) => void) | null = null;
  }
  return { Channel, invoke: vi.fn(() => Promise.resolve()) };
});

vi.mock("@/lib/commands", () => ({
  engineUpdate: vi.fn(() => Promise.resolve()),
  stopEngineUpdate: vi.fn(() => Promise.resolve()),
  getActiveOperation: vi.fn(() => Promise.resolve("engineUpdate")),
}));

/** Controllable promise so a test can defer the command's resolution. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type EngineHook = ReturnType<typeof useEngineUpdate>;

/** Start a run and return the captured Channel the hook handed to the backend. */
function startRun(result: { current: EngineHook }, workspaceId = "ws-1") {
  act(() => {
    void result.current.startEngineUpdate(workspaceId);
  });
  const calls = (commands.engineUpdate as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  return calls[calls.length - 1][1] as { onmessage: (e: SyncEvent) => void };
}

function feed(channel: { onmessage: (e: SyncEvent) => void }, event: SyncEvent) {
  act(() => {
    channel.onmessage(event);
  });
}

const completedEvent: SyncEvent = {
  event: "syncCompleted",
  data: { changelist: "381234", filesSynced: 12, warnings: [] },
};
const genProjectFailure: SyncEvent = {
  event: "syncFailed",
  data: { step: "genProject", error: "GenerateProjectFiles.bat not found" },
};

describe("useEngineUpdate reducer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Test 1 — the regression RESEARCH Pitfall 3 / D-11 asks for. Named so it is
  // greppable as the partial case.
  it("partial: syncCompleted then syncFailed{genProject} maps to partial and keeps both values", () => {
    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);

    act(() => {
      channel.onmessage({
        event: "stepStarted",
        data: { step: "engineUpdate", description: "", subStep: "sync" },
      });
      // Both events in ONE channel flush — the completedRef must be set
      // synchronously for the failure to see a prior completion.
      channel.onmessage(completedEvent);
      channel.onmessage(genProjectFailure);
    });

    expect(result.current.engineState).toBe("partial");
    expect(result.current.resultCl).toBe("381234");
    expect(result.current.errorInfo).toEqual({
      error: "GenerateProjectFiles.bat not found",
    });
    expect(result.current.currentStep).toBe("engineUpdate");
    expect(result.current.currentSubStep).toBe("sync");
  });

  // Test 2 — a lone failure (no prior completion) stays a plain error.
  it("plain error: a lone syncFailed maps to error with its error info", () => {
    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);

    feed(channel, {
      event: "syncFailed",
      data: { step: "engineUpdate", error: "p4 sync failed" },
    });

    expect(result.current.engineState).toBe("error");
    expect(result.current.errorInfo).toEqual({ error: "p4 sync failed" });
    expect(result.current.resultCl).toBeNull();
  });

  // Test 3 — syncCancelled is dismiss-equivalent.
  it("cancelled: syncCancelled yields idle", () => {
    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);
    expect(result.current.engineState).toBe("running");

    feed(channel, { event: "syncCancelled", data: { step: "engineUpdate" } });

    expect(result.current.engineState).toBe("idle");
  });

  // Test 4 — a lone syncCompleted is a clean success carrying the CL.
  it("success: syncCompleted alone yields success carrying the CL", () => {
    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);

    feed(channel, completedEvent);

    expect(result.current.engineState).toBe("success");
    expect(result.current.resultCl).toBe("381234");
    expect(result.current.errorInfo).toBeNull();
  });

  // Test 5 — the 200 ms buffered flush (and the finally-flush on resolution).
  it("log batching: logBatch lines reach the log after the 200 ms flush and on command resolution", async () => {
    vi.useFakeTimers();
    const d = deferred<void>();
    (commands.engineUpdate as unknown as { mockReturnValueOnce: (v: unknown) => void })
      .mockReturnValueOnce(d.promise);

    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);

    act(() => {
      channel.onmessage({
        event: "logBatch",
        data: { lines: ["a", "b", "c"], stream: "stdout" },
      });
    });
    // Buffered — not yet visible before the flush interval elapses.
    expect(result.current.logLines).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.logLines).toEqual(["a", "b", "c"]);

    // A trailing batch arriving after the last interval tick must still land:
    // the finally { stopFlushTimer() } on command resolution flushes it.
    act(() => {
      channel.onmessage({
        event: "logBatch",
        data: { lines: ["d"], stream: "stdout" },
      });
    });
    expect(result.current.logLines).toEqual(["a", "b", "c"]);

    await act(async () => {
      d.resolve();
      await d.promise;
    });
    expect(result.current.logLines).toEqual(["a", "b", "c", "d"]);
  });

  it("log: a single logLine is handled alongside logBatch", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);

    act(() => {
      channel.onmessage({
        event: "logLine",
        data: { line: "single", stream: "stdout" },
      });
      channel.onmessage({
        event: "logBatch",
        data: { lines: ["batched"], stream: "stdout" },
      });
      vi.advanceTimersByTime(200);
    });

    expect(result.current.logLines).toEqual(["single", "batched"]);
  });

  // Test 6 — progress is stored verbatim; total 0 stays 0.
  it("progress: progress updates state and total === 0 is preserved as 0", () => {
    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);

    feed(channel, {
      event: "progress",
      data: { current: 5, total: 0, currentFile: "Engine/Source/Foo.cpp" },
    });

    expect(result.current.progress).toEqual({
      current: 5,
      total: 0,
      currentFile: "Engine/Source/Foo.cpp",
    });
  });

  // Test 7 — restart clears prior run state; a second stop does not throw.
  it("reset/idempotence: a second run clears prior state and stop is safe to call twice", async () => {
    const { result } = renderHook(() => useEngineUpdate());

    // Run 1 → partial.
    const channel1 = startRun(result);
    feed(channel1, completedEvent);
    feed(channel1, genProjectFailure);
    expect(result.current.engineState).toBe("partial");

    // Run 2 → everything from run 1 is cleared.
    const channel2 = startRun(result);
    expect(result.current.engineState).toBe("running");
    expect(result.current.logLines).toEqual([]);
    expect(result.current.errorInfo).toBeNull();
    expect(result.current.resultCl).toBeNull();
    expect(result.current.currentStep).toBeNull();
    expect(result.current.currentSubStep).toBeNull();

    // The completion flag was reset: a lone failure in run 2 is a plain error,
    // NOT the partial it would be if completedRef had leaked across runs.
    feed(channel2, {
      event: "syncFailed",
      data: { step: "engineUpdate", error: "boom" },
    });
    expect(result.current.engineState).toBe("error");

    // stop is idempotent — neither call throws.
    await act(async () => {
      await result.current.stopEngineUpdate();
    });
    await act(async () => {
      await result.current.stopEngineUpdate();
    });
    expect(commands.stopEngineUpdate).toHaveBeenCalledTimes(2);
  });

  it("dismiss returns to idle and clears log/error/result CL", () => {
    const { result } = renderHook(() => useEngineUpdate());
    const channel = startRun(result);
    feed(channel, completedEvent);
    feed(channel, genProjectFailure);
    expect(result.current.engineState).toBe("partial");

    act(() => {
      result.current.dismissEngineResult();
    });

    expect(result.current.engineState).toBe("idle");
    expect(result.current.errorInfo).toBeNull();
    expect(result.current.resultCl).toBeNull();
    expect(result.current.logLines).toEqual([]);
  });
});
