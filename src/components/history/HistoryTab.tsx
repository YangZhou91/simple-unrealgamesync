import { Virtuoso } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import type { HistoryRecord } from "@/lib/types";
import { useT } from "@/lib/i18n";
import {
  formatTimestamp,
  parseHistoryTimestamp,
} from "@/lib/i18n/formatTimestamp";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

interface HistoryTabProps {
  workspaceId: string | null;
  isSyncRunning: boolean;
  onRollback: () => void;
  records: HistoryRecord[];
  isLoading: boolean;
}

export function HistoryTab({
  workspaceId,
  isSyncRunning,
  onRollback,
  records,
  isLoading,
}: HistoryTabProps) {
  const { t, locale } = useT();
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sticky section head — outside Virtuoso (D-03). */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-4">
        <div className="min-w-0">
          <h2 className="text-section">{t("history.title")}</h2>
          <p className="mt-1 text-note text-muted">{t("history.subtitle")}</p>
        </div>
        <Button
          variant="outline"
          onClick={onRollback}
          disabled={isSyncRunning || !workspaceId}
          className="h-9 shrink-0 px-3"
          title={
            isSyncRunning
              ? t("history.rollback.disabledTitle")
              : undefined
          }
        >
          <RotateCcw className="h-4 w-4" />
          {t("history.rollback")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-note text-muted">{t("history.loading")}</p>
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <h3 className="text-section text-foreground">
            {t("history.empty.title")}
          </h3>
          <p className="text-note text-muted">
            {t("history.empty.body")}
          </p>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 shrink-0 items-center border-b border-border px-2 text-caption font-normal text-muted">
            <div className="min-w-0 flex-1 truncate pl-0">
              {t("history.columns.changelist")}
            </div>
            <div className="min-w-0 flex-1 truncate">
              {t("history.columns.time")}
            </div>
            <div className="min-w-0 flex-1 truncate text-right">
              {t("history.columns.duration")}
            </div>
            <div className="min-w-0 flex-1 truncate text-right">
              {t("history.columns.files")}
            </div>
          </div>
          <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
            <Virtuoso
              className="h-full w-full"
              data={records}
              defaultItemHeight={40}
              computeItemKey={(_, record) =>
                `${record.changelist}-${record.timestamp}`
              }
              itemContent={(_, record) => {
                const ms = parseHistoryTimestamp(record.timestamp);
                return (
                  <div className="flex h-10 min-w-0 items-center border-b border-border px-2 hover:bg-card">
                    <div
                      className="min-w-0 flex-1 truncate font-mono text-note tabular-nums"
                      title={record.changelist}
                    >
                      {t("history.clBadge", { cl: record.changelist })}
                    </div>
                    <div
                      className="min-w-0 flex-1 truncate text-note text-muted"
                      title={record.timestamp}
                    >
                      {ms == null
                        ? record.timestamp
                        : formatTimestamp(ms, locale)}
                    </div>
                    <div className="min-w-0 flex-1 truncate text-right text-note text-muted tabular-nums">
                      {record.durationMs != null
                        ? formatDuration(record.durationMs)
                        : "—"}
                    </div>
                    <div className="min-w-0 flex-1 truncate text-right text-note text-muted tabular-nums">
                      {t("history.files", { n: record.fileCount })}
                    </div>
                  </div>
                );
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
