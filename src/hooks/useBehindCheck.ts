import { useState, useCallback, useRef } from "react";
import type { P4BehindInfo } from "@/lib/types";
import * as commands from "@/lib/commands";

/**
 * Drives the idle-view Perforce "behind" check. The hook itself does NOT own
 * the scheduling timer (App.tsx does) — it owns in-flight invalidation so a
 * sync starting mid-check causes any pending result to be ignored.
 */
export function useBehindCheck() {
  const [behindInfo, setBehindInfo] = useState<P4BehindInfo | null>(null);
  const [behindLoading, setBehindLoading] = useState(false);
  // Incrementing counter — a stale in-flight result is discarded if the id
  // captured at call start no longer matches the current ref.
  const requestIdRef = useRef(0);

  const runCheck = useCallback(async (workspaceId: string) => {
    const id = ++requestIdRef.current;
    setBehindLoading(true);
    try {
      const result = await commands.checkSyncBehind(workspaceId);
      // Only apply if this is still the latest request.
      if (id === requestIdRef.current) {
        setBehindInfo(result);
        setBehindLoading(false);
      }
    } catch (e) {
      console.error("Behind-check failed:", e);
      if (id === requestIdRef.current) {
        setBehindLoading(false);
      }
    }
  }, []);

  // Invalidate any in-flight call and reset state (e.g. when a sync starts).
  const cancel = useCallback(() => {
    requestIdRef.current++;
    setBehindInfo(null);
    setBehindLoading(false);
    void commands.cancelSyncBehind().catch(() => {});
  }, []);

  return {
    behindInfo,
    behindLoading,
    runCheck,
    clear: cancel,
    cancel,
  };
}
