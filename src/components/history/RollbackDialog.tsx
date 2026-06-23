import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Virtuoso } from "react-virtuoso";
import { Loader2 } from "lucide-react";
import type { ChangelistEntry } from "@/lib/types";
import * as commands from "@/lib/commands";

interface RollbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  onRollback: (targetCl: string) => void;
}

export function RollbackDialog({
  open,
  onOpenChange,
  workspaceId,
  onRollback,
}: RollbackDialogProps) {
  const [entries, setEntries] = useState<ChangelistEntry[]>([]);
  const entriesRef = useRef<ChangelistEntry[]>([]);
  const [selectedCl, setSelectedCl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore || !workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const currentEntries = entriesRef.current;
      const afterCl =
        currentEntries.length > 0 ? currentEntries[currentEntries.length - 1].number : undefined;
      const batch = await commands.getChangelists(workspaceId, 25, afterCl);
      if (batch.length === 0) {
        setHasMore(false);
      } else {
        const updated = [...currentEntries, ...batch];
        entriesRef.current = updated;
        setEntries(updated);
      }
    } catch (e) {
      console.error("Failed to load changelists:", e);
      setError("Failed to load changelists. Check P4 connection and try again.");
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [loading, hasMore, workspaceId]);

  // Reset and load initial batch when dialog opens
  useEffect(() => {
    if (open) {
      entriesRef.current = [];
      setEntries([]);
      setSelectedCl(null);
      setError(null);
      setShowConfirm(false);
      setIsRollingBack(false);
      setHasMore(true);
    }
  }, [open]);

  // Trigger initial load after reset
  useEffect(() => {
    if (open && entries.length === 0 && hasMore && !loading && !error) {
      loadMore();
    }
  }, [open, entries.length, hasMore, loading, error, loadMore]);

  const handleSelectCl = (cl: string) => {
    setSelectedCl(cl === selectedCl ? null : cl);
  };

  const handleRollbackClick = () => {
    if (!selectedCl) return;
    setShowConfirm(true);
  };

  const handleConfirmRollback = () => {
    if (!selectedCl) return;
    setIsRollingBack(true);
    onRollback(selectedCl);
  };

  const handleCancelConfirm = () => {
    setShowConfirm(false);
  };

  const handleRetry = () => {
    setEntries([]);
    setHasMore(true);
    setError(null);
  };

  const selectedEntry = entries.find((e) => e.number === selectedCl);

  return (
    <Dialog open={open} onOpenChange={isRollingBack ? undefined : onOpenChange}>
      <DialogContent className="bg-[hsl(0,0%,14%)] border-border text-foreground sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {showConfirm ? "Confirm Rollback" : "Rollback to Changelist"}
          </DialogTitle>
          <DialogDescription>
            {showConfirm
              ? `This will sync workspace to CL #${selectedCl}. Any unsynced files at the current revision will be overwritten. Close UE editor before proceeding.`
              : "Select a changelist from the server to sync to."}
          </DialogDescription>
        </DialogHeader>

        {showConfirm ? (
          /* Confirm view */
          <div className="space-y-4">
            <div className="rounded-md bg-[hsl(0,0%,9%)] border border-border p-4">
              <p className="text-sm text-muted">
                Selected: CL #{selectedCl}
              </p>
              {selectedEntry && (
                <p className="text-sm text-muted mt-1">
                  {selectedEntry.description}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <Button
                variant="ghost"
                onClick={handleCancelConfirm}
                disabled={isRollingBack}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmRollback}
                disabled={isRollingBack}
                className="bg-accent text-accent-foreground hover:bg-accent/90"
              >
                {isRollingBack ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Rolling back...
                  </>
                ) : (
                  `Rollback to CL #${selectedCl}`
                )}
              </Button>
            </div>
          </div>
        ) : error ? (
          /* Error state */
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted mb-4">{error}</p>
            <Button variant="outline" onClick={handleRetry}>
              Retry
            </Button>
          </div>
        ) : (
          /* CL list with infinite scroll */
          <div className="flex flex-col">
            <Virtuoso
              style={{ height: 400 }}
              data={entries}
              endReached={loadMore}
              itemContent={(_index, entry) => (
                <div
                  className={`px-4 py-2 border-b border-border cursor-pointer transition-colors ${
                    selectedCl === entry.number
                      ? "bg-accent/10 border-l-2 border-l-accent"
                      : "hover:bg-[hsl(0,0%,18%)]"
                  }`}
                  onClick={() => handleSelectCl(entry.number)}
                >
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="font-semibold">CL #{entry.number}</span>
                    <span className="text-muted">&middot;</span>
                    <span className="text-muted">{entry.user}</span>
                    <span className="text-muted">&middot;</span>
                    <span className="text-muted">{entry.date}</span>
                  </div>
                  <p className="text-sm text-muted line-clamp-2 mt-0.5">
                    {entry.description}
                  </p>
                </div>
              )}
              components={{
                Footer: () =>
                  loading ? (
                    <div className="flex items-center justify-center py-4">
                      <p className="text-sm text-muted">
                        Loading changelists...
                      </p>
                    </div>
                  ) : !hasMore && entries.length > 0 ? (
                    <div className="flex items-center justify-center py-4">
                      <p className="text-sm text-muted">
                        No more changelists
                      </p>
                    </div>
                  ) : null,
              }}
            />
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isRollingBack}
              >
                Cancel
              </Button>
              <Button
                onClick={handleRollbackClick}
                disabled={!selectedCl || isRollingBack}
                className="bg-accent text-accent-foreground hover:bg-accent/90"
              >
                {selectedCl ? `Rollback to CL #${selectedCl}` : "Rollback"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
