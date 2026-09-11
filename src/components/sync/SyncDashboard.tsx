import type { SyncState, StepStatus, SyncStep, HistoryRecord, GitState, GitBranchInfo, P4BehindInfo, WarningEntry, LastSyncResult } from "@/lib/types";
import type { GitProgressState } from "@/lib/gitProgress";
import { IdlePanel } from "./IdlePanel";
import { RunningPanel } from "./RunningPanel";
import { ErrorPanel } from "./ErrorPanel";
import { GitRunningPanel } from "./GitRunningPanel";
import { WorkspaceHealthPanel } from "./WorkspaceHealthPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HistoryTab } from "@/components/history/HistoryTab";
import type { WorkspaceConfig } from "@/lib/types";
import { Download, History, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n";

interface SyncDashboardProps {
  syncState: SyncState;
  stepStatuses: Record<SyncStep, StepStatus>;
  progress: { current: number; total: number; currentFile: string };
  logLines: string[];
  currentStep: SyncStep | null;
  errorInfo: { step: string; error: string } | null;
  lastSyncResult: LastSyncResult | null;
  selectedWorkspace: WorkspaceConfig | null;
  targetCl: string;
  onTargetClChange: (cl: string) => void;
  currentSubStep?: string | null;
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
  // Phase 15 (GPULL-24/25 frontend): git pull determinate progress bar state.
  // gitProgress carries the latest git `%` (or null on a no-% sub-step);
  // gitCurrentStep / gitCurrentSubStep are machine keys looked up at render.
  // Optional with null defaults so the existing test fixture (which omits
  // them) keeps type-checking — App.tsx threads both.
  gitProgress?: GitProgressState | null;
  gitCurrentStep?: string | null;
  gitCurrentSubStep?: string | null;
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
  // Phase 14 (SUMM-21..23): aggregated warnings from the most-recent
  // sync/force-sync/rollback. Optional with default `[]` so the existing
  // SyncDashboard test fixture keeps type-checking — App.tsx always threads
  // it at runtime.
  lastSyncWarnings?: WarningEntry[];
  // Phase 26 (26-01): live workspace CL for the idle P4 card footer.
  // Optional with a null default so the existing test fixture keeps
  // type-checking — App.tsx threads workspaces.currentCl at runtime.
  currentCl?: string | null;
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
  currentSubStep = null,
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
  gitProgress = null,
  gitCurrentStep = null,
  gitCurrentSubStep = null,
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
  lastSyncWarnings = [],
  currentCl = null,
}: SyncDashboardProps) {
  const { t } = useT();
  const isSyncRunning = syncState === "running";
  const isBusy = isSyncRunning || historyRollingBack || gitState === "running";

  return (
    <Tabs defaultValue="sync" className="flex min-h-0 flex-1 flex-col">
      <TabsList
        variant="line"
        className="h-10 shrink-0 w-full justify-start gap-6 border-b border-border px-4 pt-1 medium:px-6"
      >
        <TabsTrigger value="sync" className="px-2 text-sm font-normal">
          <Download className="h-4 w-4" />
          {t("sync.tab.sync")}
        </TabsTrigger>
        <TabsTrigger value="history" className="px-2 text-sm font-normal">
          <History className="h-4 w-4" />
          {t("sync.tab.history")}
        </TabsTrigger>
        <TabsTrigger value="health" className="px-2 text-sm font-normal">
          <ShieldCheck className="h-4 w-4" />
          {t("sync.tab.health")}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="sync" className="min-h-0 flex-1 overflow-hidden" tabIndex={-1}>
        {gitState !== "idle" ? (
          <GitRunningPanel
            gitState={gitState as "running" | "success" | "error"}
            logLines={gitLogLines}
            errorInfo={gitErrorInfo}
            onCancel={onStopGitPull}
            onBack={onDismissGitResult}
            gitProgress={gitProgress}
            gitCurrentStep={gitCurrentStep}
            gitCurrentSubStep={gitCurrentSubStep}
            gitBranchInfo={gitBranchInfo}
            gitBranchLoading={gitBranchLoading}
          />
        ) : syncState === "running" ? (
          <RunningPanel
            stepStatuses={stepStatuses}
            progress={progress}
            logLines={logLines}
            currentStep={currentStep}
            currentSubStep={currentSubStep}
            targetCl={targetCl}
            isCancelling={isCancelling}
            onCancel={onStopSync}
            stream={stream}
            p4Client={p4Client}
          />
        ) : syncState === "error" && errorInfo ? (
          <ErrorPanel
            step={errorInfo.step}
            error={errorInfo.error}
            retryKind={errorInfo.step === "networkCheck" ? "restart" : "retry"}
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
            lastSyncWarnings={lastSyncWarnings}
            currentCl={currentCl}
          />
        )}
      </TabsContent>

      <TabsContent value="history" className="min-h-0 flex-1 overflow-hidden" tabIndex={-1}>
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
      <TabsContent value="health" className="min-h-0 flex-1 overflow-hidden" tabIndex={-1}>
        <WorkspaceHealthPanel workspaceId={selectedWorkspace?.id ?? null} />
      </TabsContent>
    </Tabs>
  );
}
