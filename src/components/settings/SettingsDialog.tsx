import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, AlertTriangle } from "lucide-react";
import type { WorkspaceConfig } from "@/lib/types";
import * as commands from "@/lib/commands";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: WorkspaceConfig | null;
  onSave: (
    id: string,
    parallelThreads: number,
    exclusions: string[],
    intervalMinutes: number,
  ) => Promise<void>;
}

export function SettingsDialog({
  open,
  onOpenChange,
  workspace,
  onSave,
}: SettingsDialogProps) {
  const [threadCount, setThreadCount] = useState(
    () => workspace?.parallelThreads ?? 4,
  );
  const [exclusions, setExclusions] = useState<string[]>(
    () => [...(workspace?.exclusions ?? [])],
  );
  const [intervalMinutes, setIntervalMinutes] = useState(
    () => workspace?.intervalMinutes ?? 60,
  );
  const [newExclusion, setNewExclusion] = useState("");
  const [exclusionError, setExclusionError] = useState<string | null>(null);
  const [nonexistentPaths, setNonexistentPaths] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [mountedWorkspaceId, setMountedWorkspaceId] = useState(
    () => workspace?.id ?? null,
  );

  // Re-initialize when workspace changes or dialog reopens
  useEffect(() => {
    if (workspace && workspace.id !== mountedWorkspaceId) {
      setThreadCount(workspace.parallelThreads ?? 4);
      setExclusions([...(workspace.exclusions ?? [])]);
      setIntervalMinutes(workspace.intervalMinutes ?? 60);
      setMountedWorkspaceId(workspace.id);
      setNonexistentPaths([]);
    }
  }, [workspace, mountedWorkspaceId]);

  // Check existence of all exclusion paths whenever they change
  useEffect(() => {
    if (!workspace || exclusions.length === 0) {
      setNonexistentPaths([]);
      return;
    }
    let cancelled = false;
    commands.validateExclusions(workspace.rootPath, workspace.projectDir, exclusions).then((missing) => {
      if (!cancelled) setNonexistentPaths(missing);
    }).catch(() => {
      if (!cancelled) setNonexistentPaths([]);
    });
    return () => { cancelled = true; };
  }, [workspace, exclusions]);

  const handleAddExclusion = () => {
    const trimmed = newExclusion.trim();
    if (!trimmed) {
      setExclusionError("Path cannot be empty");
      return;
    }
    if (trimmed.includes("..")) {
      setExclusionError("Invalid path");
      return;
    }
    if (exclusions.includes(trimmed)) {
      setExclusionError("Path already exists");
      return;
    }
    setExclusions((prev) => [...prev, trimmed]);
    setNewExclusion("");
    setExclusionError(null);
  };

  const handleRemoveExclusion = (path: string) => {
    setExclusions((prev) => prev.filter((e) => e !== path));
  };

  const handleSave = async () => {
    if (!workspace) return;
    setIsSaving(true);
    try {
      await onSave(workspace.id, threadCount, exclusions, intervalMinutes);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  if (!workspace) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[hsl(0,0%,14%)] border-border text-foreground">
        <DialogHeader>
          <DialogTitle>Workspace Settings</DialogTitle>
          <DialogDescription>
            Configure sync options for {workspace.name}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm text-muted mb-1 block">
              Parallel Threads
            </label>
            <Input
              type="number"
              min={1}
              max={16}
              value={threadCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v)) {
                  setThreadCount(Math.max(1, Math.min(16, v)));
                }
              }}
              className="bg-[hsl(0,0%,9%)] border-border"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Set to 1 to disable parallel sync
            </p>
          </div>

          <div>
            <label className="text-sm text-muted mb-1 block">
              Behind-check interval (minutes)
            </label>
            <Input
              type="number"
              min={5}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v)) {
                  setIntervalMinutes(Math.max(5, Math.min(1440, v)));
                }
              }}
              className="bg-[hsl(0,0%,9%)] border-border"
            />
            <p className="text-xs text-muted-foreground mt-1">
              How often the idle view checks Perforce for pending files
            </p>
          </div>

          <div>
            <label className="text-sm text-muted mb-1 block">
              Excluded Paths
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              Paths relative to {workspace?.projectDir ?? "the project"}/
            </p>
            <div className="flex flex-wrap gap-2 mb-2">
              {exclusions.map((ex) => {
                const isMissing = nonexistentPaths.includes(ex);
                return (
                  <Badge
                    key={ex}
                    variant={isMissing ? "outline" : "secondary"}
                    className={`gap-1 cursor-default ${isMissing ? "border-amber-500/50 text-amber-400" : ""}`}
                  >
                    {isMissing && <AlertTriangle className="h-3 w-3" />}
                    {ex}
                    <button
                      type="button"
                      onClick={() => handleRemoveExclusion(ex)}
                      className="inline-flex items-center hover:text-foreground"
                      aria-label={`Remove ${ex}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
            <div className="flex gap-2">
              <Input
                value={newExclusion}
                onChange={(e) => {
                  setNewExclusion(e.target.value);
                  setExclusionError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddExclusion();
                  }
                }}
                placeholder="Add path..."
                className="bg-[hsl(0,0%,9%)] border-border"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddExclusion}
                className="shrink-0"
              >
                Add
              </Button>
            </div>
            {exclusionError && (
              <p className="text-xs text-destructive mt-1">{exclusionError}</p>
            )}
            {nonexistentPaths.length > 0 && !exclusionError && (
              <p className="text-xs text-amber-400 mt-1 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Path{nonexistentPaths.length > 1 ? "s" : ""} not found: {nonexistentPaths.join(", ")}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving}
            className="bg-accent text-accent-foreground hover:bg-accent/90"
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
