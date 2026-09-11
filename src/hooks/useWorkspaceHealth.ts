import { useState, useCallback, useRef, useEffect } from "react";
import type { WorkspaceHealthReport } from "@/lib/types";
import * as commands from "@/lib/commands";

/**
 * HIST-02 / D-07: Drives the on-demand workspace-health audit
 * (check_workspace_health Tauri command — p4 reconcile -n + p4 where over the
 * Config/Source/.uproject whitelist). One-shot, on-demand (NOT a scheduled
 * poll like useBehindCheck). Exposes:
 *   - report: the categorized audit result (null until a successful run)
 *   - loading: true while the audit is in flight
 *   - error: a string error message on failure (null otherwise)
 *   - runAudit(workspaceId): kicks off the audit; no-op if already loading,
 *     if id is empty, or if id does not match the hook's current workspaceId
 *   - reset(): clears report + error + loading back to idle and invalidates
 *     in-flight results via a generation bump
 *
 * Stale-result discard copies useBehindCheck's request-id half only: a
 * generation counter is incremented on workspaceId change and on reset();
 * setReport / setError / setLoading / inFlightRef writes apply only when the
 * captured generation still matches (including finally). There is no health
 * cancel IPC — do not copy cancelSyncBehind.
 *
 * The audit is read-only — this hook never triggers sync/add/fix actions
 * and never auto-runs on workspace change.
 */
export function useWorkspaceHealth(workspaceId: string | null) {
  const [report, setReport] = useState<WorkspaceHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generation counter — a stale in-flight result is discarded if the id
  // captured at call start no longer matches the current ref (workspace
  // switch or reset). Boolean inFlightRef still blocks same-workspace
  // double-click while loading.
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    generationRef.current += 1;
    inFlightRef.current = false;
    setReport(null);
    setError(null);
    setLoading(false);
  }, [workspaceId]);

  const runAudit = useCallback(
    async (id: string) => {
      if (!id || inFlightRef.current || id !== workspaceId) {
        return;
      }
      const gen = generationRef.current;
      inFlightRef.current = true;
      setLoading(true);
      try {
        const result = await commands.checkWorkspaceHealth(id);
        if (gen !== generationRef.current) return;
        setReport(result);
        setError(null);
      } catch (e) {
        if (gen !== generationRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === generationRef.current) {
          setLoading(false);
          inFlightRef.current = false;
        }
      }
    },
    [workspaceId],
  );

  const reset = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current = false;
    setReport(null);
    setError(null);
    setLoading(false);
  }, []);

  return {
    report,
    loading,
    error,
    runAudit,
    reset,
  };
}
