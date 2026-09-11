import { Virtuoso } from "react-virtuoso";
import { useT } from "@/lib/i18n";

interface LogViewerProps {
  lines: string[];
}

// Phase 26 (26-02 Task 3): the pure raw-lines region of the canonical log
// card (the card chrome — bg-well surface, border, Terminal-icon header —
// lives in RunningPanel / GitRunningPanel). Everything load-bearing is
// unchanged: Virtuoso with followOutput="smooth", the raw line array
// identity, direct `line` React text children (T-26-05: raw backend output
// is never translated, filtered, de-virtualized, or wrapped in markup), and
// the h-full min-h-0 flex-1 overflow-hidden bounding wrapper that keeps the
// virtualizer from growing the document root (T-26-06). Only the row
// presentation changed: 11px mono at 1.6 line height with pre-wrap +
// overflow-wrap anywhere, so long raw lines wrap within the log width
// instead of overflowing the viewport at 352px.
export function LogViewer({ lines }: LogViewerProps) {
  const { t } = useT();

  if (lines.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center text-caption text-muted">
        {t("sync.log.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <Virtuoso
        data={lines}
        followOutput="smooth"
        itemContent={(_, line) => (
          <div className="whitespace-pre-wrap px-2 py-0.5 font-mono text-[11px] leading-[1.6] text-muted [overflow-wrap:anywhere]">
            {line}
          </div>
        )}
        className="h-full"
      />
    </div>
  );
}
