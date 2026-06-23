import { STEP_ORDER, STEP_LABELS } from "@/lib/types";
import type { StepStatus, SyncStep } from "@/lib/types";

interface StepIndicatorProps {
  stepStatuses: Record<SyncStep, StepStatus>;
  stepDescriptions?: Record<SyncStep, string | null>;
}

export function StepIndicator({
  stepStatuses,
  stepDescriptions,
}: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-2 py-4">
      {STEP_ORDER.map((step, i) => {
        const status = stepStatuses[step];
        return (
          <div key={step} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`h-3 w-3 rounded-full transition-colors ${
                  status === "pending"
                    ? "bg-muted"
                    : status === "active"
                      ? "bg-accent animate-pulse"
                      : status === "completed"
                        ? "bg-accent"
                        : "bg-destructive"
                }`}
              />
              <span
                className={`text-xs whitespace-nowrap ${
                  status === "active"
                    ? "text-foreground font-medium"
                    : "text-muted"
                }`}
              >
                {STEP_LABELS[step]}
              </span>
              {status === "active" && stepDescriptions?.[step] && (
                <span className="text-[10px] text-muted-foreground truncate max-w-20">
                  {stepDescriptions[step]}
                </span>
              )}
            </div>
            {i < STEP_ORDER.length - 1 && (
              <div
                className={`h-px w-8 mx-1 mt-[-12px] ${
                  status === "completed" ? "bg-accent" : "bg-border"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
