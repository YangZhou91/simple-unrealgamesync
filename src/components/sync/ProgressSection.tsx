import { Progress } from "@/components/ui/progress";

interface ProgressSectionProps {
  current: number;
  total: number;
  currentFile: string;
  indeterminate?: boolean;
  // "What step" text shown in place of the bare "Working…" literal when
  // indeterminate. Falls back to "Working…" if omitted (preserves prior behavior).
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
}: ProgressSectionProps) {
  // When current exceeds the dry-run estimate (new CLs arrived mid-sync),
  // show "N+ files…" instead of "N/N files" so the user knows it's still running.
  const overrun = total > 0 && current >= total;
  const fileText = total > 0
    ? overrun
      ? `${total}+ files…`
      : `${current}/${total} files`
    : `${current} files...`;
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

  return (
    <div className="flex flex-col gap-1.5 px-6 py-2">
      <span className="text-sm text-foreground">
        {indeterminate
          ? (indeterminateLabel ?? "Working…")
          : showByteBar
            ? byteText
            : fileText}
      </span>
      <Progress
        value={
          indeterminate
            ? undefined
            : showByteBar
              ? (bytePct ?? pct)
              : pct
        }
        indeterminate={indeterminate}
        className="h-2"
      />
      {currentFile && (
        <span className="text-xs text-muted font-mono truncate">
          {currentFile}
        </span>
      )}
      {indeterminate && indeterminateDetail && (
        <span className="text-xs text-muted font-mono truncate">
          {indeterminateDetail}
        </span>
      )}
    </div>
  );
}
