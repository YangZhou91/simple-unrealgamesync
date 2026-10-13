import { LogViewer } from "./LogViewer";
import { ProgressSection } from "./ProgressSection";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle, Terminal, XCircle } from "lucide-react";
import { useStepLabels, useT } from "@/lib/i18n";
import type { EngineUpdateState } from "@/lib/types";

interface EngineRunningPanelProps {
  /** The state discriminant — each state's role derives SOLELY from this
   *  (T-30-13: a raw payload never restyles the chrome). */
  engineState: EngineUpdateState;
  logLines?: string[];
  errorInfo?: { error: string } | null;
  onCancel?: () => void;
  onBack?: () => void;
  onRetry?: () => void;
  // D-07 count-driven progress. Optional with a zero default (the repo's
  // convention at GitRunningPanel.tsx:10-29) so fixtures keep type-checking.
  progress?: { current: number; total: number; currentFile: string };
  // WIRE-01: machine keys; looked up at render via useStepLabels.
  currentStep?: string | null;
  currentSubStep?: string | null;
  // The engine's real CL carried by SyncCompleted (the partial success region
  // and the full-success line both read it).
  resultCl?: string | null;
}

/**
 * Clamp the count-driven pair so the rendered percentage stays inside [0,100].
 * The `-n` denominator is taken before the transfer starts, so the real sync
 * can outrun it (D-07); with `current` clamped to `total`, the ProgressSection
 * overrun branch renders the honest `{total}+ files…` presentation instead of
 * a number above 100. `total === 0` passes through untouched (indeterminate).
 */
function clampProgress(p: { current: number; total: number; currentFile: string }) {
  return {
    current: p.total > 0 ? Math.min(p.current, p.total) : p.current,
    total: p.total,
    currentFile: p.currentFile,
  };
}

/**
 * Phase 30 (D-11): the four-state engine running/terminal surface. A parallel
 * component (UI-SPEC §14) with its own `EngineUpdateState`, so the git
 * component's three-state union and its goldens stay byte-immutable. Renders
 * from hook state only — it calls no command and owns no timer.
 */
export function EngineRunningPanel({
  engineState,
  logLines = [],
  errorInfo = null,
  onCancel = () => {},
  onBack = () => {},
  onRetry = () => {},
  progress = { current: 0, total: 0, currentFile: "" },
  currentStep = null,
  currentSubStep = null,
  resultCl = null,
}: EngineRunningPanelProps) {
  const stepLabel = useStepLabels();
  const { t } = useT();
  const label = stepLabel(currentStep ?? "", currentSubStep);
  const lastLog = logLines.length > 0 ? logLines[logLines.length - 1] : undefined;
  const clamped = clampProgress(progress);

  // The engine's success region — shared by the full-success terminal and the
  // partial card's region A (the engine's real success stays visible next to
  // the genProject failure; never collapse the pair into a plain error card).
  const successRegion = (
    <>
      <div className="flex items-center gap-2 text-success">
        <CheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <h2 className="text-section">{t("sync.engineP4.success")}</h2>
      </div>
      <p className="mt-2 text-note text-muted-foreground">
        {t("sync.engineP4.successLine", { cl: resultCl ?? "?" })}
      </p>
    </>
  );

  // The raw backend payload as a SIBLING mono node — never interpolated into a
  // translated sentence (T-30-12). Falls back to the typed unknown-error key.
  const rawError = (
    <p className="mt-2 min-w-0 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
      {errorInfo?.error ?? t("sync.engineP4.unknownError")}
    </p>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Running header — typed running title + the MUTED P4 chip (info stays
          reserved for Git identity, §6) + exactly one outline Cancel. No
          synthetic context line: the live context is the progress card's
          current-file line. */}
      {engineState === "running" && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-section">{t("sync.engineP4.runningTitle")}</h2>
              <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-caption leading-tight text-muted-foreground">
                {t("sync.badge.p4")}
              </span>
            </div>
          </div>
          <Button variant="outline" onClick={onCancel} className="h-9 shrink-0 px-6">
            {t("sync.engineP4.cancel")}
          </Button>
        </div>
      )}

      {/* Run-progress card — count-driven determinate (D-07). The byte fields
          and rawPercent stay null so ProgressSection's byte branch never lights
          up and the deferred FORC-27/28/29 byte bar is not revived. */}
      {engineState === "running" && (
        <section className="min-w-0 rounded-lg border border-border bg-card p-4">
          <ProgressSection
            current={clamped.current}
            total={clamped.total}
            currentFile={clamped.currentFile}
            indeterminate={progress.total === 0}
            indeterminateLabel={label}
            indeterminateDetail={lastLog}
            bytesDone={null}
            bytesTotal={null}
            bytesRate={null}
            rawPercent={null}
          />
        </section>
      )}

      {/* Full success terminal. */}
      {engineState === "success" && (
        <section className="min-w-0 rounded-lg border border-border bg-card">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4">
            <div className="min-w-0">{successRegion}</div>
            <Button variant="ghost" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t("sync.engineP4.back")}
            </Button>
          </div>
        </section>
      )}

      {/* Full-error terminal — destructive-role card; Back to Idle only (Retry
          is partial-only, D-11). */}
      {engineState === "error" && (
        <section className="min-w-0 rounded-lg border border-border border-t-4 border-t-destructive bg-card">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <h2 className="text-section">{t("sync.engineP4.failed")}</h2>
              </div>
              {rawError}
            </div>
            <Button variant="ghost" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t("sync.engineP4.back")}
            </Button>
          </div>
        </section>
      )}

      {/* D-11 partial terminal — region A (engine success) above a full-bleed
          1px divider, then region B (genProject failure) and the Retry/Back
          action row. The 4px top edge is destructive: the operation is not a
          clean success and the user must act. */}
      {engineState === "partial" && (
        <section className="min-w-0 rounded-lg border border-border border-t-4 border-t-destructive bg-card">
          <div className="min-w-0 p-4">{successRegion}</div>
          <div className="border-t border-border" />
          <div className="min-w-0 p-4">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <h2 className="text-section">{t("sync.engineP4.partial")}</h2>
            </div>
            {rawError}
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={onRetry}
                className="border-destructive text-destructive hover:bg-destructive/10"
              >
                {t("sync.engineP4.retry")}
              </Button>
              <Button variant="ghost" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t("sync.engineP4.back")}
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Canonical raw-output log card — preserved in EVERY state (running +
          all three terminals). The bounded min-h-0 flex-1 ancestor chain keeps
          the virtualizer from growing the document root (T-26-06). */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-well">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2 font-mono text-caption text-muted-foreground">
          <Terminal className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("sync.engineP4.logTitle")}
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <LogViewer lines={logLines} />
        </div>
      </div>
    </div>
  );
}
