import type { StepStatus, SyncStep } from "@/lib/types";
import { StepIndicator } from "./StepIndicator";
import { ProgressSection } from "./ProgressSection";
import { LogViewer } from "./LogViewer";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { info } from "@tauri-apps/plugin-log";
import { useEffect, useRef, useState } from "react";

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
  // SyncStep union (detected via `(currentStep as string) === "forceSync"`), and
  // stepDescriptions values can be null — so handle both. Only compute when
  // indeterminate (keeps determinate renders identical + avoids needless string work).
  const indeterminateLabel = isIndeterminate
    ? currentStep === "genProject"
      ? (stepDescriptions.genProject ?? "Generating project files…")
      : (currentStep as string) === "forceSync"
        ? "Force-syncing…"
        : p4SyncOverrun
          ? `${progress.total}+ files…`
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
  // lines in ~13s). Show an indeterminate bar + "正在准备… 将更新 N 个文件"
  // until either the byte signal arrives (byte bar takes over) or 20s elapses
  // (fall back to the count bar — it moves, beats an infinite spin).
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
        indeterminateLabel={indeterminateLabel}
        indeterminateDetail={isIndeterminate ? lastLog : undefined}
        // quick-260707-kdf: prep state — indeterminate bar + "正在准备…" label
        // between p4Sync start and the first byte sample (or 20s fallback).
        prep={prep}
        prepLabel={prep ? `正在准备… 将更新 ${progress.total} 个文件` : undefined}
        // quick-260701-ep7: thread byte signal to ProgressSection. `?? undefined`
        // collapses null (typical non-heartbeat value) to "prop absent" so the
        // optional-prop defaults take over. Consumed ONLY in JSX render-time
        // (like lastLog) — does NOT enter the diagnostic effect's dep array.
        bytesDone={progress.bytesDone ?? undefined}
        bytesTotal={progress.bytesTotal ?? undefined}
        bytesRate={progress.bytesRate ?? undefined}
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
