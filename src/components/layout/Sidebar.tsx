import type { WorkspaceConfig } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { WorkspaceList } from "@/components/workspace/WorkspaceList";
import { WorkspaceForm } from "@/components/workspace/WorkspaceForm";
import { Database, Layers, Plus, RefreshCw, Settings } from "lucide-react";
import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { changelog } from "virtual:changelog";
import type { UpdaterInfo } from "@/hooks/useUpdater";
import { useT } from "@/lib/i18n";

/** Parse conventional commit subject into type, scope, description */
function parseSubject(subject: string) {
  const match = subject.match(/^(\w+)(\([^)]*\))?:\s*(.*)/);
  if (!match) return { type: "", scope: "", desc: subject };
  return { type: match[1], scope: match[2] || "", desc: match[3] };
}

const TYPE_COLORS: Record<string, string> = {
  fix: "text-success",
  feat: "text-info",
  docs: "text-warning",
  chore: "text-muted-foreground",
  refactor: "text-primary",
  perf: "text-warning",
  test: "text-muted-foreground",
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
  updaterInfo: UpdaterInfo;
  onCheckUpdate: () => void;
  isFormOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
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
  updaterInfo,
  onCheckUpdate,
  isFormOpen,
  onFormOpenChange,
}: SidebarProps) {
  const { t } = useT();
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then((v) => setAppVersion(v));
  }, []);

  const currentCls: Record<string, string | null> = {};
  if (selectedId && currentCl !== null) {
    currentCls[selectedId] = currentCl;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex items-center gap-2 border-b border-border p-4 narrow:hidden">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-success">
          <Layers className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">
            Simple UGS
          </h1>
          <p className="text-xs text-muted-foreground">{t("workspace.sidebar.tagline")}</p>
        </div>
      </div>

      {/* 24-03: side-heading compact row at <=620 (canonical
          .uc-side-heading: display:flex; padding:0 1px 7px).
          29-02 (PAR-01, UI-SPEC §7.1 rung 1→2): en "Workspaces" + "Add
          Workspace" sum 244px > the 195px content width of the 228px aside,
          so opening the Add-Workspace dialog auto-scrolled the aside left
          (scrollLeft 33 — the add-workspace-dark-1056-en offender). The span
          host gets min-w-0 (rung 1) and the row wraps (rung 2 — the default
          en answer, SettingsDialog scope-tabs recipe): the Add button takes
          a second line under the label. zh (165px) never wraps — layout
          byte-identical. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-4 narrow:px-4 narrow:py-2">
        <span className="min-w-0 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {t("workspace.sidebar.title")}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 px-2 text-sm"
          disabled={isBusy}
          onClick={() => onFormOpenChange(true)}
        >
          <Plus className="h-3 w-3" />
          {t("workspace.sidebar.add")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2">
        <WorkspaceList
          workspaces={workspaces}
          currentCls={currentCls}
          selectedId={selectedId}
          isBusy={isBusy}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      </div>

      {/* 24-03: footer compact row at <=620 (canonical .uc-side-footer:
          display:flex; align-items:center; justify-content:space-between;
          gap:8px; flex-wrap:wrap; margin-top:10px; no border). Chrome-only —
          control content is Phase 25. */}
      <div className="mt-auto border-t border-border px-4 pb-0 pt-4 narrow:flex narrow:items-center narrow:justify-between narrow:gap-2 narrow:flex-wrap narrow:mt-2 narrow:border-t-0 narrow:px-4 narrow:py-2">
        <Button
          variant="ghost"
          aria-label={t("workspace.sidebar.settingsAria")}
          className="inline-flex h-8 gap-2 px-2 text-sm text-muted hover:text-foreground narrow:hidden"
          disabled={isSettingsDisabled}
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
          {t("workspace.sidebar.settingsAria")}
        </Button>
        <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground narrow:mb-0">
          <span className="flex items-center gap-1.5">
            <Database className="h-3 w-3" />
            {t("workspace.sidebar.perforceReady")}
          </span>
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-label={t("workspace.sidebar.connectedAria")} />
        </div>
        <div className="flex items-center justify-between gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("workspace.sidebar.settingsAria")}
            className="hidden h-8 w-8 text-muted hover:text-foreground narrow:inline-flex"
            disabled={isSettingsDisabled}
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <button className="min-w-0 text-xs text-muted hover:text-foreground transition-colors cursor-pointer">
                v{appVersion}
              </button>
            </DialogTrigger>
            <DialogContent className="max-w-lg bg-popover border-border text-foreground">
              <DialogHeader>
                <DialogTitle className="text-foreground">
                  {t("layout.changelog.title", { version: appVersion })}
                </DialogTitle>
                <DialogDescription>{t("layout.changelog.description")}</DialogDescription>
              </DialogHeader>
              <div className="text-xs space-y-0.5 max-h-[60vh] overflow-y-auto">
                {changelog.length === 0 ? (
                  <p className="text-muted-foreground py-2">{t("layout.changelog.empty")}</p>
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

          {/* Update button / badge */}
          {updaterInfo.state === "available" ? (
            <button
              onClick={onCheckUpdate}
              className="flex shrink-0 items-center gap-1 text-xs text-info hover:text-info/80 transition-colors cursor-pointer"
              title={t("layout.updater.availableTitle", { version: updaterInfo.version ?? "" })}
            >
              <RefreshCw className="h-3 w-3" />
              v{updaterInfo.version}
            </button>
          ) : updaterInfo.state === "downloading" ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <RefreshCw className="h-3 w-3 animate-spin" />
              {updaterInfo.totalBytes
                ? `${Math.round((updaterInfo.downloadedBytes / updaterInfo.totalBytes) * 100)}%`
                : "…"}
            </span>
          ) : updaterInfo.state === "checking" ? (
            <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            <button
              onClick={onCheckUpdate}
              className="shrink-0 text-muted hover:text-foreground transition-colors cursor-pointer"
              title={t("layout.updater.checkAria")}
              aria-label={t("layout.updater.checkAria")}
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <WorkspaceForm
        open={isFormOpen}
        onOpenChange={onFormOpenChange}
        onSubmit={onAdd}
      />
    </div>
  );
}
