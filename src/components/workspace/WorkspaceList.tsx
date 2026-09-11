import type { WorkspaceConfig } from "@/lib/types";
import { WorkspaceItem } from "./WorkspaceItem";

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
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto narrow:max-h-32">
      <div className="flex min-w-0 flex-col gap-1 pb-2">
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
    </div>
  );
}
