import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useT } from "@/lib/i18n";

interface WorkspaceEmptyStateProps {
  onAdd: () => void;
}

export function WorkspaceEmptyState({ onAdd }: WorkspaceEmptyStateProps) {
  const { t } = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-12">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h2 className="text-xl font-medium text-foreground">
          {t("workspace.empty.title")}
        </h2>
        <p className="max-w-xs text-sm text-muted-foreground">
          {t("workspace.form.description")}
        </p>
        <Button
          onClick={onAdd}
          className="mt-2 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t("workspace.empty.add")}
        </Button>
      </div>
    </div>
  );
}
