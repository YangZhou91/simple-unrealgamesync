import { Progress } from "@/components/ui/progress";

interface ProgressSectionProps {
  current: number;
  total: number;
  currentFile: string;
  indeterminate?: boolean;
}

export function ProgressSection({
  current,
  total,
  currentFile,
  indeterminate = false,
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
        {indeterminate ? "Working…" : fileText}
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
    </div>
  );
}
