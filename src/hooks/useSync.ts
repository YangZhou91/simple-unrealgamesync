import { useState, useCallback, useRef, useEffect } from "react";
import { Channel } from "@tauri-apps/api/core";
import type {
  SyncEvent,
  SyncState,
  SyncStep,
  StepStatus,
  WarningEntry,
} from "@/lib/types";
import * as commands from "@/lib/commands";
import { mergeProgress } from "@/hooks/mergeProgress";

type StepStatuses = Record<SyncStep, StepStatus>;

const initialStatuses: StepStatuses = {
  closeUe: "pending",
  closeExcel: "pending",
  cleanDevDir: "pending",
  p4Sync: "pending",
  genProject: "pending",
};

export function useSync(
  onSyncComplete?: (cl: string | null) => void,
  onWarningsChange?: (warnings: WarningEntry[]) => void,
) {
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [isCancelling, setIsCancelling] = useState(false);
  const [currentStep, setCurrentStep] = useState<SyncStep | null>(null);
  const [stepStatuses, setStepStatuses] = useState<StepStatuses>(initialStatuses);
  const [targetCl, setTargetCl] = useState<string>("");
  // quick-260713-kx6: opt-out of syncing UnrealEngine engine source during a
  // Target CL sync. Defaults OFF so the subsequent `git pull` of UnrealEngine
  // stays clean. Only the Target CL path reads this — normal HEAD sync and
  // rollback are unaffected (rollback hardcodes include_engine=true server-side).
  const [syncEngine, setSyncEngine] = useState<boolean>(false);
  const [stepDescriptions, setStepDescriptions] = useState<
    Record<SyncStep, string | null>
  >({
    closeUe: null,
    closeExcel: null,
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
      closeExcel: null,
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
    // D-02 (Phase 14): clear the App-owned lastSyncWarnings slot via the
    // up-callback so stale summaries never leak into the next idle screen.
    // Covers both the visibility-change reconcile (:134-166) and the periodic
    // 5s reconcile (:171-188) — both call resetToIdle, so the clear is
    // centralized here.
    onWarningsChange?.([]);
  }, [stopFlushTimer, onWarningsChange]);

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
          // quick-260707-pf9: sticky-merge byte fields. The backend emits two
          // interleaved Progress streams — a high-freq stdout drain (~5/s,
          // byte fields null) and a low-freq heartbeat (~0.5/s, byte fields
          // sampled). Whole-object-overwrite let the drain clobber the
          // heartbeat byte signal ~90% of the time, flickering the byte bar.
          // mergeProgress preserves prev.bytes* when the event omits them,
          // while always taking current/total/currentFile from the event.
          // Functional setProgress((prev) => ...) is required so prev is the
          // latest state across the rapid drain/heartbeat interleaving.
          setProgress((prev) => mergeProgress(prev, event.data));
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
            closeExcel: null,
            cleanDevDir: null,
            p4Sync: null,
            genProject: null,
          });
          setLastSyncResult({
            cl: event.data.changelist,
            fileCount: event.data.filesSynced,
            time: new Date().toLocaleString(),
          });
          // Phase 14 (SUMM-23): report warnings UP to App-owned state via
          // the callback. useSync no longer owns the slot — App.tsx lifts it
          // in Plan 14-02. The ?? [] guard defends against a malformed event.
          onWarningsChange?.(event.data.warnings ?? []);
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
          // D-02 (Phase 14): failure path shows ErrorPanel, not a summary.
          // Clear so a failed-then-dismissed sync does not leak a stale
          // summary when the user returns to idle.
          onWarningsChange?.([]);
          break;
        case "syncCancelled":
          setSyncState("idle");
          syncStateRef.current = "idle";
          setIsCancelling(false);
          setTargetCl("");
          setStepDescriptions({
            closeUe: null,
            closeExcel: null,
            cleanDevDir: null,
            p4Sync: null,
            genProject: null,
          });
          setLastSyncResult({
            cl: null,
            fileCount: 0,
            time: `Cancelled at ${event.data.step}`,
          });
          // D-02 (Phase 14): a cancelled sync did NOT complete — no summary.
          onWarningsChange?.([]);
          break;
      }
    };
    return channel;
  }, [onSyncComplete, onWarningsChange]);

  const startSync = useCallback(
    async (workspaceId: string, cl?: string) => {
      const channel = createEventHandler();
      if (cl) setTargetCl(cl);
      setSyncState("running");
      logBufferRef.current = [];
      setLogLines([]);
      setErrorInfo(null);
      // D-02 (Phase 14): the next sync start clears the prior run's summary.
      onWarningsChange?.([]);
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
        await commands.startSync(workspaceId, channel, cl || undefined, syncEngine);
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
    [createEventHandler, startFlushTimer, stopFlushTimer, resetToIdle, onSyncComplete, onWarningsChange, syncEngine],
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
      // D-02 (Phase 14): a retry is a new run; the prior failed run's summary
      // must not persist.
      onWarningsChange?.([]);
      setStepStatuses(initialStatuses);
      startFlushTimer();
      try {
        await commands.retryStep(workspaceId, step, channel, targetCl || undefined, syncEngine);
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
    [createEventHandler, targetCl, syncEngine, startFlushTimer, stopFlushTimer, resetToIdle, onSyncComplete, onWarningsChange],
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
    syncEngine,
    setSyncEngine,
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
