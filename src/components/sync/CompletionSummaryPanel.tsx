import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, AlertCircle } from "lucide-react";
import { groupWarnings } from "@/lib/groupWarnings";
import type { WarningEntry } from "@/lib/types";
import { useT } from "@/lib/i18n";

/**
 * Phase 14 (SUMM-21..23) — completion summary panel rendered inline in
 * IdlePanel directly below the `lastSyncResult` line. Surfaces the warnings
 * aggregated by Phase 13 (`SyncCompleted.warnings: WarningEntry[]`) as a
 * severity-grouped, expandable path list.
 *
 * Phase 20 (SWEEP-04 tracer): all chrome renders from the dictionary via
 * `useT()`. Header uses one of three `sync.summary.header.*` templates with
 * zero-count clauses dropped (D-02/D-07 — never one stuffed string); group
 * labels are the single-language `sync.summary.errors` / `sync.summary.warnings`
 * values (slash compounds are two dictionary values, never one bilingual key);
 * expand/collapse and the empty-group body reuse the shared `common.*` keys
 * consumed by WorkspaceHealthPanel as well.
 *
 * Phase 26 (26-01 Task 2) — restyled into the result card's separated warning
 * region (1px border-t provided by IdlePanel): the panel fills the result-card
 * width (min-w-0, no shrink-to-fit w-fit/max-w-[90vw]) and raw paths wrap in
 * place (break-all) inside the bounded max-height scroll area instead of
 * whitespace-nowrap overflow.
 *
 * Silent gate (D-11 / SC#2): when `warnings.length === 0` the component
 * returns `null` — IdlePanel is byte-identical to today when a sync is silent.
 *
 * Paths render raw for local diagnosis (BND-01);
 * no copy/export affordance in v1 (SUMM-F01 deferred).
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
  const { t } = useT();

  // D-03 verbatim reuse of WorkspaceHealthPanel.tsx:137
  // `defaultExpanded={count > 0}` — the group starts EXPANDED when it has
  // paths, COLLAPSED when empty. The count argument there is the number of
  // distinct paths in the category; here `paths.length` plays the same role.
  const [expanded, setExpanded] = useState(paths.length > 0);

  // D-08 palette — red for errors, amber for warnings. Applied to the Badge
  // so the severity color is visible at-a-glance alongside the count. The
  // expanded/collapsed state itself is conveyed by the common.expand /
  // common.collapse text, never by hue alone.
  const badgeClassName =
    severity === "error"
      ? "bg-destructive-surface text-destructive"
      : "bg-warning-surface text-warning";

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 px-0 py-2 text-left hover:bg-accent/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <Badge variant="secondary" className={`text-xs ${badgeClassName}`}>
            {count}
          </Badge>
        </span>
        <span className="shrink-0 text-xs text-muted">
          {expanded ? t("common.collapse") : t("common.expand")}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border">
          {paths.length === 0 ? (
            <div className="py-3 text-center text-xs text-muted">
              {t("common.none")}
            </div>
          ) : (
            <div className="max-h-40 overflow-y-auto py-1">
              {paths.map((p, i) => (
                <div
                  key={i}
                  className="min-w-0 break-all px-0 py-1 font-mono text-xs text-muted"
                >
                  {p}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CompletionSummaryPanel({ warnings }: CompletionSummaryPanelProps) {
  const { t } = useT();

  // D-11 silent gate — load-bearing. Returns null before the root element
  // renders, so IdlePanel is byte-identical to today when a sync is silent.
  // Test 1 asserts this via the `data-summary-root` hook.
  if (warnings.length === 0) return null;

  const { errors, warnings: warningPaths } = groupWarnings(warnings);

  // Distinct-path counts per severity (drives both the header wording and the
  // per-group Badge semantics — matches WorkspaceHealthPanel's `Badge {count}`
  // = number of paths in the category, per CONTEXT D-08 recommendation).
  const errorCount = warnings.filter((w) => w.severity === "error").length;
  const warningCount = warnings.filter((w) => w.severity === "warning").length;

  // D-07/D-02 header wording — one of three templates with the zero-count
  // clause(s) dropped; never one stuffed string. Both-zero is impossible here
  // (the D-11 gate already returned on empty input), but the conditionals are
  // written symmetrically for clarity. Same branch order as Phase 14:
  // errorCount === 0 → warnings-only; warningCount === 0 → errors-only; else both.
  const headerClause =
    errorCount === 0
      ? t("sync.summary.header.warnings", { warns: warningCount })
      : warningCount === 0
        ? t("sync.summary.header.errors", { errors: errorCount })
        : t("sync.summary.header.both", {
            warns: warningCount,
            errors: errorCount,
          });

  // D-09 header escalates by error presence — red icon when errors exist,
  // amber when warnings-only. Mirrors the "any errors = red, else amber"
  // severity logic called out in the CONTEXT.
  const hasErrors = errorCount > 0;
  const HeaderIcon = hasErrors ? AlertCircle : AlertTriangle;
  const headerIconClassName = hasErrors
    ? "h-4 w-4 text-destructive"
    : "h-4 w-4 text-warning";

  return (
    <div className="min-w-0" data-summary-root="true">
      <div className="flex min-w-0 items-center gap-2 border-b border-border pb-2">
        <HeaderIcon className={headerIconClassName} />
        <span className="text-xs font-medium text-foreground">{headerClause}</span>
      </div>
      <SeverityGroup
        label={t("sync.summary.errors")}
        count={errorCount}
        paths={errors}
        severity="error"
      />
      <SeverityGroup
        label={t("sync.summary.warnings")}
        count={warningCount}
        paths={warningPaths}
        severity="warning"
      />
    </div>
  );
}
