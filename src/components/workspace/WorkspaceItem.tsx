import type { WorkspaceConfig } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Trash2 } from "lucide-react";

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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`group flex flex-col gap-0.5 px-4 py-2 cursor-pointer transition-colors ${
            isSelected
              ? "bg-[hsl(0,0%,18%)] border-l-2 border-accent"
              : "hover:bg-[hsl(0,0%,17%)] border-l-2 border-transparent"
          }`}
          onClick={isBusy ? undefined : onSelect}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground truncate">
              {workspace.name}
            </span>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="text-xs px-1.5 py-0"
                    onPointerEnter={(e) => e.stopPropagation()}
                    onPointerLeave={(e) => e.stopPropagation()}
                  >
                    {currentCl ?? "--"}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  <p>{currentCl ? `Last synced: CL #${currentCl}` : "Never synced"}</p>
                </TooltipContent>
              </Tooltip>
              {!isBusy && (
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded hover:bg-destructive/20 text-muted hover:text-destructive"
                  aria-label="Delete workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <span className="text-xs text-muted truncate">
            {workspace.rootPath}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{workspace.rootPath}</p>
      </TooltipContent>
    </Tooltip>
  );
}
