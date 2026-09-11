import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { open } from "@tauri-apps/plugin-dialog";
import { useT, type MessageKey } from "@/lib/i18n";

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

type Field = "name" | "rootPath" | "projectDir" | "p4Client" | "p4User";

const FIELD_ERROR: Record<Field, MessageKey> = {
  name: "workspace.form.error.name",
  rootPath: "workspace.form.error.rootPath",
  projectDir: "workspace.form.error.projectDir",
  p4Client: "workspace.form.error.p4Client",
  p4User: "workspace.form.error.p4User",
};

type FormErrors = Partial<Record<Field, true>> & { submit?: string };

const coarseHit =
  "[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11";

export function WorkspaceForm({
  open: isOpen,
  onOpenChange,
  onSubmit,
}: WorkspaceFormProps) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [p4Client, setP4Client] = useState("");
  const [p4User, setP4User] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFolderPick = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setRootPath(selected);
    }
  };

  const handleSubmit = async () => {
    const newErrors: FormErrors = {};
    if (!name.trim()) newErrors.name = true;
    if (!rootPath.trim()) newErrors.rootPath = true;
    if (!projectDir.trim()) newErrors.projectDir = true;
    if (!p4Client.trim()) newErrors.p4Client = true;
    if (!p4User.trim()) newErrors.p4User = true;

    if (
      newErrors.name ||
      newErrors.rootPath ||
      newErrors.projectDir ||
      newErrors.p4Client ||
      newErrors.p4User
    ) {
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
      <DialogContent className="bg-popover border-border text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-section font-medium">
            {t("workspace.form.title")}
          </DialogTitle>
          <DialogDescription className="text-note">
            {t("workspace.form.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label htmlFor="workspace-name" className="mb-2 block text-note text-muted">
              {t("workspace.form.name")}
            </label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("workspace.form.namePlaceholder")}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "workspace-name-error" : undefined}
              className="border-border bg-well [overflow-wrap:anywhere]"
            />
            {errors.name && (
              <p id="workspace-name-error" className="mt-1 text-note text-destructive">
                {t(FIELD_ERROR.name)}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="workspace-root-path" className="mb-2 block text-note text-muted">
              {t("workspace.form.rootPath")}
            </label>
            <div className="flex flex-nowrap gap-2">
              <Input
                id="workspace-root-path"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder={t("workspace.form.rootPathPlaceholder")}
                aria-invalid={Boolean(errors.rootPath)}
                aria-describedby={errors.rootPath ? "workspace-root-path-error" : undefined}
                className="min-w-0 flex-1 border-border bg-well font-mono [overflow-wrap:anywhere]"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleFolderPick}
                className={`min-h-8 shrink-0 ${coarseHit}`}
              >
                {t("workspace.form.browse")}
              </Button>
            </div>
            {errors.rootPath && (
              <p id="workspace-root-path-error" className="mt-1 text-note text-destructive">
                {t(FIELD_ERROR.rootPath)}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="workspace-project-dir" className="mb-2 block text-note text-muted">
              {t("workspace.form.projectDir")}
            </label>
            <Input
              id="workspace-project-dir"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder={t("workspace.form.projectDirPlaceholder")}
              aria-invalid={Boolean(errors.projectDir)}
              aria-describedby={errors.projectDir ? "workspace-project-dir-help workspace-project-dir-error" : "workspace-project-dir-help"}
              className="border-border bg-well font-mono [overflow-wrap:anywhere]"
            />
            <p id="workspace-project-dir-help" className="mt-1 text-note text-muted-foreground">
              {t("workspace.form.projectDirHint")}
            </p>
            {errors.projectDir && (
              <p id="workspace-project-dir-error" className="mt-1 text-note text-destructive">
                {t(FIELD_ERROR.projectDir)}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4 narrow:grid-cols-1">
            <div>
              <label htmlFor="workspace-p4-client" className="mb-2 block text-note text-muted">
                {t("workspace.form.p4Client")}
              </label>
              <Input
                id="workspace-p4-client"
                value={p4Client}
                onChange={(e) => setP4Client(e.target.value)}
                placeholder={t("workspace.form.p4ClientPlaceholder")}
                aria-invalid={Boolean(errors.p4Client)}
                aria-describedby={errors.p4Client ? "workspace-p4-client-error" : undefined}
                className="border-border bg-well"
              />
              {errors.p4Client && (
                <p id="workspace-p4-client-error" className="mt-1 text-note text-destructive">
                  {t(FIELD_ERROR.p4Client)}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="workspace-p4-user" className="mb-2 block text-note text-muted">
                {t("workspace.form.p4User")}
              </label>
              <Input
                id="workspace-p4-user"
                value={p4User}
                onChange={(e) => setP4User(e.target.value)}
                placeholder={t("workspace.form.p4UserPlaceholder")}
                aria-invalid={Boolean(errors.p4User)}
                aria-describedby={errors.p4User ? "workspace-p4-user-error" : undefined}
                className="border-border bg-well"
              />
              {errors.p4User && (
                <p id="workspace-p4-user-error" className="mt-1 text-note text-destructive">
                  {t(FIELD_ERROR.p4User)}
                </p>
              )}
            </div>
          </div>
          {errors.submit && (
            <p className="text-note text-destructive">{errors.submit}</p>
          )}
        </div>
        <DialogFooter className="sticky bottom-0 border-t border-border bg-popover pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className={coarseHit}
          >
            {t("workspace.form.dismiss")}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className={`bg-primary text-primary-foreground hover:bg-primary/90 ${coarseHit}`}
          >
            {t("workspace.form.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
