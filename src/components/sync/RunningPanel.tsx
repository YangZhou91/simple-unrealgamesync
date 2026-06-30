import type { StepStatus, SyncStep } from "@/lib/types";
import { StepIndicator } from "./StepIndicator";
import { ProgressSection } from "./ProgressSection";
import { LogViewer } from "./LogViewer";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { info } from "@tauri-apps/plugin-log";
import { useEffect, useRef } from "react";

interface RunningPanelProps {
  stepStatuses: Record<SyncStep, StepStatus>;
  progress: { current: number; total: number; currentFile: string };
  logLines: string[];
  currentStep: SyncStep | null;
  stepDescriptions: Record<SyncStep, string | null>;
  isCancelling?: boolean;
  onCancel: () => void;
  // Optional with defaults (mirrors isCancelling) so existing test fixtures
  // keep type-checking — App.tsx always threads both via SyncDashboard.
  stream?: string | null;
  p4Client?: string | null;
}

export function RunningPanel({
  stepStatuses,
  progress,
  logLines,
  currentStep,
  stepDescriptions,
  isCancelling = false,
  onCancel,
  stream = null,
  p4Client = null,
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

  // Log ONLY on state TRANSITION (on→off / off→on) to avoid flooding the file
  // (p4SyncOverrun depends on progress.current/total which tick hundreds of
  // times per second during a big sync). One diagnostic line per flip.
  const prev = useRef<boolean | null>(null);
  useEffect(() => {
    const next = isIndeterminate;
    if (prev.current === null) {
      prev.current = next;
      return;
    }
    if (prev.current === next) return;
    const stepLabel = currentStep ?? "null";
    const currentLabel = `${progress.current}/${progress.total}`;
    if (next) {
      const reason =
        currentStep === "genProject"
          ? "genProject"
          : (currentStep as string) === "forceSync"
            ? "forceSync"
            : p4SyncOverrun
              ? "p4SyncOverrun"
              : "unknown";
      info(
        `[ui] Working ON reason=${reason} step=${stepLabel} current=${currentLabel}`,
      ).catch(() => {});
    } else {
      info(
        `[ui] Working OFF step=${stepLabel} current=${currentLabel}`,
      ).catch(() => {});
    }
    prev.current = next;
  }, [isIndeterminate, currentStep, progress.current, progress.total, p4SyncOverrun]);
  return (
    <div className="flex h-full flex-col">
      <div className="text-center space-y-0.5 pt-2">
        <p className="text-xs text-muted-foreground">
          Stream:{" "}
          <span className="font-mono">
            {stream ?? "classic client"}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Client: <span className="font-mono">{p4Client}</span>
        </p>
      </div>
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
