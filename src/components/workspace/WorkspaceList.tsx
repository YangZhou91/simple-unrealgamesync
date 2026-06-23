import type { WorkspaceConfig } from "@/lib/types";
import { WorkspaceItem } from "./WorkspaceItem";
import { ScrollArea } from "@/components/ui/scroll-area";

interface WorkspaceListProps {
  workspaces: WorkspaceConfig[];
  currentCls: Record<string, string | null>;
  selectedId: string | null;
  isBusy: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function WorkspaceList({
  workspaces,
  currentCls,
  selectedId,
  isBusy,
  onSelect,
  onDelete,
}: WorkspaceListProps) {
  if (workspaces.length === 0) {
    return null;
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col py-1">
        {workspaces.map((ws) => (
          <WorkspaceItem
            key={ws.id}
            workspace={ws}
            currentCl={currentCls[ws.id] ?? null}
            isSelected={ws.id === selectedId}
            isBusy={isBusy}
            onSelect={() => onSelect(ws.id)}
            onDelete={() => onDelete(ws.id)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
