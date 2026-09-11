import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { useT, useStepLabels, resolveSubStep } from "@/lib/i18n";

interface ErrorPanelProps {
  step: string;
  error: string;
  // SWEEP-01: kind, not a translated string — the child owns the label keys.
  // "restart" is the networkCheck case (retrying the step is meaningless; the
  // whole pipeline restarts). Default "retry" keeps call sites terse.
  retryKind?: "retry" | "restart";
  onRetry: () => void;
  onDismiss: () => void;
}

// Phase 26 (26-03 Task 1, UI-SPEC §8): the canonical inline error card —
// an inline card at the top of the Sync tab's scroll area (not a centered
// hero, not a toast). The card root carries role=alert for the failure
// announcement and never steals focus on mount; the standard visible focus
// treatment stays available on every control.
export function ErrorPanel({
  step,
  error,
  retryKind = "retry",
  onRetry,
  onDismiss,
}: ErrorPanelProps) {
  const { t } = useT();
  const stepLabel = useStepLabels();
  // Pitfall 4: networkCheck is a real Rust step token but is NOT in
  // KNOWN_SUB_STEPS — useStepLabels would collapse it to steps.unknown
  // ("Working…"). It gets its own dedicated key instead.
  const label =
    step === "networkCheck"
      ? t("sync.error.networkCheck")
      : stepLabel(step, resolveSubStep(step, undefined, ""));
  return (
    <div className="h-full min-w-0 overflow-y-auto px-4 py-4 medium:px-6">
      {/* 4px destructive top edge, 1px semantic border on the remaining
          sides, 8px radius, 24px interior padding (UI-SPEC §3). */}
      <section
        role="alert"
        className="min-w-0 rounded-lg border border-border border-t-4 border-t-destructive bg-card p-6"
      >
        <div className="flex items-center gap-2">
          <AlertCircle
            className="h-4 w-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <h2 className="text-section text-foreground">{t("sync.error.title")}</h2>
        </div>
        {/* Typed failed-at sentence — the TRANSLATED step label rides the
            interpolation, never a raw machine token. */}
        <p className="mt-2 text-note text-muted-foreground">
          {t("sync.error.failedAt", { step: label })}
        </p>
        {/* Pitfall 10 / T-26-09: the raw AppError Display is a SIBLING node
            in its own mono well — well surface, 16px padding, 4px radius,
            12px mono text that wraps anywhere — never a token interpolated
            inside the translated sentence and never markup. */}
        <div className="mt-4 min-w-0 rounded bg-well p-4">
          <p className="min-w-0 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {error}
          </p>
        </div>
        {/* Wrap-capable recovery row — the primary recovery action (per
            retryKind) first, then the ghost dismiss. Both stay labelled and
            keyboard reachable when they wrap at 352px (UI-SPEC §8/§12). */}
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            onClick={onRetry}
          >
            {t(retryKind === "restart" ? "sync.error.restart" : "sync.error.retry")}
          </Button>
          <Button variant="ghost" onClick={onDismiss}>
            {t("sync.error.dismiss")}
          </Button>
        </div>
      </section>
    </div>
  );
}
