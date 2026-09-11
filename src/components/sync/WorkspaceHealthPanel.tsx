import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LogViewer } from "./LogViewer";
import { useWorkspaceHealth } from "@/hooks/useWorkspaceHealth";
import { useT, type MessageKey } from "@/lib/i18n";
import type { WorkspaceHealthCategory } from "@/lib/types";
import { ScanLine, ShieldCheck } from "lucide-react";

/**
 * HIST-02 / D-07 / D-08: Read-only workspace-health audit panel. Surfaces ALL
 * files with abnormal p4 status in the ExampleGame Config/Source/.uproject
 * whitelist, grouped into 5 categories (unmapped / missing-on-disk /
 * not-in-depot / differs / needs-resolve).
 *
 * On-demand: the user clicks Audit — NEVER automatic (decoupled from
 * the sync flow). Read-only v1 — NO sync/add/fix actions (per CONTEXT D-ux).
 * Long path lists render via the existing LogViewer (react-virtuoso).
 *
 * The motivating case: ExampleGame.uproject stranded after a p4 stream switch shows
 * in the unmapped category (detected via `p4 where`, NOT reconcile).
 * The 5th "needs-resolve" category surfaces files left in a conflict-pending
 * state after a sync (detected via `p4 resolve -n`) — the most actionable
 * blocker state.
 *
 * Phase 20: all chrome renders from the dictionary via t(). The wire ids keep
 * their hyphens; CATEGORY_KEYS maps them to camelCase dictionary keys and is
 * looked up at render — no dynamic `sync.health.${id}` template key. Paths,
 * the stream name, and the error payload stay raw (BND-01).
 *
 * Phase 27: generation-guard lives in useWorkspaceHealth(workspaceId);
 * this panel passes workspaceId, uses canonical section-head chrome, and
 * groups categories with native details/summary. No hidden reset control.
 */
interface WorkspaceHealthPanelProps {
  workspaceId: string | null;
}

// Fixed category display order (matches WorkspaceHealthCategory::ALL on the
// Rust side): unmapped (the motivating case) first, then the 3 reconcile cats,
// then needs-resolve (the resolve-detected blocker) LAST.
const CATEGORY_ORDER: WorkspaceHealthCategory[] = [
  "unmapped",
  "missing-on-disk",
  "not-in-depot",
  "differs",
  "needs-resolve",
];

// Typed Record — compile-time guarantee every wire id resolves to a MessageKey.
// Wire ids keep hyphens; dictionary keys are camelCase after sync.health.
const CATEGORY_KEYS: Record<WorkspaceHealthCategory, MessageKey> = {
  unmapped: "sync.health.unmapped",
  "missing-on-disk": "sync.health.missingOnDisk",
  "not-in-depot": "sync.health.notInDepot",
  differs: "sync.health.differs",
  "needs-resolve": "sync.health.needsResolve",
};

function CategorySection({
  category,
  count,
  paths,
}: {
  category: WorkspaceHealthCategory;
  count: number;
  paths: string[];
}) {
  const { t } = useT();
  const [open, setOpen] = useState(count > 0);
  const isNeedsResolve = category === "needs-resolve";
  const labelClass = isNeedsResolve ? "text-destructive" : "text-foreground";
  const countClass = isNeedsResolve
    ? "tabular-nums text-destructive"
    : "tabular-nums text-muted";

  return (
    <details className="min-w-0 border-b border-border" open={open}>
      <summary
        className="flex cursor-pointer items-center justify-between gap-2 px-2 py-2 text-sm hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <span className={labelClass}>{t(CATEGORY_KEYS[category])}</span>
        <span className={countClass}>{count}</span>
      </summary>
      {open &&
        (count === 0 ? (
          <div className="flex items-center justify-center py-4 text-sm text-muted">
            {t("common.none")}
          </div>
        ) : (
          <div className="flex h-40 flex-col">
            <LogViewer lines={paths} />
          </div>
        ))}
    </details>
  );
}

export function WorkspaceHealthPanel({ workspaceId }: WorkspaceHealthPanelProps) {
  const { report, loading, error, runAudit } = useWorkspaceHealth(workspaceId);
  const { t } = useT();

  const canAudit = workspaceId !== null && !loading;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 pb-4">
        <div className="min-w-0">
          <h2 className="text-section">{t("sync.health.title")}</h2>
          <p className="mt-1 text-note text-muted">{t("sync.health.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {error && (
            <Button
              variant="outline"
              onClick={() => workspaceId && runAudit(workspaceId)}
              disabled={!canAudit}
              className="h-9 shrink-0 px-3"
            >
              {t("sync.health.retry")}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => workspaceId && runAudit(workspaceId)}
            disabled={!canAudit}
            className="h-9 shrink-0 px-3"
          >
            <ScanLine className="h-4 w-4" aria-hidden="true" />
            {loading ? t("sync.health.auditing") : t("sync.health.audit")}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <p className="text-note text-destructive">{error}</p>
          <p className="mt-2 text-note text-muted">{t("sync.health.retryHint")}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-note text-muted">{t("sync.health.auditing")}</p>
        </div>
      ) : report ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {report.stream ? (
            <p className="px-2 pb-2 font-mono text-note text-muted [overflow-wrap:anywhere]">
              {t("sync.health.stream", { stream: report.stream })}
            </p>
          ) : null}
          {CATEGORY_ORDER.map((category) => {
            const group = report.categories.find((g) => g.category === category);
            const paths = group?.paths ?? [];
            const count = group?.count ?? 0;
            return (
              <CategorySection
                key={category}
                category={category}
                count={count}
                paths={paths}
              />
            );
          })}
          <div className="border-t border-border px-2 py-2 text-caption text-muted">
            {t("sync.health.readonlyFooter")}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-12">
          <ShieldCheck className="h-4 w-4 text-muted" aria-hidden="true" />
          <p className="text-note text-muted">{t("sync.health.emptyHint")}</p>
        </div>
      )}
    </div>
  );
}
