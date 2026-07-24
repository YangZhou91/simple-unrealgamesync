import { useState, useEffect, useCallback } from "react";
import { Channel } from "@tauri-apps/api/core";
import type { HistoryRecord, SyncEvent, SyncStep, StepStatus, WarningEntry } from "@/lib/types";
import * as commands from "@/lib/commands";

type StepStatuses = Record<SyncStep, StepStatus>;

const initialStatuses: StepStatuses = {
  closeUe: "pending",
  closeExcel: "pending",
  cleanDevDir: "pending",
  p4Sync: "pending",
  genProject: "pending",
};

export function useHistory(
  workspaceId: string | null,
  onRollbackComplete?: (cl: string | null, warnings: WarningEntry[]) => void,
) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!workspaceId) {
      setRecords([]);
      return;
    }
    setIsLoading(true);
    try {
      const result = await commands.getHistory(workspaceId);
      setRecords(result);
    } catch (e) {
      console.error("Failed to load history:", e);
      setRecords([]);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const startRollback = useCallback(
    async (targetCl: string) => {
      if (!workspaceId) return;

      const channel = new Channel<SyncEvent>();
      const stepStatuses = { ...initialStatuses };

      channel.onmessage = (event: SyncEvent) => {
        switch (event.event) {
          case "stepStarted":
            stepStatuses[event.data.step as SyncStep] = "active";
            break;
          case "stepCompleted":
            stepStatuses[event.data.step as SyncStep] = event.data.success
              ? "completed"
              : "failed";
            break;
          case "syncCompleted":
            setIsRollingBack(false);
            // Phase 14 (SUMM-23 — checker blocker #1 fix): rollback's
            // SyncCompleted arrives on useHistory's OWN Channel (:48),
            // distinct from useSync's. Without widening this callback to
            // carry warnings, rollback warnings are silently dropped here
            // and never reach the App-owned summary slot. The ?? [] guard
            // handles the (impossible post-Task-1, but defensive) undefined.
            onRollbackComplete?.(event.data.changelist ?? null, event.data.warnings ?? []);
            loadHistory();
            break;
          case "syncFailed":
            setIsRollingBack(false);
            console.error(
              `Rollback failed at step ${event.data.step}: ${event.data.error}`,
            );
            break;
          case "syncCancelled":
            setIsRollingBack(false);
            break;
        }
      };

      setIsRollingBack(true);
      try {
        await commands.startRollback(workspaceId, targetCl, channel);
      } catch (e) {
        setIsRollingBack(false);
        console.error("Failed to start rollback:", e);
      }
    },
    [workspaceId, onRollbackComplete, loadHistory],
  );

  return {
    records,
    isLoading,
    isRollingBack,
    loadHistory,
    startRollback,
  };
}
