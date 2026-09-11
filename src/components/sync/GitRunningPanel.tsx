import { LogViewer } from "./LogViewer";
import { ProgressSection } from "./ProgressSection";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle, Loader2, Terminal, XCircle } from "lucide-react";
import { decideGitBarMode } from "@/lib/gitProgress";
import type { GitProgressState } from "@/lib/gitProgress";
import { useStepLabels, useT } from "@/lib/i18n";
import type { GitBranchInfo } from "@/lib/types";

interface GitRunningPanelProps {
  gitState: "running" | "success" | "error";
  logLines: string[];
  errorInfo: { error: string } | null;
  onCancel: () => void;
  onBack: () => void;
  // Phase 15 (GPULL-24/25 frontend): git pull determinate progress bar state.
  // Threaded from useGit via SyncDashboard. The running-state branch renders
  // a ProgressSection driven by these. Optional with null defaults so the
  // existing call site / fixtures keep type-checking.
  gitProgress?: GitProgressState | null;
  // WIRE-01: machine keys; lookup at render via useStepLabels. Missing pair → steps.unknown.
  gitCurrentStep?: string | null;
  gitCurrentSubStep?: string | null;
  // Phase 26 (26-03, UI-SPEC §9): live Git repository context threaded from
  // SyncDashboard (which already holds both from App). Optional with null /
  // false defaults so existing fixtures keep type-checking — no App change.
  gitBranchInfo?: GitBranchInfo | null;
  gitBranchLoading?: boolean;
}

// Phase 15 (D-01 / WR-01 fix): map a git phase string to the display label
// prefix. The backend (Plan 02) now carries the canonical phase label on the
// wire (e.g. "Receiving objects" / "Compressing objects" / "Resolving deltas"),
// so the common path passes it straight through. The prefix-based fallbacks
// stay as a defensive default if the backend ever sends a short/abbreviated
// form, and "Receiving objects" remains the last-resort default when phase is
// null/empty/unrecognized (e.g. p4Sync Progress events, which send phase: null).
function labelForPhase(phase: string | null | undefined): string {
  if (!phase) return "Receiving objects";
  const p = phase.toLowerCase();
  if (p.startsWith("compress")) return "Compressing objects";
  if (p.startsWith("resolv")) return "Resolving deltas";
  if (p.startsWith("receiv")) return "Receiving objects";
  // Backend already sends the full canonical label — pass it through verbatim
  // so any future phase string surfaces correctly rather than collapsing to
  // the Receiving default.
  return phase;
}

