import type { WorkspaceConfig } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { WorkspaceList } from "@/components/workspace/WorkspaceList";
import { WorkspaceForm } from "@/components/workspace/WorkspaceForm";
import { Plus, Settings } from "lucide-react";
import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { changelog } from "virtual:changelog";

/** Parse conventional commit subject into type, scope, description */
function parseSubject(subject: string) {
  const match = subject.match(/^(\w+)(\([^)]*\))?:\s*(.*)/);
  if (!match) return { type: "", scope: "", desc: subject };
  return { type: match[1], scope: match[2] || "", desc: match[3] };
}

const TYPE_COLORS: Record<string, string> = {
  fix: "text-emerald-400",
  feat: "text-sky-400",
  docs: "text-amber-300",
  chore: "text-muted-foreground",
  refactor: "text-violet-400",
  perf: "text-orange-400",
  test: "text-teal-400",
};

function CommitSubject({ subject }: { subject: string }) {
  const { type, scope, desc } = parseSubject(subject);
  if (!type) {
    return <span className="text-foreground/80">{subject}</span>;
  }
  return (
    <span className="text-foreground/80">
      <span className={TYPE_COLORS[type] || "text-foreground/80"}>{type}</span>
      {scope && (
        <span className="text-muted-foreground">{scope}</span>
      )}
      <span>: {desc}</span>
    </span>
  );
}

interface SidebarProps {
  workspaces: WorkspaceConfig[];
  selectedId: string | null;
  currentCl: string | null;
  isBusy: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: (
    name: string,
    rootPath: string,
    projectDir: string,
    p4Client: string,
    p4User: string,
  ) => Promise<void>;
  onOpenSettings: () => void;
  isSettingsDisabled: boolean;
}

export function Sidebar({
  workspaces,
  selectedId,
  currentCl,
  isBusy,
  onSelect,
  onDelete,
  onAdd,
  onOpenSettings,
  isSettingsDisabled,
}: SidebarProps) {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then((v) => setAppVersion(v));
  }, []);

  const currentCls: Record<string, string | null> = {};
  if (selectedId && currentCl !== null) {
    currentCls[selectedId] = currentCl;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h1 className="text-[20px] font-semibold text-foreground">
          Simple UnrealGameSync
        </h1>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            className="h-8 w-8 text-muted hover:text-foreground"
            disabled={isSettingsDisabled}
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Add workspace"
            className="h-8 w-8 text-muted hover:text-foreground"
            disabled={isBusy}
            onClick={() => setIsFormOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <WorkspaceList
          workspaces={workspaces}
          currentCls={currentCls}
          selectedId={selectedId}
          isBusy={isBusy}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      </div>

      <div className="px-4 py-2 border-t border-border">
        <Dialog>
          <DialogTrigger asChild>
            <button className="text-xs text-muted hover:text-foreground transition-colors cursor-pointer">
              v{appVersion}
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-lg bg-[hsl(0,0%,14%)] border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="text-foreground">v{appVersion} Changelog</DialogTitle>
            </DialogHeader>
            <div className="text-xs space-y-0.5 max-h-[60vh] overflow-y-auto">
              {changelog.length === 0 ? (
                <p className="text-muted-foreground py-2">No git history available</p>
              ) : (
                changelog.map((commit) => (
                  <div key={commit.hash} className="flex gap-2 items-baseline py-[2px]">
                    <code className="text-muted-foreground font-mono shrink-0 w-[52px]">
                      {commit.hash}
                    </code>
                    <span className="text-muted-foreground shrink-0 w-[72px]">
                      {commit.date}
                    </span>
                    <CommitSubject subject={commit.subject} />
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <WorkspaceForm
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
        onSubmit={onAdd}
      />
    </div>
  );
}
