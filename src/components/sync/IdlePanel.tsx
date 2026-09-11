import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowDownToLine,
  Check,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  GitBranch,
  GitPullRequest,
  Loader2,
  Play,
} from "lucide-react";
import { CompletionSummaryPanel } from "./CompletionSummaryPanel";
import { useT, useStepLabels, resolveSubStep, formatTimestamp } from "@/lib/i18n";
import { STEP_ORDER } from "@/lib/types";
import type { GitBranchInfo, LastSyncResult, P4BehindInfo, WarningEntry } from "@/lib/types";

interface IdlePanelProps {
  lastSyncResult: LastSyncResult | null;
  hasWorkspace: boolean;
  targetCl: string;
  onTargetClChange: (cl: string) => void;
  onStartSync: () => void;
  onGitPull: () => void;
  isBusy: boolean;
  gitBranchInfo: GitBranchInfo | null;
  gitBranchLoading: boolean;
  behindInfo: P4BehindInfo | null;
  behindLoading: boolean;
  // Optional with defaults so existing test fixtures (and any other caller)
  // keep type-checking — App.tsx always threads both. null stream renders the
  // pinned `classic client` placeholder; null p4Client renders an empty Client
  // value (App never lets that happen at runtime).
  stream?: string | null;
  p4Client?: string | null;
  // quick-260713-kx6: opt-out of syncing UnrealEngine engine source during a
  // Target CL sync. Defaults OFF (syncEngine=false) and onSyncEngineChange is a
  // no-op so existing test fixtures keep type-checking. App.tsx always threads
  // both at runtime.
  syncEngine?: boolean;
  onSyncEngineChange?: (v: boolean) => void;
  // Phase 14 (SUMM-21..23): aggregated warnings from the most-recent
  // sync/force-sync/rollback. Optional with default `[]` so existing test
  // fixtures keep type-checking — App.tsx always threads it at runtime.
  // Empty array renders no summary per D-11 (byte-identical to today).
  lastSyncWarnings?: WarningEntry[];
  // Phase 26 (26-01): live workspace CL for the P4 card footer. Optional with
  // a null default (mirroring stream/p4Client) so existing fixtures keep
  // type-checking — App.tsx threads workspaces.currentCl at runtime.
  currentCl?: string | null;
}

