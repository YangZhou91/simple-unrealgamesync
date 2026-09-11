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
import { useT } from "@/lib/i18n";

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
  const { t } = useT();
  const [entries, setEntries] = useState<ChangelistEntry[]>([]);
  const entriesRef = useRef<ChangelistEntry[]>([]);
  const [selectedCl, setSelectedCl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore || !workspaceId) return;
    setLoading(true);
    setLoadError(false);
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
      setLoadError(true);
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
      setLoadError(false);
      setShowConfirm(false);
      setIsRollingBack(false);
      setHasMore(true);
    }
  }, [open]);

  // Trigger initial load after reset
  useEffect(() => {
    if (open && entries.length === 0 && hasMore && !loading && !loadError) {
      loadMore();
    }
  }, [open, entries.length, hasMore, loading, loadError, loadMore]);

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
    setLoadError(false);
  };

  const selectedEntry = entries.find((e) => e.number === selectedCl);
  const isEmptyZeroBatch =
    !loadError && !showConfirm && !loading && !hasMore && entries.length === 0;

  return (
    <Dialog open={open} onOpenChange={isRollingBack ? undefined : onOpenChange}>
      <DialogContent className="bg-popover border-border text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {showConfirm
              ? t("history.rollback.confirmTitle")
              : t("history.rollback.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {showConfirm
              ? t("history.rollback.confirmSubtitle")
              : t("history.rollback.dialogDesc")}
          </DialogDescription>
        </DialogHeader>

        {showConfirm ? (
          /* Confirm view */
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-well p-4">
              <p className="font-mono text-sm font-medium">
                {t("history.clBadge", { cl: selectedCl ?? "" })}
              </p>
              <p className="text-sm text-muted">
                {t("history.rollback.selected", { cl: selectedCl ?? "" })}
              </p>
              {selectedEntry && (
                <p className="mt-1 text-xs text-muted">
                  {selectedEntry.description}
                </p>
              )}
            </div>
            <div className="rounded-lg bg-warning-surface p-4 text-warning">
              {t("history.rollback.confirmBody", { cl: selectedCl ?? "" })}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button
                variant="outline"
                onClick={handleCancelConfirm}
                disabled={isRollingBack}
              >
                {t("history.rollback.dismiss")}
              </Button>
              <Button
                onClick={handleConfirmRollback}
                disabled={isRollingBack}
              >
                {isRollingBack ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    {t("history.rollback.rollingBack")}
                  </>
                ) : (
                  t("history.rollback.toCl", { cl: selectedCl ?? "" })
                )}
              </Button>
            </div>
          </div>
        ) : loadError ? (
          /* Error state — kind flag; chrome from dictionary */
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted mb-4">
              {t("history.rollback.loadError")}
            </p>
            <Button variant="outline" onClick={handleRetry}>
              {t("history.rollback.retry")}
            </Button>
          </div>
        ) : (
          /* CL list with infinite scroll */
          <div className="flex flex-col">
            {isEmptyZeroBatch ? (
              <div
                className="flex items-center justify-center"
                style={{ height: 400 }}
              >
                <p className="text-sm text-muted text-center">
                  {t("history.rollback.empty")}
                </p>
              </div>
            ) : (
              <Virtuoso
                style={{ height: 400 }}
                data={entries}
                endReached={loadMore}
                itemContent={(_index, entry) => (
                  <button
                    type="button"
                    aria-pressed={selectedCl === entry.number}
                    onClick={() => handleSelectCl(entry.number)}
                    className={`mb-2 w-full rounded-lg border p-3 text-left ${
                      selectedCl === entry.number
                        ? "border-primary bg-accent"
                        : "border-border bg-well"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-sm">
                      <span className="font-mono">
                        {t("history.clBadge", { cl: entry.number })}
                      </span>
                      <span className="text-muted">&middot;</span>
                      <span className="text-muted">{entry.user}</span>
                      <span className="text-muted">&middot;</span>
                      <span className="text-muted">{entry.date}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted">
                      {entry.description}
                    </p>
                  </button>
                )}
                components={{
                  Footer: () =>
                    loading ? (
                      <div className="flex items-center justify-center py-4">
                        <p className="text-sm text-muted">
                          {t("history.rollback.loadingMore")}
                        </p>
                      </div>
                    ) : !hasMore && entries.length > 0 ? (
                      <div className="flex items-center justify-center py-4">
                        <p className="text-sm text-muted">
                          {t("history.rollback.noMore")}
                        </p>
                      </div>
                    ) : null,
                }}
              />
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isRollingBack}
              >
                {t("history.rollback.dismiss")}
              </Button>
              <Button
                onClick={handleRollbackClick}
                disabled={!selectedCl || isRollingBack}
                variant={selectedCl ? "default" : "outline"}
              >
                {selectedCl
                  ? t("history.rollback.toCl", { cl: selectedCl })
                  : t("history.rollback")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
