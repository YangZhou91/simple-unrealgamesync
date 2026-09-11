import type { StepStatus, SyncStep } from "@/lib/types";
import { StepIndicator } from "./StepIndicator";
import { ProgressSection } from "./ProgressSection";
import { LogViewer } from "./LogViewer";
import { Button } from "@/components/ui/button";
import { Loader2, Terminal } from "lucide-react";
import { info } from "@tauri-apps/plugin-log";
import { useEffect, useRef, useState } from "react";
import { useStepLabels, useT } from "@/lib/i18n";

// quick-260707-kdf: How long p4Sync may run with no byte signal before we fall
// back to the (front-loaded, inaccurate) count bar. Beats an infinite
// indeterminate spin if DiskUsageSampler is broken on this machine. Tunable —
// raise if the sampler's first heartbeat is consistently slow.
const P4SYNC_PREP_TIMEOUT_MS = 20_000;

interface RunningPanelProps {
  stepStatuses: Record<SyncStep, StepStatus>;
  progress: {
    current: number;
    total: number;
    currentFile: string;
    // quick-260701-ep7: optional byte-level signal threaded from useSync →
    // ProgressSection. null when the heartbeat is not emitting bytes.
    bytesDone?: number | null;
    bytesTotal?: number | null;
    bytesRate?: number | null;
  };
  logLines: string[];
  currentStep: SyncStep | null;
  isCancelling?: boolean;
  onCancel: () => void;
  // Optional with defaults (mirrors isCancelling) so existing test fixtures
  // keep type-checking — App.tsx always threads both via SyncDashboard.
  stream?: string | null;
  p4Client?: string | null;
  targetCl?: string;
  currentSubStep?: string | null;
}

