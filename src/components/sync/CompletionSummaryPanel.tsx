import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { LogViewer } from "./LogViewer";
import { AlertTriangle, AlertCircle } from "lucide-react";
import { groupWarnings } from "@/lib/groupWarnings";
import type { WarningEntry } from "@/lib/types";

/**
 * Phase 14 (SUMM-21..23) — completion summary panel rendered inline in
 * IdlePanel directly below the `lastSyncResult` line. Surfaces the warnings
 * aggregated by Phase 13 (`SyncCompleted.warnings: WarningEntry[]`) as a
 * severity-grouped, expandable path list.
 *
 * Reuses the `WorkspaceHealthPanel.CategorySection` pattern verbatim (D-03)
 * and `LogViewer` for the per-group path list (D-05) — no new collapsible or
 * virtualization primitive. The D-12/D-13 folded path-vs-message rule is
 * applied upstream by `groupWarnings`, so this component renders the string
 * arrays as-is.
 *
 * Silent gate (D-11 / SC#2): when `warnings.length === 0` the component
 * returns `null` — IdlePanel is byte-identical to today when a sync is silent.
 *
 * Paths render RAW (redact() no-ops on `//FY_Depot` / `D:\FYDepot` per memory
 * `redact-catalog-noops-on-project-paths`); local-diagnosis only, no
 * copy/export affordance in v1 (SUMM-F01 deferred).
 */
interface CompletionSummaryPanelProps {
  warnings: WarningEntry[];
}

type Severity = "error" | "warning";

function SeverityGroup({
  label,
  count,
  paths,
  severity,
}: {
  label: string;
  count: number;
  paths: string[];
  severity: Severity;
}) {
  // D-03 verbatim reuse of WorkspaceHealthPanel.tsx:137
  // `defaultExpanded={count > 0}` — the group starts EXPANDED when it has
  // paths, COLLAPSED when empty. The count argument there is the number of
  // distinct paths in the category; here `paths.length` plays the same role.
  const [expanded, setExpanded] = useState(paths.length > 0);

  // D-08 palette — red for errors, amber for warnings. Applied to the Badge
  // so the severity color is visible at-a-glance alongside the count.
  const badgeClassName =
    severity === "error"
      ? "bg-red-500/15 text-destructive"
      : "bg-amber-500/15 text-amber-500";

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-accent/40"
      >
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <Badge variant="secondary" className={`text-xs ${badgeClassName}`}>
            {count}
          </Badge>
        </span>
        <span className="text-xs text-muted">
          {expanded ? "收起 ▲" : "展开 ▼"}
        </span>
      </button>
      {expanded && (
        <div className="h-40 border-t border-border flex flex-col">
          {paths.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              无 / none
            </div>
          ) : (
            <LogViewer lines={paths} />
          )}
        </div>
      )}
    </div>
  );
}

export function CompletionSummaryPanel({ warnings }: CompletionSummaryPanelProps) {
  // D-11 silent gate — load-bearing. Returns null before the root element
  // renders, so IdlePanel is byte-identical to today when a sync is silent.
  // Test 2 asserts this via the `data-summary-root` hook.
  if (warnings.length === 0) return null;

  const { errors, warnings: warningPaths } = groupWarnings(warnings);

  // Distinct-path counts per severity (drives both the header wording and the
  // per-group Badge semantics — matches WorkspaceHealthPanel's `Badge {count}`
  // = number of paths in the category, per CONTEXT D-08 recommendation).
  const errorCount = warnings.filter((w) => w.severity === "error").length;
  const warningCount = warnings.filter((w) => w.severity === "warning").length;

  // D-07 header wording — drop the zero-count clause(s). Both-zero is
  // impossible here (the D-11 gate already returned on empty input), but the
  // conditionals are written symmetrically for clarity.
  let headerClause: string;
  if (errorCount === 0) {
    headerClause = `同步完成 — ${warningCount} 条 warning`;
  } else if (warningCount === 0) {
    headerClause = `同步完成 — ${errorCount} 条 error`;
  } else {
    headerClause = `同步完成 — ${warningCount} 条 warning / ${errorCount} 条 error`;
  }

  // D-09 header escalates by error presence — red icon when errors exist,
  // amber when warnings-only. Mirrors the "any errors = red, else amber"
  // severity logic called out in the CONTEXT.
  const hasErrors = errorCount > 0;
  const HeaderIcon = hasErrors ? AlertCircle : AlertTriangle;
  const headerIconClassName = hasErrors
    ? "h-4 w-4 text-destructive"
    : "h-4 w-4 text-amber-500";

  return (
    <div
      className="w-full max-w-md border border-border rounded-md"
      data-summary-root="true"
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <HeaderIcon className={headerIconClassName} />
        <span className="text-sm font-medium text-foreground">{headerClause}</span>
      </div>
      <SeverityGroup
        label="错误 / Errors"
        count={errorCount}
        paths={errors}
        severity="error"
      />
      <SeverityGroup
        label="警告 / Warnings"
        count={warningCount}
        paths={warningPaths}
        severity="warning"
      />
    </div>
  );
}
