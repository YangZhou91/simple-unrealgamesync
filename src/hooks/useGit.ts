import { useState, useCallback, useRef, useEffect } from "react";
import { Channel } from "@tauri-apps/api/core";
import type { SyncEvent, GitState } from "@/lib/types";
import * as commands from "@/lib/commands";

export function useGit() {
  const [gitState, setGitState] = useState<GitState>("idle");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [errorInfo, setErrorInfo] = useState<{ error: string } | null>(null);
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
          // step === "gitPull" — no step tracking needed
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
          // Git pull doesn't produce progress events
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
  }, []);

  return {
    gitState,
    logLines,
    errorInfo,
    startGitPull,
    stopGitPull,
    dismissGitResult,
  };
}
