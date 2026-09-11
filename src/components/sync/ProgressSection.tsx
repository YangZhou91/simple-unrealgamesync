import { Progress } from "@/components/ui/progress";
import { useT } from "@/lib/i18n";

interface ProgressSectionProps {
  current: number;
  total: number;
  currentFile: string;
  indeterminate?: boolean;
  // "What step" text shown in place of a bare label when indeterminate.
  // Phase 20 (Pitfall 3): STRING SINK — the parent always passes an
  // already-translated string. Omitted renders "" (never a hardcoded
  // locale fallback).
  indeterminateLabel?: string;
  // Live liveness line (latest log line) rendered BELOW the bar during
  // indeterminate mode, in the same style as `currentFile`.
  indeterminateDetail?: string;
  // quick-260701-ep7: optional byte-level signal for the p4Sync tail. When
  // bytesTotal is present the bar is byte-driven ("X.X / Y.Y GB · Z.Z MB/s");
  // when only bytesDone is moving the bar is rate-only ("X.X GB · Z.Z MB/s",
  // liveness proof with no percentage); otherwise the count-based bar renders
  // unchanged. null/absent = no byte signal (fall back to count-based).
  bytesDone?: number | null;
  bytesTotal?: number | null;
  bytesRate?: number | null;
  // quick-260707-kdf: prep state — shown between "p4Sync started" and the
  // first byte sample (or the 20s fallback). When true, the bar is
  // indeterminate and the main line shows `prepLabel` (Phase 20 Pitfall 3:
  // parent-passed translated string, e.g. t("sync.prep", { n })). Highest-
  // priority render branch; RunningPanel guarantees `prep` is only set when
  // `!isIndeterminate`, so it never collides with the genProject/forceSync/
  // overrun indeterminate path.
  prep?: boolean;
  prepLabel?: string;
  // Phase 15 (D-02): raw percent mode for git pull. When present and not
  // indeterminate/prep, renders `<Progress value={rawPercent} />` labeled
  // `rawPercentLabel` (e.g. "Receiving objects 67%"). null/undefined = fall
  // back to count/byte/indeterminate. Used ONLY by GitRunningPanel (p4Sync
  // never sets this). New highest-priority DETERMINATE mode (above byte/count,
  // below prep/indeterminate) — mirrors the p4Sync bar's h-2 styling for
  // visual parity (D-02).
  rawPercent?: number | null;
  rawPercentLabel?: string;
}

/** Pure byte-amount formatter (GB/MB/KB auto-scale, 1 decimal). quick-260701-ep7. */
function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

