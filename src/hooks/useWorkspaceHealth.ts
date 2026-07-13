import { useState, useCallback, useRef } from "react";
import type { WorkspaceHealthReport } from "@/lib/types";
import * as commands from "@/lib/commands";

/**
 * quick-260713-s44: Drives the on-demand workspace-health audit
 * (check_workspace_health Tauri command — p4 reconcile -n + p4 where over the
 * Config/Source/.uproject whitelist). One-shot, on-demand (NOT a scheduled
 * poll like useBehindCheck). Exposes:
 *   - report: the categorized audit result (null until a successful run)
 *   - loading: true while the audit is in flight
 *   - error: a string error message on failure (null otherwise)
 *   - runAudit(workspaceId): kicks off the audit; no-op if already loading
 *     (concurrent guard via a useRef boolean)
 *   - reset(): clears report + error + loading back to idle
 *
 * The audit is read-only — this hook never triggers sync/add/fix actions.
 */
export function useWorkspaceHealth() {
  const [report, setReport] = useState<WorkspaceHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // In-flight guard — prevents a double-invoke when runAudit is called while a
  // previous audit is still loading. A plain boolean ref (not a counter like
  // useBehindCheck's requestId) because the audit is one-shot with no stale-
  // result invalidation concern.
  const inFlightRef = useRef(false);

  const runAudit = useCallback(async (workspaceId: string) => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    try {
      const result = await commands.checkWorkspaceHealth(workspaceId);
      setReport(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setReport(null);
    setError(null);
    setLoading(false);
    // Note: do NOT reset inFlightRef here — if a run is in flight, let it
    // complete naturally (reset only clears the visible state). This matches
    // the test expectation that reset clears report/error/loading.
  }, []);

  return {
    report,
    loading,
    error,
    runAudit,
    reset,
  };
}
