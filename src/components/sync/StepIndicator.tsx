import { STEP_ORDER } from "@/lib/types";
import type { StepStatus, SyncStep } from "@/lib/types";
import { useStepLabels, resolveSubStep } from "@/lib/i18n";
import { Check, Minus } from "lucide-react";

interface StepIndicatorProps {
  stepStatuses: Record<SyncStep, StepStatus>;
  targetCl?: string;
  currentStep?: string | null;
  currentSubStep?: string | null;
}

// Phase 26 (26-02 Task 2): the canonical numbered/checked five-step rail.
// Desktop (>850px) is the vertical rail beside the run-progress card; through
// the medium variant the SAME five item instances reflow to a wrapping
// horizontal sequence above the card — CSS only, no JavaScript width
// branching (UI-SPEC §7/§12). The old fixed-width connectors, nowrap labels,
// and flex-column dot clusters were the 392/352 geometry offenders.
export function StepIndicator({
  stepStatuses,
  targetCl = "",
  currentStep = null,
  currentSubStep = null,
}: StepIndicatorProps) {
  const label = useStepLabels();
  return (
    <ol className="flex list-none flex-col gap-4 pt-1 medium:flex-row medium:flex-wrap medium:gap-2">
      {STEP_ORDER.map((step, i) => {
        const status = stepStatuses[step];
        const isActive = status === "active";
        // 26-01 single-occurrence rule: the LIVE toCl composition belongs
        // solely to the running header, so non-active steps carry their
        // static canonical label (p4Sync -> `all`). Only the ACTIVE step
        // resolves its real machine sub-step at render time.
        const sub =
          isActive && step === currentStep
            ? resolveSubStep(step, currentSubStep, targetCl)
            : resolveSubStep(step, undefined, "");
        return (
          <li key={step} className="flex min-w-0 items-center gap-2">
            <span
              className={`flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border text-caption tabular-nums ${
                status === "pending"
                  ? "border-border text-muted"
                  : isActive
                    ? "border-transparent bg-primary font-medium text-primary-foreground"
                    : status === "completed"
                      ? "border-transparent bg-accent text-success"
                      : status === "failed"
                        ? "border-destructive text-destructive"
                        : "border-border text-muted"
              }`}
            >
              {status === "completed" ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : status === "skipped" ? (
                <Minus className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                i + 1
              )}
            </span>
            <span
              className={`min-w-0 break-words text-note ${
                isActive
                  ? "font-medium text-foreground"
                  : status === "failed"
                    ? "text-destructive"
                    : "text-muted"
              }`}
            >
              {label(step, sub, { cl: targetCl })}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