export function GitRunningPanel({
  gitState,
  logLines,
  errorInfo,
  onCancel,
  onBack,
  gitProgress = null,
  gitCurrentStep = null,
  gitCurrentSubStep = null,
  gitBranchInfo = null,
  gitBranchLoading = false,
}: GitRunningPanelProps) {
  const stepLabel = useStepLabels();
  const { t } = useT();
  const label = stepLabel(gitCurrentStep ?? "", gitCurrentSubStep);

  // Live raw Git context line (UI-SPEC §9): typed checking chrome while the
  // metadata loads, raw branch/remote/short-hash when available, typed
  // unavailable chrome otherwise. Never fabricated, never translated.
  const gitContext = gitBranchLoading ? (
    <span className="inline-flex items-center gap-2 font-mono text-caption text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {t("sync.git.checking")}
    </span>
  ) : gitBranchInfo?.branch ? (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-caption text-muted-foreground">
      <span className="min-w-0 break-all text-foreground/85">
        {gitBranchInfo.is_detached
          ? t("sync.git.detachedParen")
          : gitBranchInfo.branch}
      </span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 break-all">{gitBranchInfo.remote || "—"}</span>
      {gitBranchInfo.short_hash && (
        <>
          <span aria-hidden="true">·</span>
          <span>{gitBranchInfo.short_hash}</span>
        </>
      )}
    </span>
  ) : (
    <span className="font-mono text-caption text-muted-foreground">
      {t("sync.git.empty")}
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Canonical running header (UI-SPEC §9): typed running title + Git
          chip + live raw context on the left, the ONE semantic Cancel Pull
          opposite — wrap-capable at narrow widths, never hidden. */}
      {gitState === "running" && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-section">{t("sync.git.runningTitle")}</h2>
              <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-caption leading-tight text-info">
                {t("sync.badge.git")}
              </span>
            </div>
            <div className="mt-1">{gitContext}</div>
          </div>
          <Button variant="outline" onClick={onCancel} className="h-9 shrink-0 px-6">
            {t("sync.git.cancel")}
          </Button>
        </div>
      )}

      {/* Run-progress card — the same contained ProgressSection contract as
          P4 (26-02): determinate when the live percent is non-null with the
          raw phase label composition (labelForPhase passthrough preserved
          verbatim), otherwise indeterminate with the render-time machine-key
          label and the latest raw log line as detail. */}
      {gitState === "running" && (() => {
        const mode = decideGitBarMode(gitProgress, gitCurrentSubStep ?? null);
        const lastLog = logLines.length > 0 ? logLines[logLines.length - 1] : undefined;
        const isDeterminate = mode === "determinate" && gitProgress != null && gitProgress.percent != null;
        return (
          <section className="min-w-0 rounded-lg border border-border bg-card p-4">
            <ProgressSection
              current={0}
              total={0}
              currentFile=""
              indeterminate={!isDeterminate}
              indeterminateLabel={label}
              indeterminateDetail={!isDeterminate ? lastLog : undefined}
              rawPercent={isDeterminate && gitProgress ? gitProgress.percent : null}
              rawPercentLabel={
                isDeterminate && gitProgress && gitProgress.percent != null
                  ? `${labelForPhase(gitProgress.phase)} ${gitProgress.percent}%`
                  : undefined
              }
            />
          </section>
        );
      })()}

      {/* Terminal header card — success (UI-SPEC §9): success-role treatment
          with the existing typed chrome and exactly one semantic Back-to-Idle
          action; onBack exclusively drives the existing dismiss path. */}
      {gitState === "success" && (
        <section className="min-w-0 rounded-lg border border-border bg-card">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4">
            <div className="flex min-w-0 items-center gap-2 text-success">
              <CheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <h2 className="text-section">{t("sync.git.success")}</h2>
            </div>
            <Button variant="ghost" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t("sync.git.back")}
            </Button>
          </div>
        </section>
      )}

      {/* Terminal header card — error (UI-SPEC §9): destructive-role card.
          The raw payload (or the typed unknown-error key when null) is a
          SIBLING mono block in a wrap-anywhere node — never interpolated into
          the translated chrome (T-26-09/T-26-11: the role derives solely from
          gitState; the payload never restyles as success chrome). Exactly one
          semantic Back-to-Idle action. */}
      {gitState === "error" && (
        <section className="min-w-0 rounded-lg border border-border border-t-4 border-t-destructive bg-card">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <h2 className="text-section">{t("sync.git.failed")}</h2>
              </div>
              <p className="mt-2 min-w-0 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {errorInfo?.error ?? t("sync.git.unknownError")}
              </p>
            </div>
            <Button variant="ghost" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t("sync.git.back")}
            </Button>
          </div>
        </section>
      )}

      {/* Canonical raw-output log card (26-02 pattern): well surface, 1px
          border, 6px radius, Terminal-icon header with the typed Git output
          title, and the bounded virtualized body rendering raw git lines.
          Output is preserved in EVERY state (running + both terminals). The
          bounded min-h-0 flex-1 ancestor chain keeps the virtualizer from
          growing the document root (T-26-06). */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-well">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2 font-mono text-caption text-muted-foreground">
          <Terminal className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("sync.git.logTitle")}
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <LogViewer lines={logLines} />
        </div>
      </div>
    </div>
  );
}
