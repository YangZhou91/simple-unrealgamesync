import { AppLayout } from "@/components/layout/AppLayout";
import { Sidebar } from "@/components/layout/Sidebar";
import { SyncDashboard } from "@/components/sync/SyncDashboard";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { RollbackDialog } from "@/components/history/RollbackDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { useSync } from "@/hooks/useSync";
import { useGit } from "@/hooks/useGit";
import { useBehindCheck } from "@/hooks/useBehindCheck";
import { useHistory } from "@/hooks/useHistory";
import { useUpdater } from "@/hooks/useUpdater";
import { useState, useCallback, useEffect } from "react";
import * as commands from "@/lib/commands";
import type { GitBranchInfo } from "@/lib/types";

function App() {
  const workspaces = useWorkspaces();
  const refreshCurrentCl = workspaces.refreshCurrentCl;

  const onRollbackComplete = useCallback(
    (cl: string | null) => {
      refreshCurrentCl(cl);
    },
    [refreshCurrentCl],
  );
  const history = useHistory(workspaces.selectedWorkspace?.id ?? null, onRollbackComplete);

  // Single sync hook that refreshes history on completion
  const onSyncComplete = useCallback(
    (cl: string | null) => {
      refreshCurrentCl(cl);
      history.loadHistory();
    },
    [refreshCurrentCl, history.loadHistory],
  );
  const sync = useSync(onSyncComplete);
  const git = useGit();
  const behind = useBehindCheck();
  const updater = useUpdater();
  const isSyncRunning = sync.syncState === "running";
  const isOperationRunning =
    isSyncRunning || history.isRollingBack || git.gitState === "running";
  const [gitBranchInfo, setGitBranchInfo] = useState<GitBranchInfo | null>(null);
  const [gitBranchLoading, setGitBranchLoading] = useState(false);
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
      history.startRollback(targetCl);
      setIsRollbackDialogOpen(false);
    }
  };

  const handleGitPull = useCallback(async () => {
    if (isOperationRunning) {
      return;
    }
    if (workspaces.selectedWorkspace) {
      try {
        await git.startGitPull(workspaces.selectedWorkspace.id);
        fetchGitStatus();
      } catch {
        // Error handling is done in useGit hook
      }
    }
  }, [workspaces.selectedWorkspace, git.startGitPull, fetchGitStatus, isOperationRunning]);

  return (
    <TooltipProvider>
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
          />
        }
      >
        {workspaces.workspaces.length === 0 && !workspaces.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center space-y-3">
              <h2 className="text-xl font-semibold text-foreground">
                No Workspaces Yet
              </h2>
              <p className="text-sm text-muted max-w-xs">
                Add a P4 workspace to get started. Click the + button in the
                sidebar.
              </p>
            </div>
          </div>
        ) : (
          <SyncDashboard
            syncState={sync.syncState}
            stepStatuses={sync.stepStatuses}
            progress={sync.progress}
            logLines={sync.logLines}
            currentStep={sync.currentStep}
            errorInfo={sync.errorInfo}
            lastSyncResult={sync.lastSyncResult}
            selectedWorkspace={workspaces.selectedWorkspace}
            targetCl={sync.targetCl}
            onTargetClChange={sync.setTargetCl}
            syncEngine={sync.syncEngine}
            onSyncEngineChange={sync.setSyncEngine}
            stepDescriptions={sync.stepDescriptions}
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
            onGitPull={handleGitPull}
            onStopGitPull={git.stopGitPull}
            onDismissGitResult={git.dismissGitResult}
            gitBranchInfo={gitBranchInfo}
            gitBranchLoading={gitBranchLoading}
            behindInfo={behind.behindInfo}
            behindLoading={behind.behindLoading}
            stream={streamInfo}
            p4Client={workspaces.selectedWorkspace?.p4Client ?? null}
          />
        )}
      </AppLayout>
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
