import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogViewer } from "./LogViewer";
import { useWorkspaceHealth } from "@/hooks/useWorkspaceHealth";
import type { WorkspaceHealthCategory } from "@/lib/types";

/**
 * quick-260713-s44: Read-only workspace-health audit panel. Surfaces ALL files
 * with abnormal p4 status in the FYGame Config/Source/.uproject whitelist,
 * grouped into 4 categories (unmapped / missing-on-disk / not-in-depot / differs).
 *
 * On-demand: the user clicks "检查 / Audit" — NEVER automatic (decoupled from
 * the sync flow). Read-only v1 — NO sync/add/fix actions (per CONTEXT D-ux).
 * Long path lists render via the existing LogViewer (react-virtuoso).
 *
 * The motivating case: FYGame.uproject stranded after a p4 stream switch shows
 * in the "unmapped / 未映射" category (detected via `p4 where`, NOT reconcile).
 */
interface WorkspaceHealthPanelProps {
  workspaceId: string | null;
}

// Fixed category display order (matches WorkspaceHealthCategory::ALL on the
// Rust side): unmapped (the motivating case) first, then the 3 reconcile cats.
const CATEGORY_LABELS: { category: WorkspaceHealthCategory; label: string }[] = [
  { category: "unmapped", label: "未映射 / Unmapped" },
  { category: "missing-on-disk", label: "磁盘缺失 / Missing on disk" },
  { category: "not-in-depot", label: "未入库 / Not in depot" },
  { category: "differs", label: "已修改 / Differs" },
];

function CategorySection({
  label,
  count,
  paths,
  defaultExpanded,
}: {
  label: string;
  count: number;
  paths: string[];
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-accent/40"
      >
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <Badge variant="secondary" className="text-xs">
            {count}
          </Badge>
        </span>
        <span className="text-xs text-muted">{expanded ? "收起 ▲" : "展开 ▼"}</span>
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

export function WorkspaceHealthPanel({ workspaceId }: WorkspaceHealthPanelProps) {
  const { report, loading, error, runAudit, reset } = useWorkspaceHealth();

  const canAudit = workspaceId !== null && !loading;

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            工作区健康 / Workspace Health
          </h3>
          {report?.stream && (
            <span className="text-xs text-muted">
              当前 Stream: {report.stream}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3"
              onClick={() => workspaceId && runAudit(workspaceId)}
              disabled={!canAudit}
            >
              重试 / Retry
            </Button>
          )}
          <Button
            onClick={() => workspaceId && runAudit(workspaceId)}
            disabled={!canAudit}
            className="h-8 px-3"
          >
            {loading ? "检查中…" : "检查 / Audit"}
          </Button>
        </div>
      </div>

      {/* Body */}
      {error ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <p className="text-sm text-destructive">{error}</p>
          <p className="mt-2 text-xs text-muted">
            点击「重试 / Retry」重新检查。
          </p>
        </div>
      ) : report ? (
        <div className="flex-1 overflow-auto">
          {CATEGORY_LABELS.map(({ category, label }) => {
            const group = report.categories.find((g) => g.category === category);
            const paths = group?.paths ?? [];
            const count = group?.count ?? 0;
            return (
              <CategorySection
                key={category}
                label={label}
                count={count}
                paths={paths}
                defaultExpanded={count > 0}
              />
            );
          })}
          <div className="px-4 py-2 text-xs text-muted border-t border-border">
            只读报告 — v1 不提供修复操作
          </div>
        </div>
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted">检查中…</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center">
          <p className="text-sm text-muted">
            点击「检查」开始扫描工作区文件状态。
          </p>
        </div>
      )}

      {/* Hidden reset hook for future use (clears report when switching workspaces) */}
      {report && !loading && (
        <button
          type="button"
          onClick={reset}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
      )}
    </div>
  );
}