export function RunningPanel({
  stepStatuses,
  progress,
  logLines,
  currentStep,
  isCancelling = false,
  onCancel,
  stream = null,
  p4Client = null,
  targetCl = "",
  currentSubStep = null,
}: RunningPanelProps) {
  const stepLabel = useStepLabels();
  const { t } = useT();
  // Switch to indeterminate animation when:
  //   - Running genProject / forceSync (no file progress for these steps)
  //   - p4Sync has consumed all files the dry-run estimated but is still going
  //     (dry-run can undercount when new CLs land between preview and actual sync)
  // quick-260707-t93: when a byte signal is live, the overrun must NOT
  // flip indeterminate — it would hide the byte bar (ProgressSection render
  // priority is indeterminate > showByteBar). Fall back to the "{total}+
  // files…" indeterminate only when the sampler hasn't produced a byte
  // sample yet (sampler broken / first sample pending).
  const hasByteSignal = (progress.bytesDone ?? 0) > 0;
  const p4SyncOverrun =
    currentStep === "p4Sync" &&
    progress.total > 0 &&
    progress.current >= progress.total;
  const isIndeterminate =
    currentStep === "genProject" ||
    (currentStep as string) === "forceSync" ||
    (p4SyncOverrun && !hasByteSignal);

  // Derive the indeterminate "what step" label. forceSync is NOT a member of the
  // SyncStep union (detected via `(currentStep as string) === "forceSync"`).
  // Always pass a dictionary string for genProject/forceSync/overrun so
  // ProgressSection's omitted-prop path stays empty (Pitfall 3).
  const indeterminateLabel = isIndeterminate
    ? currentStep === "genProject"
      ? stepLabel("genProject", "gen")
      : (currentStep as string) === "forceSync"
        ? stepLabel("forceSync", "force")
        : p4SyncOverrun
          ? t("sync.files.overrun", { n: progress.total })
          : undefined
    : undefined;

  // Live liveness line = latest log line. Consumed ONLY in JSX (pure render-time),
  // so a new log line triggers a normal re-render but does NOT enter the diagnostic
  // effect below (its deps are unchanged). O(1)-ish; no memoization needed.
  const lastLog = logLines.length > 0 ? logLines[logLines.length - 1] : undefined;

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

  // quick-260707-kdf: prep state — between "p4Sync started" and "first byte
  // sample", the count bar races to ~100% (p4 front-loads all `- updating`
  // lines in ~13s). Show an indeterminate bar + dictionary prep label
  // (t("sync.prep", { n })) until either the byte signal arrives (byte bar
  // takes over) or 20s elapses (fall back to the count bar — it moves, beats
  // an infinite spin).
  const p4SyncEnteredAt = useRef<number | null>(null);
  // Dummy state used ONLY to schedule a re-render at the 20s boundary so the
  // fallback flips on time (React does not re-render on ref mutation). The
  // heartbeat also re-renders every ~2s via progress updates, so the timer is
  // a backstop for the edge case where the heartbeat stalls.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (currentStep === "p4Sync") {
      if (p4SyncEnteredAt.current === null) {
        p4SyncEnteredAt.current = Date.now();
        const id = setTimeout(() => forceTick((n) => n + 1), P4SYNC_PREP_TIMEOUT_MS);
        return () => clearTimeout(id);
      }
      return;
    }
    p4SyncEnteredAt.current = null;
  }, [currentStep]);

  const inP4Sync = currentStep === "p4Sync";
  const byteSignal = (progress.bytesDone ?? 0) > 0;
  const prepElapsed = p4SyncEnteredAt.current != null
    ? Date.now() - p4SyncEnteredAt.current
    : 0;
  const prep = inP4Sync && !p4SyncOverrun && !byteSignal && prepElapsed < P4SYNC_PREP_TIMEOUT_MS;

  // quick-260710-sxf: render-state log. One throttled (~1500ms) `[ui] render`
  // line recording the displayed progress MODE so the byte-bar-vs-count-bar
  // decision is reconstructable from the app log (that decision is otherwise NOT
  // logged — only prep transitions / count / byte signal are). Mirrors
  // ProgressSection's render priority (prep > indeterminate > byteBar > countBar)
  // so the logged mode matches what the user actually saw. LOG-ONLY — no render
  // change. First effect run always logs (lastRenderLogRef initial = 0 → now-0 is
  // huge ≥ 1500); subsequent runs are gated to one line per ~1.5s.
  const lastRenderLogRef = useRef<number>(0);
  useEffect(() => {
    if (!currentStep) return;
    const now = Date.now();
    if (now - lastRenderLogRef.current < 1500) return;
    lastRenderLogRef.current = now;

    const bytesDone = progress.bytesDone ?? 0;
    const bytesTotal = progress.bytesTotal ?? 0;
    const showByteBar = !isIndeterminate && !prep && (bytesDone > 0 || bytesTotal > 0);
    let mode: string;
    if (prep) {
      mode = "prep";
    } else if (isIndeterminate) {
      mode = "indeterminate";
    } else if (showByteBar) {
      mode = bytesTotal > 0 ? "byteBar" : "byteBarRateOnly";
    } else {
      mode = "countBar";
    }
    const countPct = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
    const bytePct = bytesTotal > 0 ? Math.min(100, (bytesDone / bytesTotal) * 100) : 0;
    const barPct = prep || isIndeterminate ? -1 : showByteBar ? bytePct : countPct;
    info(
      `[ui] render step=${currentStep} mode=${mode} barPct=${barPct >= 0 ? barPct.toFixed(1) : "indet"} current=${progress.current}/${progress.total} bytesDone=${bytesDone} bytesTotal=${progress.bytesTotal ?? "null"} bytesRate=${progress.bytesRate ?? "null"}`,
    ).catch(() => {});
  }, [currentStep, isIndeterminate, prep, progress.current, progress.total, progress.bytesDone, progress.bytesTotal, progress.bytesRate]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Canonical running header (UI-SPEC §7): typed title + live target
          context + raw Stream/client supporting metadata on the left, the ONE
          semantic Cancel Sync on the right — wrap-capable at narrow widths,
          never hidden. While isCancelling the button is replaced in place by
          the natively disabled typed Cancelling button with spinner. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-4">
        <div className="min-w-0">
          <h2 className="text-section">{t("sync.running.title")}</h2>
          <p className="text-note text-muted">
            {targetCl
              ? t("steps.p4Sync.toCl", { cl: targetCl })
              : t("sync.running.targetHead")}
          </p>
          <p className="min-w-0 break-all font-mono text-caption text-muted">
            {t("sync.running.stream")} {stream ?? t("sync.running.classicClient")}
            {p4Client ? (
              <>
                {" · "}
                {t("sync.running.client")} {p4Client}
              </>
            ) : null}
          </p>
        </div>
        {isCancelling ? (
          <Button variant="outline" disabled className="h-9 px-6">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("sync.cancelling")}
          </Button>
        ) : (
          <Button variant="outline" onClick={onCancel} className="h-9 px-6">
            {t("sync.cancel")}
          </Button>
        )}
      </div>
      {/* Desktop: the canonical 144px rail + run-progress card grid with a
          16px gap (UI-SPEC §3 normalized values); <=850px the same grid
          collapses to one column and the same five step item instances
          reflow to a wrapping horizontal sequence above the card (CSS only). */}
      <div className="grid grid-cols-[144px_minmax(0,1fr)] gap-4 medium:grid-cols-1">
        <StepIndicator
          stepStatuses={stepStatuses}
          targetCl={targetCl}
          currentStep={currentStep}
          currentSubStep={currentSubStep}
        />
        <section className="min-w-0 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="text-section">{t("sync.progress.p4.title")}</h3>
              <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-caption leading-tight text-muted-foreground">
                {t("sync.badge.p4")}
              </span>
            </div>
            <span className="text-note text-muted">
              {t("sync.progress.filesLabel")}
            </span>
          </div>
          <ProgressSection
            current={progress.current}
            total={progress.total}
            currentFile={progress.currentFile}
            indeterminate={isIndeterminate}
            indeterminateLabel={indeterminateLabel}
            indeterminateDetail={isIndeterminate ? lastLog : undefined}
            // quick-260707-kdf: prep state — indeterminate bar + dictionary prep
            // label between p4Sync start and the first byte sample (or 20s
            // fallback). Parent ALWAYS passes the translated label when prep is
            // on so ProgressSection's omitted-prop path stays empty (Pitfall 3).
            prep={prep}
            prepLabel={prep ? t("sync.prep", { n: progress.total }) : undefined}
            // quick-260701-ep7: thread byte signal to ProgressSection. `?? undefined`
            // collapses null (typical non-heartbeat value) to "prop absent" so the
            // optional-prop defaults take over. Consumed ONLY in JSX render-time
            // (like lastLog) — does NOT enter the diagnostic effect's dep array.
            bytesDone={progress.bytesDone ?? undefined}
            bytesTotal={progress.bytesTotal ?? undefined}
            bytesRate={progress.bytesRate ?? undefined}
          />
        </section>
      </div>
      {/* Canonical raw-output log card (26-02 Task 3): bg-well surface,
          1px border, 6px radius, Terminal-icon header with the typed title,
          16px top separation from the run card, and the bounded virtualized
          body inside. The bounded min-h-0 flex-1 ancestor chain above the
          log region is preserved — neither the virtualizer nor streamed
          logs may grow the document root (UI-SPEC §7/§14, T-26-06). */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-well">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2 font-mono text-caption text-muted">
          <Terminal className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("sync.log.title")}
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <LogViewer lines={logLines} />
        </div>
      </div>
    </div>
  );
}
