import type { WorkspaceConfig } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { FolderOpen, Trash2 } from "lucide-react";

interface WorkspaceItemProps {
  workspace: WorkspaceConfig;
  currentCl: string | null;
  isSelected: boolean;
  isBusy: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function WorkspaceItem({
  workspace,
  currentCl,
  isSelected,
  isBusy,
  onSelect,
  onDelete,
}: WorkspaceItemProps) {
  const { t } = useT();
  return (
    <div
      className={`group flex min-w-0 items-center rounded-lg border-l-4 transition-colors ${
        isSelected
          ? "border-primary bg-accent"
          : "border-transparent hover:bg-well"
      }`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden px-2 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed narrow:flex-row narrow:items-center narrow:py-2"
            disabled={isBusy}
            aria-pressed={isSelected}
            onClick={onSelect}
          >
            <div className="flex min-w-0 w-full items-center gap-2">
              <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {workspace.name}
              </span>
              <span className="shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="shrink-0 whitespace-nowrap px-2 py-0 text-xs font-normal"
                      onPointerEnter={(e) => e.stopPropagation()}
                      onPointerLeave={(e) => e.stopPropagation()}
                    >
                      {currentCl ? t("workspace.item.clBadge", { cl: currentCl }) : "--"}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    <p>{currentCl ? t("workspace.item.lastSynced", { cl: currentCl }) : t("workspace.item.neverSynced")}</p>
                  </TooltipContent>
                </Tooltip>
              </span>
            </div>
            <span className="truncate font-mono text-xs text-muted narrow:hidden">
              {workspace.rootPath}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{workspace.rootPath}</p>
        </TooltipContent>
      </Tooltip>
      {!isBusy && (
        <button
          type="button"
          className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={t("workspace.item.deleteAria", { name: workspace.name })}
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
