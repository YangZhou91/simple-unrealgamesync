import type { SyncState, StepStatus, SyncStep, HistoryRecord, GitState, GitBranchInfo, P4BehindInfo } from "@/lib/types";
import { IdlePanel } from "./IdlePanel";
import { RunningPanel } from "./RunningPanel";
import { ErrorPanel } from "./ErrorPanel";
import { GitRunningPanel } from "./GitRunningPanel";
import { WorkspaceHealthPanel } from "./WorkspaceHealthPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HistoryTab } from "@/components/history/HistoryTab";
import type { WorkspaceConfig } from "@/lib/types";

interface SyncDashboardProps {
  syncState: SyncState;
  stepStatuses: Record<SyncStep, StepStatus>;
  progress: { current: number; total: number; currentFile: string };
  logLines: string[];
  currentStep: SyncStep | null;
  errorInfo: { step: string; error: string } | null;
  lastSyncResult: {
    cl: string | null;
    fileCount: number;
    time: string;
  } | null;
  selectedWorkspace: WorkspaceConfig | null;
  targetCl: string;
  onTargetClChange: (cl: string) => void;
  stepDescriptions: Record<SyncStep, string | null>;
  onStartSync: () => void;
  onStopSync: () => void;
  onRetryStep: (step: string) => void;
  onDismissError: () => void;
  onRollback: () => void;
  isCancelling?: boolean;
  historyRecords: HistoryRecord[];
  historyLoading: boolean;
  historyRollingBack: boolean;
  gitState: GitState;
  gitLogLines: string[];
  gitErrorInfo: { error: string } | null;
  onGitPull: () => void;
  onStopGitPull: () => void;
  onDismissGitResult: () => void;
  gitBranchInfo: GitBranchInfo | null;
  gitBranchLoading: boolean;
  behindInfo: P4BehindInfo | null;
  behindLoading: boolean;
  // Optional with defaults so the existing SyncDashboard test fixture keeps
  // type-checking — App.tsx always threads both at runtime.
  stream?: string | null;
  p4Client?: string | null;
  // quick-260713-kx6: opt-out of syncing UnrealEngine engine source during a
  // Target CL sync. Defaults OFF (syncEngine=false) and onSyncEngineChange is a
  // no-op so the existing test fixture keeps type-checking. App.tsx always
  // threads both at runtime.
  syncEngine?: boolean;
  onSyncEngineChange?: (v: boolean) => void;
}

export function SyncDashboard({
  syncState,
  stepStatuses,
  progress,
  logLines,
  currentStep,
  errorInfo,
  lastSyncResult,
  selectedWorkspace,
  targetCl,
  onTargetClChange,
  stepDescriptions,
  onStartSync,
  onStopSync,
  onRetryStep,
  onDismissError,
  onRollback,
  isCancelling = false,
  historyRecords,
  historyLoading,
  historyRollingBack,
  gitState,
  gitLogLines,
  gitErrorInfo,
  onGitPull,
  onStopGitPull,
  onDismissGitResult,
  gitBranchInfo,
  gitBranchLoading,
  behindInfo,
  behindLoading,
  stream = null,
  p4Client = null,
  syncEngine = false,
  onSyncEngineChange = () => {},
}: SyncDashboardProps) {
  const isSyncRunning = syncState === "running";
  const isBusy = isSyncRunning || historyRollingBack || gitState === "running";

  return (
    <Tabs defaultValue="sync" className="flex h-full flex-col">
      <TabsList
        variant="line"
        className="h-10 w-full justify-start border-b border-border px-4 pt-2"
      >
        <TabsTrigger value="sync" className="px-4">
          Sync
        </TabsTrigger>
        <TabsTrigger value="history" className="px-4">
          History
        </TabsTrigger>
        <TabsTrigger value="health" className="px-4">
          健康 / Health
        </TabsTrigger>
      </TabsList>

      <TabsContent value="sync" className="flex-1 overflow-hidden" tabIndex={-1}>
        {gitState !== "idle" ? (
          <GitRunningPanel
            gitState={gitState as "running" | "success" | "error"}
            logLines={gitLogLines}
            errorInfo={gitErrorInfo}
            onCancel={onStopGitPull}
            onBack={onDismissGitResult}
          />
        ) : syncState === "running" ? (
          <RunningPanel
            stepStatuses={stepStatuses}
            progress={progress}
            logLines={logLines}
            currentStep={currentStep}
            stepDescriptions={stepDescriptions}
            isCancelling={isCancelling}
            onCancel={onStopSync}
            stream={stream}
            p4Client={p4Client}
          />
        ) : syncState === "error" && errorInfo ? (
          <ErrorPanel
            step={errorInfo.step}
            error={errorInfo.error}
            retryLabel={errorInfo.step === "networkCheck" ? "Restart Sync" : undefined}
            onRetry={() => {
              if (selectedWorkspace) {
                if (errorInfo.step === "networkCheck") {
                  onStartSync();
                } else {
                  onRetryStep(errorInfo.step);
                }
              }
            }}
            onDismiss={onDismissError}
          />
        ) : (
          <IdlePanel
            lastSyncResult={lastSyncResult}
            hasWorkspace={selectedWorkspace !== null}
            targetCl={targetCl}
            onTargetClChange={onTargetClChange}
            onStartSync={onStartSync}
            onGitPull={onGitPull}
            isBusy={isBusy}
            gitBranchInfo={gitBranchInfo}
            gitBranchLoading={gitBranchLoading}
            behindInfo={behindInfo}
            behindLoading={behindLoading}
            stream={stream}
            p4Client={p4Client}
            syncEngine={syncEngine}
            onSyncEngineChange={onSyncEngineChange}
          />
        )}
      </TabsContent>

      <TabsContent value="history" className="flex-1 overflow-hidden" tabIndex={-1}>
        <HistoryTab
          workspaceId={selectedWorkspace?.id ?? null}
          isSyncRunning={isBusy}
          onRollback={onRollback}
          records={historyRecords}
          isLoading={historyLoading}
        />
      </TabsContent>

      {/* quick-260713-s44: read-only workspace-health audit tab. The panel owns
          its own state via useWorkspaceHealth (on-demand, decoupled from sync). */}
      <TabsContent value="health" className="flex-1 overflow-hidden" tabIndex={-1}>
        <WorkspaceHealthPanel workspaceId={selectedWorkspace?.id ?? null} />
      </TabsContent>
    </Tabs>
  );
}