export function ProgressSection({
  current,
  total,
  currentFile,
  indeterminate = false,
  indeterminateLabel,
  indeterminateDetail,
  bytesDone = null,
  bytesTotal = null,
  bytesRate = null,
  prep = false,
  prepLabel,
  rawPercent = null,
  rawPercentLabel,
}: ProgressSectionProps) {
  // Phase 20: the ONE legitimate useT() in this string sink — file-count
  // chrome. The counts (overrun / current / total) are computed here and both
  // RunningPanel and the byte-bar subtitle reuse fileText, so the lookup
  // lives at render in this component. prepLabel / indeterminateLabel /
  // rawPercentLabel stay parent-passed strings (Pitfall 3).
  const { t } = useT();
  // When current exceeds the dry-run estimate (new CLs arrived mid-sync),
  // show the overrun count so the user knows it's still running.
  const overrun = total > 0 && current >= total;
  const fileText = overrun
    ? t("sync.files.overrun", { n: total })
    : total > 0
      ? t("sync.files.count", { current, total })
      : t("sync.files.noTotal", { current });
  const pct = total > 0 ? (current / total) * 100 : 0;

  // quick-260701-ep7: compute a byte-level bar ONLY during the determinate
  // p4Sync phase when a byte signal is present. Two shapes:
  //   - bytesTotal present: byte-driven percentage + "X.X / Y.Y GB · Z.Z MB/s"
  //   - bytesTotal null but bytesDone moving: rate-only "X.X GB · Z.Z MB/s"
  //     (liveness proof for the dead tail when -N gave no denominator).
  // The byte signal is ignored during indeterminate (genProject / forceSync /
  // p4SyncOverrun) — the indeterminate label + lastLog render unchanged.
  let byteText: string | null = null;
  let bytePct: number | null = null;
  if (!indeterminate) {
    if (bytesTotal != null && bytesTotal > 0) {
      bytePct = Math.min(100, ((bytesDone ?? 0) / bytesTotal) * 100);
      const rateSuffix = bytesRate ? ` · ${formatBytes(bytesRate)}/s` : "";
      byteText = `${formatBytes(bytesDone ?? 0)} / ${formatBytes(bytesTotal)}${rateSuffix}`;
    } else if (bytesDone != null && bytesDone > 0) {
      const rateSuffix = bytesRate ? ` · ${formatBytes(bytesRate)}/s` : "";
      byteText = `${formatBytes(bytesDone)}${rateSuffix}`;
    }
  }

  // Render priority: during determinate p4Sync with a byte signal, the byte
  // bar takes precedence over the count-based fileText. Otherwise fall through
  // to the EXISTING fileText / pct / Progress logic (unchanged).
  const showByteBar = !indeterminate && byteText != null;

  // Phase 15 (D-02): raw percent mode for git pull. Highest-priority
  // DETERMINATE mode (below prep/indeterminate, above byte/count). When
  // rawPercent is present and the bar isn't prep/indeterminate, the git %
  // drives the fill + the phase label renders. p4Sync never sets rawPercent,
  // so the count/byte path is identical when rawPercent is null (SC#5).
  const showRawPercent = !prep && !indeterminate && rawPercent != null;

  // Phase 26 (26-02 Task 1): the 25px tabular percentage number renders ONLY
  // when a real denominator exists — count pct, byte pct when bytesTotal is
  // present, or rawPercent. A rate-only byte signal (bytesTotal null ->
  // bytePct null) renders NO number (UI-SPEC §7: never fabricate a percent).
  const numberValue = prep
    ? null
    : indeterminate
      ? null
      : showRawPercent
        ? rawPercent
        : showByteBar
          ? bytePct
          : total > 0
            ? pct
            : null;

  return (
    <div className="flex min-w-0 flex-col">
      {/* Canonical 25px/500 tabular progress number (UI-SPEC §4). */}
      {numberValue != null && (
        <div
          data-slot="progress-number"
          className="pb-2 font-medium tabular-nums text-progress"
        >
          <span>{Math.round(numberValue)}</span>
          <span className="text-note">%</span>
        </div>
      )}
      <Progress
        value={
          prep
            ? undefined
            : indeterminate
              ? undefined
              : showRawPercent
                ? rawPercent
                : showByteBar
                  ? (bytePct ?? pct)
                  : pct
        }
        indeterminate={prep || indeterminate}
        className="h-[5px] rounded-sm bg-well"
      />
      {/* Detail line (12px): the mode's primary string — parent-passed
          prep/indeterminate/rawPercent labels (string sink, Pitfall 3) or the
          computed count/byte chrome — plus the count chrome as the muted
          secondary under a byte bar. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pt-2">
        <span className="min-w-0 break-all text-note text-foreground">
          {prep
            ? (prepLabel ?? "")
            : indeterminate
              ? (indeterminateLabel ?? "")
              : showRawPercent
                ? (rawPercentLabel ?? "")
                : showByteBar
                  ? byteText
                  : fileText}
        </span>
        {showByteBar && (
          <span className="min-w-0 text-note text-muted">{fileText}</span>
        )}
      </div>
      {indeterminate && indeterminateDetail && (
        <span className="min-w-0 break-all pt-1 font-mono text-caption text-muted">
          {indeterminateDetail}
        </span>
      )}
      {/* Current raw file/path beneath a 1px semantic divider — raw verbatim
          text that wraps anywhere instead of truncating, so a long depot path
          can never overflow the card at 352px (UI-SPEC §7/§12). */}
      {currentFile && (
        <div className="mt-2 min-w-0 border-t border-border pt-2">
          <span className="block min-w-0 break-all font-mono text-caption text-muted">
            {currentFile}
          </span>
        </div>
      )}
    </div>
  );
}