export function IdlePanel({
  lastSyncResult,
  hasWorkspace,
  targetCl,
  onTargetClChange,
  onStartSync,
  onGitPull,
  isBusy,
  gitBranchInfo,
  gitBranchLoading,
  behindInfo,
  behindLoading,
  syncEngine = false,
  onSyncEngineChange = () => {},
  lastSyncWarnings = [],
  currentCl = null,
}: IdlePanelProps) {
  // Phase 20 (SWEEP-01): CL validation stores a BOOLEAN only — the translated
  // error prose is looked up at render via t("sync.targetCl.error"), never
  // stored in state (same bug class as Phase 19 lastSyncResult.time).
  const [clInvalid, setClInvalid] = useState(false);
  const { t, locale } = useT();
  const stepLabel = useStepLabels();

  const handleClChange = (value: string) => {
    onTargetClChange(value);
    setClInvalid(value.length > 0 && !/^\d+$/.test(value));
  };

  // Phase 26 (26-01) — canonical vertical sequence (UI-SPEC §6): primary
  // Perforce card, secondary Git row, closed five-step disclosure, then the
  // latest-result card only when live lastSyncResult exists. All values are
  // live props; nothing is fetched or derived locally beyond the existing
  // clInvalid flag.
  return (
    <div className="h-full min-w-0 overflow-y-auto px-4 py-4 medium:px-6">
      {/* 1 — Primary Perforce project card */}
      <section className="min-w-0 rounded-lg border border-border bg-card">
        <div className="p-4">
          {/* Header: title + P4 chip left, live behind badge right (wraps
              beneath the title at narrow widths instead of overlapping). */}
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[17px] font-medium text-foreground">{t("sync.p4.cardTitle")}</h2>
                <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground">
                  {t("sync.badge.p4")}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t("sync.p4.cardHint")}</p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 medium:justify-end">
              {behindLoading ? (
                <span className="inline-flex items-center gap-2 rounded-md bg-well px-2.5 py-1 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("sync.behind.checking")}
                </span>
              ) : behindInfo?.behind ? (
                <>
                  <span className="inline-flex items-center gap-2 rounded-md bg-warning-surface px-2.5 py-1 text-xs text-warning">
                    <ArrowDownToLine className="h-4 w-4" />
                    {t("sync.behind.badge", { n: behindInfo.behind })}
                  </span>
                  <span className="min-w-0 text-xs text-muted-foreground">
                    {behindInfo.behind === 1
                      ? t("sync.behind.one", { n: behindInfo.behind })
                      : t("sync.behind.other", { n: behindInfo.behind })}
                  </span>
                </>
              ) : behindInfo ? (
                <>
                  <span className="inline-flex items-center gap-2 rounded-md bg-accent/15 px-2.5 py-1 text-xs text-success">
                    <CircleCheck className="h-4 w-4" />
                    {t("sync.behind.badgeUpToDate")}
                  </span>
                  <span className="min-w-0 text-xs text-muted-foreground">{t("sync.behind.uptodate")}</span>
                </>
              ) : (
                <span className="min-w-0 text-xs text-muted-foreground">{t("sync.behind.choose")}</span>
              )}
            </div>
          </div>

          {/* Target area: two-column minmax grid above 850px, one column with
              the hint following the input through the medium variant. */}
          <div className="mt-4 grid grid-cols-[minmax(140px,1fr)_minmax(160px,1fr)] items-end gap-4 medium:grid-cols-1">
            <div className="min-w-0">
              <label htmlFor="target-changelist" className="mb-1.5 block text-xs text-muted-foreground">
                {t("sync.targetCl")}
              </label>
              <Input
                id="target-changelist"
                type="text"
                inputMode="numeric"
                value={targetCl}
                onChange={(e) => handleClChange(e.target.value)}
                placeholder={t("sync.targetCl.placeholder")}
                aria-invalid={clInvalid}
                aria-describedby={clInvalid ? "target-changelist-error" : undefined}
                className="h-9 border-border bg-well font-mono text-xs tabular-nums"
              />
              {clInvalid && (
                <p id="target-changelist-error" role="alert" className="mt-1 text-xs text-destructive">
                  {t("sync.targetCl.error")}
                </p>
              )}
            </div>
            {/* Blank target means HEAD (D-02/SYNC-01) — typed guidance only,
                never a fabricated numeric CL. An invalid target shows only the
                alert, so the hint is unmounted. */}
            {!clInvalid && (
              <p className="pb-2 text-xs text-muted-foreground medium:pb-0">
                {targetCl.length > 0
                  ? stepLabel("p4Sync", "toCl", { cl: targetCl })
                  : t("sync.targetCl.headHint")}
              </p>
            )}
          </div>

          {/* Engine opt-in — revealed only for a valid numeric CL, default off
              (useSync owns syncEngine=false), hint flips with checked state. */}
          {targetCl.length > 0 && !clInvalid && (
            <div className="mt-3 border-t border-border pt-3">
              <label className="flex min-h-8 cursor-pointer select-none items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={syncEngine}
                  onChange={(e) => onSyncEngineChange(e.target.checked)}
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
                <span className="text-xs text-foreground">{t("sync.engine.checkbox")}</span>
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                {syncEngine ? t("sync.engine.hintOn") : t("sync.engine.hintOff")}
              </p>
            </div>
          )}
        </div>

        {/* Footer: live current CL left, Start Sync right (full width at 620px
            and below). Disabled only by the existing lock booleans. Null CL
            hides the value (never a fabricated CL). */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-xs text-muted-foreground">
            <span>{t("sync.p4.currentCl")}</span>
            {currentCl != null && (
              <span className="font-mono tabular-nums text-foreground">{currentCl}</span>
            )}
          </span>
          <Button
            onClick={onStartSync}
            disabled={!hasWorkspace || clInvalid || isBusy}
            className="h-9 bg-primary text-primary-foreground hover:bg-primary/90 narrow:w-full"
          >
            <Play className="h-3.5 w-3.5" />
            {t("sync.start")}
          </Button>
        </div>
      </section>

      {/* 2 — Secondary UnrealEngine Git row */}
      <section className="mt-4 min-w-0 rounded-lg border border-border bg-card p-4 narrow:p-2">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[17px] font-medium text-foreground">{t("sync.git.cardTitle")}</h3>
              <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-[11px] leading-tight text-info">
                {t("sync.badge.git")}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("sync.git.cardHint")}</p>
            {gitBranchLoading ? (
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("sync.git.checking")}
              </div>
            ) : gitBranchInfo?.branch ? (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-foreground">
                  <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-all">
                    {gitBranchInfo.is_detached ? t("sync.git.detachedParen") : gitBranchInfo.branch}
                  </span>
                  {gitBranchInfo.short_hash && (
                    <span className="text-muted-foreground">· {gitBranchInfo.short_hash}</span>
                  )}
                </span>
                <span
                  className={
                    gitBranchInfo.behind || gitBranchInfo.is_detached
                      ? "text-warning"
                      : "text-success"
                  }
                >
                  {gitBranchInfo.behind
                    ? t("sync.git.status.behind", { n: gitBranchInfo.behind })
                    : gitBranchInfo.is_detached
                      ? t("sync.git.status.detached")
                      : t("sync.git.status.uptodate")}
                </span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{t("sync.git.empty")}</p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onGitPull}
            disabled={!hasWorkspace || isBusy}
            className="h-9 text-xs narrow:w-full"
          >
            <GitPullRequest className="h-3.5 w-3.5" />
            {t("sync.git.pull")}
          </Button>
        </div>
        {/* Repository details disclosure — display-only remote metadata from
            live gitBranchInfo; no fetch, no fabricated values. */}
        {gitBranchInfo?.branch && (
          <details className="mt-2 min-w-0">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t("sync.git.details")}
            </summary>
            <dl className="mt-2 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">{t("sync.git.dt.remote")}</dt>
              <dd className="min-w-0 break-all font-mono text-foreground/85">
                {gitBranchInfo.remote || "—"}
              </dd>
            </dl>
          </details>
        )}
      </section>

      {/* 3 — Closed five-step disclosure: explanatory chrome only. Labels are
          derived at render from STEP_ORDER + useStepLabels; no action, no
          state mutation, no second step definition. */}
      <details className="mt-4 min-w-0">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t("sync.pipeline.details")}
        </summary>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {STEP_ORDER.map((step, i) => (
            <span key={step} className="flex min-w-0 items-center gap-2.5">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
              <span className="min-w-0">{stepLabel(step, resolveSubStep(step, null, ""))}</span>
            </span>
          ))}
        </div>
      </details>

      {/* 4 — Latest result card: completed/cancelled project from live
          lastSyncResult only (UI-SPEC §8). Cancelled never claims success and
          never fabricates a completion time — the real step label rides the
          existing steps.status.cancelledAt composition. */}
      {lastSyncResult && (
        <section className="mt-4 min-w-0 rounded-lg border border-border bg-card">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {lastSyncResult.status === "cancelled" ? (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-well text-muted-foreground">
                  <CircleSlash className="h-3.5 w-3.5" />
                </span>
              ) : (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/15 text-success">
                  <Check className="h-3.5 w-3.5" />
                </span>
              )}
              <div className="min-w-0">
                <h3 className="text-xs font-medium text-foreground">
                  {lastSyncResult.status === "cancelled"
                    ? t("sync.result.cancelledTitle")
                    : t("sync.last.title")}
                </h3>
                {lastSyncResult.status !== "cancelled" && (
                  <p className="mt-0.5 min-w-0 break-words text-[11px] text-muted-foreground">
                    {t("sync.last.line", {
                      cl: lastSyncResult.cl ?? "?",
                      n: lastSyncResult.fileCount,
                    })}
                  </p>
                )}
              </div>
            </div>
            <time className="min-w-0 break-words text-[11px] text-muted-foreground">
              {lastSyncResult.status === "cancelled"
                ? t("steps.status.cancelledAt", {
                    step: stepLabel(
                      lastSyncResult.step ?? "",
                      resolveSubStep(
                        lastSyncResult.step ?? "",
                        lastSyncResult.subStep,
                        lastSyncResult.cl ?? "",
                      ),
                      { cl: lastSyncResult.cl ?? undefined },
                    ),
                  })
                : formatTimestamp(lastSyncResult.epochMs, locale)}
            </time>
          </div>
          {/* Warnings region — separated from the result header by a 1px
              semantic border; absent entirely for an empty warning array. */}
          {lastSyncWarnings.length > 0 && (
            <div className="border-t border-border px-4 py-3">
              <CompletionSummaryPanel warnings={lastSyncWarnings} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
