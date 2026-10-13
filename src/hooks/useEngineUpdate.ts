import { useState, useCallback, useRef, useEffect } from "react";
import { Channel } from "@tauri-apps/api/core";
import type { SyncEvent, EngineUpdateState } from "@/lib/types";
import * as commands from "@/lib/commands";

/**
 * Phase 30 (D-11): the engine-update state plane. Mirrors `useGit.ts`'s
 * lifecycle skeleton (Channel handler, 200 ms buffered log flush, machine-key
 * step state, reset-on-start, dismiss-to-idle) with TWO deliberate divergences:
 *
 * 1. The partial rule (RESEARCH Pitfall 3 / UI-SPEC §9.3). The engine backend
 *    emits `SyncCompleted` (the engine's real CL) and THEN
 *    `SyncFailed{step:"genProject"}` with no intervening `StepCompleted` when
 *    GenerateProjectFiles fails. A verbatim copy of `useGit.ts` (which maps
 *    `syncCompleted → success` / `syncFailed → error` unconditionally) would
 *    overwrite the engine's real success and make the `partial` state
 *    unreachable. This reducer tracks `completedRef` and resolves that ordered
 *    pair to `partial`. A lone `syncFailed` (no prior completion) stays `error`.
 * 2. `logBatch` handling. `git_service` sends per-line `LogLine`; the engine
 *    drains send `LogBatch` (500 lines / 200 ms). Missing this case would leave
 *    the engine panel rendering an empty log forever.
 */
export function useEngineUpdate() {
  const [engineState, setEngineState] = useState<EngineUpdateState>("idle");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [errorInfo, setErrorInfo] = useState<{ error: string } | null>(null);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    currentFile: string;
  }>({ current: 0, total: 0, currentFile: "" });
  // The CL from `syncCompleted` — the *result* CL, distinct from the card's
  // live have-CL that App owns (engineCl).
  const [resultCl, setResultCl] = useState<string | null>(null);
  // WIRE-01: store machine (step, subStep) keys; the panel looks up dictionary
  // copy at render. Never copy StepStarted prose into UI state.
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [currentSubStep, setCurrentSubStep] = useState<string | null>(null);
  const logBufferRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set synchronously by `syncCompleted` in the same tick as its handler, so a
  // subsequent `syncFailed` in the same channel flush can see it. A state
  // variable would be stale here — both events can arrive in one flush.
  const completedRef = useRef(false);
  const engineStateRef = useRef<EngineUpdateState>("idle");
  engineStateRef.current = engineState;

  // Flush buffered log lines to state at ~200 ms intervals (mirrors useGit).
  const flushLogBuffer = useCallback(() => {
    if (logBufferRef.current.length > 0) {
      const batch = logBufferRef.current;
      logBufferRef.current = [];
      setLogLines((prev) => prev.concat(batch));
    }
  }, []);

  const startFlushTimer = useCallback(() => {
    if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    flushTimerRef.current = setInterval(flushLogBuffer, 200);
  }, [flushLogBuffer]);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushLogBuffer();
  }, [flushLogBuffer]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, []);

  const createEventHandler = useCallback(() => {
    const channel = new Channel<SyncEvent>();
    channel.onmessage = (event: SyncEvent) => {
      switch (event.event) {
        case "stepStarted":
          // WIRE-01: machine keys only — prose is looked up at render.
          setCurrentStep(event.data.step);
          setCurrentSubStep(event.data.subStep ?? null);
          break;
        case "logLine":
          logBufferRef.current.push(event.data.line);
          break;
        case "logBatch":
          // Engine drains batch at 500 lines / 200 ms (D-11 / T-30-14).
          logBufferRef.current.push(...event.data.lines);
          break;
        case "syncCompleted":
          // Load-bearing (Pitfall 3): mark completion BEFORE any later
          // syncFailed can be reduced, and keep the engine's real CL.
          completedRef.current = true;
          setResultCl(event.data.changelist);
          setEngineState("success");
          break;
        case "syncFailed":
          setErrorInfo({ error: event.data.error });
          // The ordered pair (SyncCompleted then SyncFailed{genProject}) is a
          // PARTIAL success, not a plain error. A lone failure stays "error".
          setEngineState(completedRef.current ? "partial" : "error");
          break;
        case "syncCancelled":
          // Dismiss-equivalent, mirroring useGit.ts:72-74.
          setEngineState("idle");
          break;
        case "stepCompleted":
          // Terminal events above decide the final state.
          break;
        case "progress":
          // Store verbatim; a total of 0 stays 0 (never a fabricated
          // denominator — the panel renders the indeterminate bar for it).
          setProgress({
            current: event.data.current,
            total: event.data.total,
            currentFile: event.data.currentFile,
          });
          break;
      }
    };
    return channel;
  }, []);

  const startEngineUpdate = useCallback(
    async (workspaceId: string) => {
      const channel = createEventHandler();
      logBufferRef.current = [];
      setLogLines([]);
      setErrorInfo(null);
      setResultCl(null);
      setProgress({ current: 0, total: 0, currentFile: "" });
      setCurrentStep(null);
      setCurrentSubStep(null);
      completedRef.current = false;
      setEngineState("running");
      startFlushTimer();
      try {
        await commands.engineUpdate(workspaceId, channel);
      } catch (e) {
        setEngineState("error");
        setErrorInfo({ error: String(e) });
      } finally {
        // Guarantees no trailing LogBatch is lost when the command resolves
        // (the terminal state is only rendered after the final flush).
        stopFlushTimer();
      }
    },
    [createEventHandler, startFlushTimer, stopFlushTimer],
  );

  const stopEngineUpdate = useCallback(async () => {
    // Let the syncCancelled/syncFailed event handler set the final state.
    // A second call is a no-op: the backend's stop_all finds nothing tracked.
    await commands.stopEngineUpdate();
  }, []);

  const dismissEngineResult = useCallback(() => {
    setEngineState("idle");
    setLogLines([]);
    setErrorInfo(null);
    setResultCl(null);
    setProgress({ current: 0, total: 0, currentFile: "" });
    setCurrentStep(null);
    setCurrentSubStep(null);
    completedRef.current = false;
  }, []);

  // Visibility/focus reconcile (mirrors useSync.ts:136-168, but no 5 s poll —
  // RESEARCH Open Question 2 recommends against it for a short user-initiated
  // action). While the engine state is "running", ask the single authority; a
  // lost channel event after a WebView suspend must not leave the panel stuck.
  useEffect(() => {
    if (engineState !== "running") return;

    const reconcileIfStale = async () => {
      if (engineStateRef.current !== "running") return;
      try {
        const active = await commands.getActiveOperation();
        if (active !== "engineUpdate") {
          console.warn(
            "[useEngineUpdate] Backend engine update finished while WebView was suspended/throttled — resetting UI to idle",
          );
          setEngineState("idle");
        }
      } catch {
        // If the query fails, leave state as-is — don't disrupt an active run.
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void reconcileIfStale();
    };
    const handleFocus = () => {
      void reconcileIfStale();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [engineState]);

  return {
    engineState,
    logLines,
    errorInfo,
    progress,
    resultCl,
    currentStep,
    currentSubStep,
    startEngineUpdate,
    stopEngineUpdate,
    dismissEngineResult,
  };
}
