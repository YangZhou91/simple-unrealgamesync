import type { StepStatus, SyncStep } from "@/lib/types";
import { StepIndicator } from "./StepIndicator";
import { ProgressSection } from "./ProgressSection";
import { LogViewer } from "./LogViewer";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface RunningPanelProps {
  stepStatuses: Record<SyncStep, StepStatus>;
  progress: { current: number; total: number; currentFile: string };
  logLines: string[];
  currentStep: SyncStep | null;
  stepDescriptions: Record<SyncStep, string | null>;
  isCancelling?: boolean;
  onCancel: () => void;
}

export function RunningPanel({
  stepStatuses,
  progress,
  logLines,
  currentStep,
  stepDescriptions,
  isCancelling = false,
  onCancel,
}: RunningPanelProps) {
  // Switch to indeterminate animation when:
  //   - Running genProject / forceSync (no file progress for these steps)
  //   - p4Sync has consumed all files the dry-run estimated but is still going
  //     (dry-run can undercount when new CLs land between preview and actual sync)
  const p4SyncOverrun =
    currentStep === "p4Sync" &&
    progress.total > 0 &&
    progress.current >= progress.total;
  const isIndeterminate =
    currentStep === "genProject" ||
    (currentStep as string) === "forceSync" ||
    p4SyncOverrun;
  return (
    <div className="flex h-full flex-col">
      <StepIndicator
        stepStatuses={stepStatuses}
        stepDescriptions={stepDescriptions}
      />
      <ProgressSection
        current={progress.current}
        total={progress.total}
        currentFile={progress.currentFile}
        indeterminate={isIndeterminate}
      />
      <div className="flex-1 overflow-hidden border-t border-border mt-2">
        <LogViewer lines={logLines} />
      </div>
      <div className="flex justify-center py-3 border-t border-border">
        {isCancelling ? (
          <Button variant="outline" disabled className="h-9 px-6 opacity-70">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Cancelling...
          </Button>
        ) : (
          <Button variant="outline" onClick={onCancel} className="h-9 px-6">
            Cancel Sync
          </Button>
        )}
      </div>
    </div>
  );
}
