import { useState, useCallback, useRef, useEffect } from "react";
import { Channel } from "@tauri-apps/api/core";
import type { SyncEvent, GitState } from "@/lib/types";
import type { GitProgressState } from "@/lib/gitProgress";
import * as commands from "@/lib/commands";

export function useGit() {
  const [gitState, setGitState] = useState<GitState>("idle");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [errorInfo, setErrorInfo] = useState<{ error: string } | null>(null);
  // Phase 15 GPULL-24 (frontend) + D-03: surface git's own `%` progress + the
  // sub-step label so GitRunningPanel can render a determinate/indeterminate bar.
  // gitProgress.percent is cleared to null on a no-% StepStarted (so the reducer
  // flips indeterminate); repopulated on the next Progress{percent} (flip-back).
  const [gitProgress, setGitProgress] = useState<GitProgressState | null>(null);
  // WIRE-01: store machine (step, subStep) keys; GitRunningPanel looks up
  // dictionary copy at render. Do not copy StepStarted prose into UI state.
  const [gitCurrentStep, setGitCurrentStep] = useState<string | null>(null);
  const [gitCurrentSubStep, setGitCurrentSubStep] = useState<string | null>(null);
  const logBufferRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Flush buffered log lines to state at ~200ms intervals
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
          // WIRE-01: store machine keys only. Clear percent so decideGitBarMode
          // flips indeterminate for no-% phases (Phase 15 SC#2 flip-back).
          setGitCurrentStep(event.data.step);
          setGitCurrentSubStep(event.data.subStep ?? null);
          setGitProgress((prev) => (prev ? { ...prev, percent: null } : prev));
          break;
        case "logLine":
          logBufferRef.current.push(event.data.line);
          break;
        case "syncCompleted":
          setGitState("success");
          break;
        case "syncFailed":
          setGitState("error");
          setErrorInfo({ error: event.data.error });
          break;
        case "syncCancelled":
          setGitState("idle");
          break;
        case "stepCompleted":
          // Terminal events above handle final state
          break;
        case "progress":
          // Phase 15 GPULL-24: git % events now flow (was a no-op pre-Phase-15).
          // Backend (Plan 02) parses Receiving/Resolving/Compressing `%` from
          // stderr and emits Progress{percent}. Thread percent + phase into state.
          // WR-01 fix: phase now carried on the wire (was hardcoded null) so the
          // bar label reflects the actual phase.
          setGitProgress({
            percent: event.data.percent ?? null,
            phase: event.data.phase ?? null,
            ts: Date.now(),
          });
          break;
      }
    };
    return channel;
  }, []);

  const startGitPull = useCallback(
    async (workspaceId: string) => {
      const channel = createEventHandler();
      logBufferRef.current = [];
      setLogLines([]);
      setErrorInfo(null);
      // Phase 15: reset the git progress bar state for the new run.
      setGitProgress(null);
      setGitCurrentStep(null);
      setGitCurrentSubStep(null);
      setGitState("running");
      startFlushTimer();
      try {
        await commands.gitPull(workspaceId, channel);
      } catch (e) {
        setGitState("error");
        setErrorInfo({ error: String(e) });
      } finally {
        stopFlushTimer();
      }
    },
    [createEventHandler, startFlushTimer, stopFlushTimer],
  );

  const stopGitPull = useCallback(async () => {
    await commands.stopGitPull();
    // Let the syncCancelled/syncFailed event handler set the final state
  }, []);

  const dismissGitResult = useCallback(() => {
    setGitState("idle");
    setLogLines([]);
    setErrorInfo(null);
    // Phase 15: clear the git progress bar state when leaving the result panel.
    setGitProgress(null);
    setGitCurrentStep(null);
    setGitCurrentSubStep(null);
  }, []);

  return {
    gitState,
    logLines,
    errorInfo,
    // Phase 15: git pull determinate progress bar state (GPULL-24/25 frontend).
    gitProgress,
    gitCurrentStep,
    gitCurrentSubStep,
    startGitPull,
    stopGitPull,
    dismissGitResult,
  };
}
