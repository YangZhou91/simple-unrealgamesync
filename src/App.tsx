import { AppLayout } from "@/components/layout/AppLayout";
import { AppTitleBar } from "@/components/layout/AppTitleBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { SyncDashboard } from "@/components/sync/SyncDashboard";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { RollbackDialog } from "@/components/history/RollbackDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceEmptyState } from "@/components/workspace/WorkspaceEmptyState";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { useSync } from "@/hooks/useSync";
import { useGit } from "@/hooks/useGit";
import { useEngineUpdate } from "@/hooks/useEngineUpdate";
import { useBehindCheck } from "@/hooks/useBehindCheck";
import { useHistory } from "@/hooks/useHistory";
import { useUpdater } from "@/hooks/useUpdater";
import { useState, useCallback, useEffect, useRef } from "react";
import * as commands from "@/lib/commands";
import type { EnginePath, GitBranchInfo, WarningEntry } from "@/lib/types";

function App() {
  const workspaces = useWorkspaces();
  const refreshCurrentCl = workspaces.refreshCurrentCl;

  // Phase 14 (SUMM-23 — checker blocker #1 fix): App owns the last-sync
  // warnings slot as lifted state. Both useSync (forward/force-sync via
  // onWarningsChange) and useHistory (rollback via the widened
  // onRollbackComplete) report UP into this single slot — there is no
  // per-completion-path branch in the render layer, so all three completion
  // paths render identically through the same IdlePanel.
  const [lastSyncWarnings, setLastSyncWarnings] = useState<WarningEntry[]>([]);

  // Phase 31 (D-01/D-04/D-09, PTHS-01): the engine-update path token, lifted
  // here rather than beside engineCl because onSyncComplete's useCallback deps
  // include fetchEnginePath — a later `const` would be in the TDZ at the deps
  // array's evaluation point. The probe is one invoke with no Channel/log/step
  // machine, so it stays App-lifted state (no new hook, 31-RESEARCH P2).
  const [enginePath, setEnginePath] = useState<EnginePath>("unknown");
  // Monotonically-increasing request guard — the Phase 27 useBehindCheck
  // precedent (useBehindCheck.ts:15-23). A rapid A->B workspace switch must not
  // apply A's stale probe response.
  const enginePathRequestIdRef = useRef(0);
  // Phase 31 gap #1 fix (CR-01 / 31-VERIFICATION must-have truth #6): the id
  // the CURRENT token was resolved for. The token is derived from
  // (selected-workspace id, probe outcome), so a switch to a DIFFERENT
  // workspace must clear it synchronously — before the new probe is awaited —
  // or B renders A's resolved card for B's whole in-flight window. Kept beside
  // (not folded into) enginePathRequestIdRef, which is complementary rather
  // than redundant: the request-id guard drops a stale RESPONSE, this ref
  // clears a stale TOKEN.
  const enginePathWorkspaceIdRef = useRef<string | null>(null);

  const fetchEnginePath = useCallback(async () => {
    // Phase 31 gap #1 fix: reset on a SELECTED-workspace identity change, never
    // on a re-probe of the same workspace. The reset is synchronous (before any
    // await) so the new workspace's entire in-flight window renders the
    // both-cards default (UI-SPEC §8.1/§9.3) — no spinner, no checking chrome.
    // D-04's four completion legs re-probe the SAME workspace and must keep the
    // current card on screen while that probe is in flight.
    const selectedId = workspaces.selectedWorkspace?.id ?? null;
    if (selectedId !== enginePathWorkspaceIdRef.current) {
      enginePathWorkspaceIdRef.current = selectedId;
      setEnginePath("unknown");
    }
    const requestId = ++enginePathRequestIdRef.current;
    if (workspaces.selectedWorkspace) {
      try {
        const p = await commands.enginePath(workspaces.selectedWorkspace.id);
        // Drop a stale response from a superseded request.
        if (requestId !== enginePathRequestIdRef.current) return;
        // Narrowing guard: the blanket vitest invoke mock resolves `undefined`,
        // which must never reach state (RESEARCH Pitfall 5).
        if (p === "git" || p === "p4" || p === "none") {
          setEnginePath(p);
        }
      } catch (e) {
        // Phase 31 gap #2 fix: a failed probe clears the token for the request
        // that is still current, so the both-cards status-quo render (UI-SPEC
        // §9.3) holds after a PRIOR resolution too — a rejection can no longer
        // leave a stale, clickable engine card on screen. Guarded by the same
        // stale-drop rule as the success path, so a superseded probe's late
        // rejection never overwrites a newer resolution. Never error the UI
        // over a failed stat.
        if (requestId === enginePathRequestIdRef.current) {
          setEnginePath("unknown");
        }
        console.error("Engine path probe failed:", e);
      }
    } else {
      // D-09: no workspace selected is NEVER "none".
      setEnginePath("unknown");
    }
  }, [workspaces.selectedWorkspace]);

  // D-04's switch leg: re-probe on workspace switch (mirrors fetchGitStatus).
  useEffect(() => {
    fetchEnginePath();
  }, [fetchEnginePath]);

  const onRollbackComplete = useCallback(
    (cl: string | null, warnings: WarningEntry[]) => {
      refreshCurrentCl(cl);
      // Phase 14 (SUMM-23): route rollback's backend `warnings: merged`
      // (sync_orchestrator.rs:484) into the lifted slot. Rollback's
      // SyncCompleted arrives on useHistory's OWN Channel, distinct from
      // useSync's — without this wiring rollback warnings never render.
      setLastSyncWarnings(warnings);
    },
    [refreshCurrentCl],
  );
  const history = useHistory(workspaces.selectedWorkspace?.id ?? null, onRollbackComplete);

  // Single sync hook that refreshes history on completion
  const onSyncComplete = useCallback(
    (cl: string | null) => {
      refreshCurrentCl(cl);
      history.loadHistory();
      // Phase 31 (D-04): re-probe the engine path after a sync/rollback
      // terminal, so D-02's external `.git` rename escape hatch re-resolves.
      fetchEnginePath();
    },
    [refreshCurrentCl, history.loadHistory, fetchEnginePath],
  );
  // Phase 14 (SUMM-23): forward/force-sync warnings flow UP via the
  // onWarningsChange callback (Plan 14-01 Task 2 added the param).
  // CR-WR-01: memoized like onSyncComplete/onRollbackComplete — a raw arrow
  // here gets a fresh reference every App render, and since App re-renders
  // ~5×/sec on sync.progress, that propagates into useSync's resetToIdle
  // dep array and tears down + re-creates the 5s periodic-reconciliation
  // setInterval before it can ever elapse, defeating the safety net
  // designed for exactly the running-sync case. setLastSyncWarnings is a
  // stable setState dispatcher, so [] is safe.
  const onWarningsChange = useCallback(
    (w: WarningEntry[]) => setLastSyncWarnings(w),
    [],
  );
  const sync = useSync(onSyncComplete, onWarningsChange);
  const git = useGit();
  const engine = useEngineUpdate();
  const behind = useBehindCheck();
  const updater = useUpdater();
  const isSyncRunning = sync.syncState === "running";
  const isOperationRunning =
    isSyncRunning ||
    history.isRollingBack ||
    git.gitState === "running" ||
    engine.engineState === "running";
  const [gitBranchInfo, setGitBranchInfo] = useState<GitBranchInfo | null>(null);
  const [gitBranchLoading, setGitBranchLoading] = useState(false);
  // Phase 30 (D-10): the engine subtree's own have-CL for the idle engine
  // card's status line (null = not-yet-fetched OR fetch failed — the row
  // renders the label alone). Distinct from workspaces.currentCl, which is
  // the PROJECT's CL and must never appear in the engine card.
  const [engineCl, setEngineCl] = useState<string | null>(null);
  // Phase 31 WR-01 fold: the id engineCl was resolved for. Same root cause
  // class and same file as the gap-#1 fix — the sibling derivation had no
  // identity reset, so the engine card could carry the PREVIOUS workspace's
  // have-CL across a switch. The catch -> setEngineCl(null) and the
  // null-workspace branch already cover the failure and no-workspace legs, so
  // only the identity reset is added.
  const engineClWorkspaceIdRef = useRef<string | null>(null);
  // P4 stream of the selected workspace's client spec (null = classic client
  // OR not-yet-fetched OR fetch failed — the UI shows the `classic client`
  // placeholder in all three cases). Static per-client — fetched once on
  // workspace switch, never polled.
  const [streamInfo, setStreamInfo] = useState<string | null>(null);

  const fetchGitStatus = useCallback(async () => {
    if (workspaces.selectedWorkspace) {
      setGitBranchLoading(true);
      try {
        const info = await commands.gitStatus(workspaces.selectedWorkspace.id);
        setGitBranchInfo(info);
      } catch {
        setGitBranchInfo(null);
      } finally {
        setGitBranchLoading(false);
      }
    } else {
      setGitBranchInfo(null);
      setGitBranchLoading(false);
    }
  }, [workspaces.selectedWorkspace]);

  useEffect(() => {
    fetchGitStatus();
  }, [fetchGitStatus]);

  // Phase 30 (D-10): fetch the engine subtree's have-CL eagerly on workspace
  // switch, mirroring fetchGitStatus — non-blocking, failure → null (the
  // status row renders the label alone).
  const fetchEngineCl = useCallback(async () => {
    // WR-01 fold: clear on a selected-workspace identity change BEFORE the
    // await, so the engine card never shows another workspace's CL for the
    // in-flight window. A same-workspace re-fetch (the D-10 dismiss/engine-update
    // legs) keeps the current value on screen.
    const selectedId = workspaces.selectedWorkspace?.id ?? null;
    if (selectedId !== engineClWorkspaceIdRef.current) {
      engineClWorkspaceIdRef.current = selectedId;
      setEngineCl(null);
    }
    if (workspaces.selectedWorkspace) {
      try {
        const cl = await commands.engineStatus(workspaces.selectedWorkspace.id);
        setEngineCl(cl);
      } catch {
        setEngineCl(null);
      }
    } else {
      setEngineCl(null);
    }
  }, [workspaces.selectedWorkspace]);

  useEffect(() => {
    fetchEngineCl();
  }, [fetchEngineCl]);

  // Fetch the bound p4 stream once per workspace switch (mirrors git status —
  // no loading flag needed; the workspace's p4Client line renders immediately
  // regardless and stream is fast). Catch -> null so a p4 failure shows the
  // placeholder instead of an error toast.
  const fetchStream = useCallback(async () => {
    if (workspaces.selectedWorkspace) {
      try {
        const s = await commands.getWorkspaceStream(workspaces.selectedWorkspace.id);
        setStreamInfo(s);
      } catch {
        setStreamInfo(null);
      }
    } else {
      setStreamInfo(null);
    }
  }, [workspaces.selectedWorkspace]);

  useEffect(() => {
    fetchStream();
  }, [fetchStream]);

  // Idle Perforce behind-check: fires immediately when the idle view loads,
  // then repeats every intervalMinutes. Never runs while a sync is in progress,
  // and any in-flight result is dropped (behind.cancel) when leaving the idle state.
  const behindRunCheck = behind.runCheck;
  const behindCancel = behind.cancel;
  const selectedWorkspaceId = workspaces.selectedWorkspace?.id ?? null;
  const intervalMinutes = workspaces.selectedWorkspace?.intervalMinutes ?? 60;
  useEffect(() => {
    if (isOperationRunning || !selectedWorkspaceId) {
      // Suppressed while syncing (or no workspace) — invalidate pending result.
      behindCancel();
      return;
    }

    // Fire immediately so the badge is populated as soon as the idle view loads.
    behindRunCheck(selectedWorkspaceId);

    const intervalTimer = setInterval(() => {
      behindRunCheck(selectedWorkspaceId);
    }, intervalMinutes * 60_000);

    return () => {
      clearInterval(intervalTimer);
    };
  }, [selectedWorkspaceId, intervalMinutes, isOperationRunning, behindRunCheck, behindCancel]);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isWorkspaceFormOpen, setIsWorkspaceFormOpen] = useState(false);
  const [settingsKey, setSettingsKey] = useState(0);
  const [isRollbackDialogOpen, setIsRollbackDialogOpen] = useState(false);

  const handleStartSync = () => {
    if (isOperationRunning) {
      return;
    }
    if (workspaces.selectedWorkspace) {
      sync.startSync(
        workspaces.selectedWorkspace.id,
        sync.targetCl || undefined,
      );
    }
  };

  const handleRetryStep = (step: string) => {
    if (workspaces.selectedWorkspace) {
      sync.retryStep(workspaces.selectedWorkspace.id, step);
    }
  };

  const handleRollback = () => {
    setIsRollbackDialogOpen(true);
  };

  const handleRollbackConfirm = (targetCl: string) => {
    if (workspaces.selectedWorkspace) {
      // Phase 14 (D-02 — checker blocker #2 fix): clear the prior summary
      // BEFORE the rollback starts so a stale summary never persists into
      // the new run. useSync's 5 clear sites (Plan 14-01) cover the sync
      // lifecycle; this + handleGitPull cover rollback + git-pull starts.
      setLastSyncWarnings([]);
      history.startRollback(targetCl);
      setIsRollbackDialogOpen(false);
    }
  };

  const handleGitPull = useCallback(async () => {
    if (isOperationRunning) {
      return;
    }
    if (workspaces.selectedWorkspace) {
      // Phase 14 (D-02 — checker blocker #2 fix): clear the prior summary
      // BEFORE git-pull starts. git-pull emits empty warnings
      // (git_service.rs:381-386), so this is a pure clear — it never
      // populates, only wipes the slate so a stale sync summary does not
      // persist into a git-pull idle screen.
      setLastSyncWarnings([]);
      try {
        await git.startGitPull(workspaces.selectedWorkspace.id);
        fetchGitStatus();
        // Phase 31 (D-04): re-probe after a git-pull terminal.
        fetchEnginePath();
      } catch {
        // Error handling is done in useGit hook
      }
    }
  }, [workspaces.selectedWorkspace, git.startGitPull, fetchGitStatus, fetchEnginePath, isOperationRunning]);

  const handleEngineUpdate = useCallback(async () => {
    if (isOperationRunning) {
      return;
    }
    if (workspaces.selectedWorkspace) {
      // Clear the prior summary BEFORE the engine update starts, mirroring
      // handleGitPull (Phase 14 D-02). The engine update emits no project
      // warnings, so this is a pure clear.
      setLastSyncWarnings([]);
      try {
        await engine.startEngineUpdate(workspaces.selectedWorkspace.id);
        // Refresh the engine have-CL after the run so the D-10 status row is
        // honest, exactly as the git handler refreshes the branch.
        fetchEngineCl();
        // Phase 31 (D-04): re-probe after an engine-update terminal.
        fetchEnginePath();
      } catch {
        // Error handling is done in useEngineUpdate hook
      }
    }
  }, [workspaces.selectedWorkspace, engine.startEngineUpdate, fetchEngineCl, fetchEnginePath, isOperationRunning]);

  // D-11 partial-state Retry reuses the same engine_update command — no new
  // command is introduced (UI-SPEC §8.4).
  const handleEngineRetry = useCallback(async () => {
    if (isOperationRunning) {
      return;
    }
    if (workspaces.selectedWorkspace) {
      try {
        await engine.startEngineUpdate(workspaces.selectedWorkspace.id);
        fetchEngineCl();
        // Phase 31 (D-04): re-probe after the retry terminal.
        fetchEnginePath();
      } catch {
        // Error handling is done in useEngineUpdate hook
      }
    }
  }, [workspaces.selectedWorkspace, engine.startEngineUpdate, fetchEngineCl, fetchEnginePath, isOperationRunning]);

  return (
    <TooltipProvider>
      {/* 24-02 (D-03): titlebar + shell share one 100vh column — AppLayout's
          root (h-screen min-h-0) shrinks to 100vh-34px inside this wrapper,
          so the added bar does not push the shell past the viewport. */}
      <div className="flex h-screen flex-col">
        <AppTitleBar />
        <AppLayout
          sidebar={
          <Sidebar
            workspaces={workspaces.workspaces}
            selectedId={workspaces.selectedId}
            currentCl={workspaces.currentCl}
            isBusy={isOperationRunning}
            onSelect={workspaces.selectWorkspace}
            onDelete={workspaces.deleteWorkspace}
            onAdd={workspaces.addWorkspace}
            onOpenSettings={() => setIsSettingsOpen(true)}
            isSettingsDisabled={isOperationRunning}
            updaterInfo={updater.info}
            onCheckUpdate={updater.checkAndInstall}
            isFormOpen={isWorkspaceFormOpen}
            onFormOpenChange={setIsWorkspaceFormOpen}
          />
        }
      >
        {workspaces.workspaces.length === 0 && !workspaces.isLoading ? (
          <WorkspaceEmptyState onAdd={() => setIsWorkspaceFormOpen(true)} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <WorkspaceHeader
              selectedWorkspace={workspaces.selectedWorkspace}
              stream={streamInfo}
              p4Client={workspaces.selectedWorkspace?.p4Client ?? null}
              gitBranchInfo={gitBranchInfo}
              gitBranchLoading={gitBranchLoading}
            />
            <SyncDashboard
            syncState={sync.syncState}
            stepStatuses={sync.stepStatuses}
            progress={sync.progress}
            logLines={sync.logLines}
            currentStep={sync.currentStep}
            errorInfo={sync.errorInfo}
            lastSyncResult={sync.lastSyncResult}
            lastSyncWarnings={lastSyncWarnings}
            selectedWorkspace={workspaces.selectedWorkspace}
            targetCl={sync.targetCl}
            onTargetClChange={sync.setTargetCl}
            syncEngine={sync.syncEngine}
            onSyncEngineChange={sync.setSyncEngine}
            currentSubStep={sync.currentSubStep}
            onStartSync={handleStartSync}
            onStopSync={sync.stopSync}
            isCancelling={sync.isCancelling}
            onRetryStep={handleRetryStep}
            onDismissError={sync.dismissError}
            onRollback={handleRollback}
            historyRecords={history.records}
            historyLoading={history.isLoading}
            historyRollingBack={history.isRollingBack}
            gitState={git.gitState}
            gitLogLines={git.logLines}
            gitErrorInfo={git.errorInfo}
            gitProgress={git.gitProgress}
            gitCurrentStep={git.gitCurrentStep}
            gitCurrentSubStep={git.gitCurrentSubStep}
            onGitPull={handleGitPull}
            onStopGitPull={git.stopGitPull}
            onDismissGitResult={git.dismissGitResult}
            gitBranchInfo={gitBranchInfo}
            gitBranchLoading={gitBranchLoading}
            behindInfo={behind.behindInfo}
            behindLoading={behind.behindLoading}
            stream={streamInfo}
            p4Client={workspaces.selectedWorkspace?.p4Client ?? null}
            currentCl={workspaces.currentCl}
            engineState={engine.engineState}
            engineLogLines={engine.logLines}
            engineErrorInfo={engine.errorInfo}
            engineProgress={engine.progress}
            engineCurrentStep={engine.currentStep}
            engineCurrentSubStep={engine.currentSubStep}
            engineResultCl={engine.resultCl}
            engineIsCancelling={engine.isCancelling}
            engineCl={engineCl}
            enginePath={enginePath}
            onEngineUpdate={handleEngineUpdate}
            onStopEngineUpdate={engine.stopEngineUpdate}
            // On dismiss, re-fetch the engine have-CL so the idle row shows the
            // new CL (UI-SPEC §8.5).
            onDismissEngineResult={() => {
              engine.dismissEngineResult();
              fetchEngineCl();
            }}
            onRetryEngineUpdate={handleEngineRetry}
            />
          </div>
        )}
        </AppLayout>
      </div>
      <SettingsDialog
        key={settingsKey}
        open={isSettingsOpen}
        onOpenChange={(open) => {
          setIsSettingsOpen(open);
          if (!open) setSettingsKey((k) => k + 1);
        }}
        workspace={workspaces.selectedWorkspace}
        onSave={workspaces.updateSettings}
      />
      <RollbackDialog
        open={isRollbackDialogOpen}
        onOpenChange={setIsRollbackDialogOpen}
        workspaceId={workspaces.selectedWorkspace?.id ?? null}
        onRollback={handleRollbackConfirm}
      />
    </TooltipProvider>
  );
}

export default App;
