import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { open } from "@tauri-apps/plugin-dialog";

interface WorkspaceFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    name: string,
    rootPath: string,
    projectDir: string,
    p4Client: string,
    p4User: string,
  ) => Promise<void>;
}

export function WorkspaceForm({
  open: isOpen,
  onOpenChange,
  onSubmit,
}: WorkspaceFormProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [p4Client, setP4Client] = useState("");
  const [p4User, setP4User] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFolderPick = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setRootPath(selected);
    }
  };

  const handleSubmit = async () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Name is required";
    if (!rootPath.trim()) newErrors.rootPath = "Root path is required";
    if (!projectDir.trim()) newErrors.projectDir = "Project directory is required";
    if (!p4Client.trim()) newErrors.p4Client = "P4 client is required";
    if (!p4User.trim()) newErrors.p4User = "P4 user is required";

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(
        name.trim(),
        rootPath.trim(),
        projectDir.trim(),
        p4Client.trim(),
        p4User.trim(),
      );
      setName("");
      setRootPath("");
      setProjectDir("");
      setP4Client("");
      setP4User("");
      setErrors({});
      onOpenChange(false);
    } catch (e) {
      setErrors({ submit: String(e) });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[hsl(0,0%,14%)] border-border text-foreground">
        <DialogHeader>
          <DialogTitle>Add Workspace</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm text-muted mb-1 block">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Workspace"
              className="bg-[hsl(0,0%,9%)] border-border"
            />
            {errors.name && (
              <p className="text-xs text-destructive mt-1">{errors.name}</p>
            )}
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Root Path</label>
            <div className="flex gap-2">
              <Input
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="E:\UnrealProject"
                className="bg-[hsl(0,0%,9%)] border-border"
              />
              <Button
                variant="outline"
                onClick={handleFolderPick}
                className="shrink-0"
              >
                Browse
              </Button>
            </div>
            {errors.rootPath && (
              <p className="text-xs text-destructive mt-1">{errors.rootPath}</p>
            )}
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">
              Project Directory
            </label>
            <Input
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="MyGame"
              className="bg-[hsl(0,0%,9%)] border-border"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Game project subdirectory under the root path (e.g. the folder
              next to UnrealEngine/).
            </p>
            {errors.projectDir && (
              <p className="text-xs text-destructive mt-1">{errors.projectDir}</p>
            )}
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">P4 Client</label>
            <Input
              value={p4Client}
              onChange={(e) => setP4Client(e.target.value)}
              placeholder="my_client_name"
              className="bg-[hsl(0,0%,9%)] border-border"
            />
            {errors.p4Client && (
              <p className="text-xs text-destructive mt-1">{errors.p4Client}</p>
            )}
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">P4 User</label>
            <Input
              value={p4User}
              onChange={(e) => setP4User(e.target.value)}
              placeholder="username"
              className="bg-[hsl(0,0%,9%)] border-border"
            />
            {errors.p4User && (
              <p className="text-xs text-destructive mt-1">{errors.p4User}</p>
            )}
          </div>
          {errors.submit && (
            <p className="text-xs text-destructive">{errors.submit}</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="bg-accent text-accent-foreground hover:bg-accent/90"
            >
              Add Workspace
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
