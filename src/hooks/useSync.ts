import { useState, useCallback, useRef, useEffect } from "react";
import { Channel } from "@tauri-apps/api/core";
import type {
  SyncEvent,
  SyncState,
  SyncStep,
  StepStatus,
} from "@/lib/types";
import * as commands from "@/lib/commands";

type StepStatuses = Record<SyncStep, StepStatus>;

const initialStatuses: StepStatuses = {
  closeUe: "pending",
  cleanDevDir: "pending",
  p4Sync: "pending",
  genProject: "pending",
};

export function useSync(onSyncComplete?: (cl: string | null) => void) {
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [isCancelling, setIsCancelling] = useState(false);
  const [currentStep, setCurrentStep] = useState<SyncStep | null>(null);
  const [stepStatuses, setStepStatuses] = useState<StepStatuses>(initialStatuses);
  const [targetCl, setTargetCl] = useState<string>("");
  const [stepDescriptions, setStepDescriptions] = useState<
    Record<SyncStep, string | null>
  >({
    closeUe: null,
    cleanDevDir: null,
    p4Sync: null,
    genProject: null,
  });
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    currentFile: string;
    bytesDone: number | null;
    bytesTotal: number | null;
    bytesRate: number | null;
  }>({
    current: 0,
    total: 0,
    currentFile: "",
    bytesDone: null,
    bytesTotal: null,
    bytesRate: null,
  });
  const [logLines, setLogLines] = useState<string[]>([]);
  const logBufferRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Flush buffered log lines to state at ~200ms intervals to avoid UI freeze
  const flushLogBuffer = useCallback(() => {
    if (logBufferRef.current.length > 0) {
      const batch = logBufferRef.current;
      logBufferRef.current = [];
      setLogLines((prev) => {
        const next = prev.concat(batch);
        return next;
      });
    }
  }, []);

  // Start/stop the flush timer with sync lifecycle
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
  const [errorInfo, setErrorInfo] = useState<{
    step: string;
    error: string;
  } | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<{
    cl: string | null;
    fileCount: number;
    time: string;
  } | null>(null);

  // Ref to access current syncState inside event listeners without stale closures
  const syncStateRef = useRef<SyncState>(syncState);
  syncStateRef.current = syncState;

  const resetToIdle = useCallback(() => {
    setSyncState("idle");
    setIsCancelling(false);
    setTargetCl("");
    setCurrentStep(null);
    setStepStatuses(initialStatuses);
    setStepDescriptions({
      closeUe: null,
      cleanDevDir: null,
      p4Sync: null,
      genProject: null,
    });
    setProgress({
      current: 0,
      total: 0,
      currentFile: "",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    });
    stopFlushTimer();
  }, [stopFlushTimer]);

  // On window visibility change or focus (resume from minimize/background/
  // throttled state), check if the backend is still running a sync.
  // If the backend says "not running" but frontend shows "running", it means
  // Channel events were lost while WebView2 suspended or throttled the renderer
  // — reset UI. `visibilitychange` only fires on hidden<->visible transitions;
  // `focus` also catches a throttled-but-visible window the user clicks back
  // into, which is the WebView2 case that froze all timer-based safety nets.
  useEffect(() => {
    const reconcileIfStale = async () => {
      // Only reconcile if frontend thinks a sync is running
      if (syncStateRef.current !== "running") return;

      try {
        const running = await commands.isSyncRunning();
        if (!running) {
          console.warn("[useSync] Backend sync completed while WebView was suspended/throttled — resetting UI to idle");
          resetToIdle();
          // Trigger onSyncComplete so the parent can refresh CL/history
          onSyncComplete?.(null);
        }
      } catch {
        // If the query fails, leave state as-is — don't disrupt an active sync
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
  }, [resetToIdle, onSyncComplete]);

  // Periodic reconciliation: while syncState is "running", poll isSyncRunning
  // every 5s. If the backend says it's done but Channel events were lost
  // (WebView2 throttling, IPC buffering, etc.), auto-reset the UI.
  useEffect(() => {
    if (syncState !== "running") return;

    const timer = setInterval(async () => {
      try {
        const running = await commands.isSyncRunning();
        if (!running) {
          console.warn("[useSync] Periodic reconciliation: backend finished but UI still running — resetting");
          resetToIdle();
          onSyncComplete?.(null);
        }
      } catch {
        // Ignore — don't disrupt an active sync
      }
    }, 5000);

    return () => clearInterval(timer);
  }, [syncState, resetToIdle, onSyncComplete]);

  const createEventHandler = useCallback(() => {
    const channel = new Channel<SyncEvent>();
    channel.onmessage = (event: SyncEvent) => {
      switch (event.event) {
        case "stepStarted":
          setCurrentStep(event.data.step as SyncStep);
          setStepStatuses((prev) => ({
            ...prev,
            [event.data.step]: "active",
          }));
          setStepDescriptions((prev) => ({
            ...prev,
            [event.data.step]: event.data.description ?? null,
          }));
          break;
        case "stepCompleted":
          setStepStatuses((prev) => ({
            ...prev,
            [event.data.step]: event.data.success ? "completed" : "failed",
          }));
          break;
        case "progress":
          setProgress({
            current: event.data.current,
            total: event.data.total,
            currentFile: event.data.currentFile,
            bytesDone: event.data.bytesDone ?? null,
            bytesTotal: event.data.bytesTotal ?? null,
            bytesRate: event.data.bytesRate ?? null,
          });
          break;
        case "logLine":
          logBufferRef.current.push(event.data.line);
          break;
        case "logBatch":
          // Append all lines from the batch in one operation — avoids 226K individual
          // IPC messages being processed one-by-one during a large p4 sync.
          for (const line of event.data.lines) {
            logBufferRef.current.push(line);
          }
          break;
        case "syncCompleted":
          setSyncState("idle");
          syncStateRef.current = "idle";
          setTargetCl("");
          setStepDescriptions({
            closeUe: null,
            cleanDevDir: null,
            p4Sync: null,
            genProject: null,
          });
          setLastSyncResult({
            cl: event.data.changelist,
            fileCount: event.data.filesSynced,
            time: new Date().toLocaleString(),
          });
          onSyncComplete?.(event.data.changelist ?? null);
          break;
        case "syncFailed":
          setSyncState("error");
          syncStateRef.current = "error";
          setIsCancelling(false);
          setErrorInfo({
            step: event.data.step,
            error: event.data.error,
          });
          break;
        case "syncCancelled":
          setSyncState("idle");
          syncStateRef.current = "idle";
          setIsCancelling(false);
          setTargetCl("");
          setStepDescriptions({
            closeUe: null,
            cleanDevDir: null,
            p4Sync: null,
            genProject: null,
          });
          setLastSyncResult({
            cl: null,
            fileCount: 0,
            time: `Cancelled at ${event.data.step}`,
          });
          break;
      }
    };
    return channel;
  }, [onSyncComplete]);

  const startSync = useCallback(
    async (workspaceId: string, cl?: string) => {
      const channel = createEventHandler();
      if (cl) setTargetCl(cl);
      setSyncState("running");
      logBufferRef.current = [];
      setLogLines([]);
      setErrorInfo(null);
      setProgress({
        current: 0,
        total: 0,
        currentFile: "",
        bytesDone: null,
        bytesTotal: null,
        bytesRate: null,
      });
      setStepStatuses(initialStatuses);
      startFlushTimer();
      try {
        await commands.startSync(workspaceId, channel, cl || undefined);
        // Authoritative completion: the command only resolves after the backend
        // pipeline fully ends. If the terminal Channel event (syncCompleted/
        // syncCancelled/syncFailed) was dropped while the WebView was backgrounded,
        // syncStateRef is still "running" — reconcile to idle now.
        if (syncStateRef.current === "running") {
          console.warn("[useSync] startSync resolved but UI still running — syncCompleted event lost, reconciling to idle");
          resetToIdle();
          onSyncComplete?.(null);
        }
      } catch (e) {
        setSyncState("error");
        setErrorInfo({
          step: "startup",
          error: String(e),
        });
      } finally {
        stopFlushTimer();
      }
    },
    [createEventHandler, startFlushTimer, stopFlushTimer, resetToIdle, onSyncComplete],
  );

  const stopSync = useCallback(async () => {
    setIsCancelling(true);
    await commands.stopSync();
    // Let the syncCancelled or syncFailed event handler reset isCancelling
  }, []);

  const retryStep = useCallback(
    async (workspaceId: string, step: string) => {
      const channel = createEventHandler();
      setSyncState("running");
      setErrorInfo(null);
      setStepStatuses(initialStatuses);
      startFlushTimer();
      try {
        await commands.retryStep(workspaceId, step, channel, targetCl || undefined);
        // Authoritative completion: command resolution is a reliable end-of-pipeline
        // signal independent of best-effort Channel delivery. Reconcile if the
        // terminal event was lost while backgrounded.
        if (syncStateRef.current === "running") {
          console.warn("[useSync] retryStep resolved but UI still running — syncCompleted event lost, reconciling to idle");
          resetToIdle();
          onSyncComplete?.(null);
        }
      } catch (e) {
        setSyncState("error");
        setErrorInfo({ step, error: String(e) });
      } finally {
        stopFlushTimer();
      }
    },
    [createEventHandler, targetCl, startFlushTimer, stopFlushTimer, resetToIdle, onSyncComplete],
  );

  const dismissError = useCallback(() => {
    setSyncState("idle");
    setErrorInfo(null);
  }, []);

  return {
    syncState,
    isCancelling,
    currentStep,
    stepStatuses,
    targetCl,
    setTargetCl,
    stepDescriptions,
    progress,
    logLines,
    errorInfo,
    lastSyncResult,
    startSync,
    stopSync,
    retryStep,
    dismissError,
  };
}
