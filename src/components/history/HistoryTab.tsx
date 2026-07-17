import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw } from "lucide-react";
import type { HistoryRecord } from "@/lib/types";

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
  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div />
        <Button
          onClick={onRollback}
          disabled={isSyncRunning || !workspaceId}
          className="h-8 px-3 bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          title={
            isSyncRunning
              ? "Cannot rollback while sync is running"
              : undefined
          }
        >
          <RotateCcw className="h-4 w-4 mr-1.5" />
          Rollback
        </Button>
      </div>

      {/* History list */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted">Loading history...</p>
        </div>
      ) : records.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <h3 className="text-xl font-semibold text-foreground">
            No Sync History
          </h3>
          <p className="text-sm text-muted mt-2">
            Completed syncs will appear here.
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="flex flex-col">
            {records.map((record) => (
              <div
                key={`${record.changelist}-${record.timestamp}`}
                className="flex items-center h-10 px-4 border-b border-border hover:bg-card transition-colors"
              >
                <div className="w-[120px] shrink-0 whitespace-nowrap">
                  <Badge
                    variant="secondary"
                    className="font-semibold text-xs"
                  >
                    CL #{record.changelist}
                  </Badge>
                </div>
                <div className="flex-1 text-sm text-muted truncate">
                  {record.timestamp}
                </div>
                <div className="min-w-[80px] shrink-0 whitespace-nowrap text-right text-sm text-muted">
                  {record.fileCount} files
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
