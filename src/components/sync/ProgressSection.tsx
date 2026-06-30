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
}

export function ProgressSection({
  current,
  total,
  currentFile,
  indeterminate = false,
  indeterminateLabel,
  indeterminateDetail,
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

  return (
    <div className="flex flex-col gap-1.5 px-6 py-2">
      <span className="text-sm text-foreground">
        {indeterminate ? (indeterminateLabel ?? "Working…") : fileText}
      </span>
      <Progress
        value={indeterminate ? undefined : pct}
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
