import { GitBranch, ChevronDown } from "lucide-react";
import type { GitBranchInfo, WorkspaceConfig } from "@/lib/types";
import { useT } from "@/lib/i18n";

export interface WorkspaceHeaderProps {
  selectedWorkspace: WorkspaceConfig | null;
  stream: string | null;
  p4Client: string | null;
  gitBranchInfo: GitBranchInfo | null;
  gitBranchLoading: boolean;
}

export function WorkspaceHeader({
  selectedWorkspace,
  stream,
  p4Client,
  gitBranchInfo,
  gitBranchLoading,
}: WorkspaceHeaderProps) {
  const { t } = useT();

  if (!selectedWorkspace) {
    return null;
  }

  const gitIdentity = gitBranchLoading
    ? t("sync.dash.gitChecking")
    : gitBranchInfo?.branch
      ? `${gitBranchInfo.is_detached ? t("sync.dash.gitDetached") : gitBranchInfo.branch}${gitBranchInfo.short_hash ? ` · ${gitBranchInfo.short_hash}` : ""}`
      : t("sync.dash.gitUnavailable");

  return (
    <header className="shrink-0 min-w-0 px-4 py-4 medium:px-6">
      <p className="text-xs text-muted-foreground">
        {t("workspace.header.current")}
      </p>
      <h1 className="mt-1 overflow-wrap-anywhere text-[22px] font-medium tracking-tight text-foreground medium:text-xl">
        {selectedWorkspace.name}
      </h1>
      <p className="mt-1 min-w-0 break-all whitespace-normal font-mono text-xs text-muted-foreground">
        {selectedWorkspace.rootPath}
      </p>
      <details className="mt-2 min-w-0">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform [[open]_&]:rotate-180" />
          {t("workspace.header.showMetadata")}
        </summary>
        <dl className="mt-2 grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("sync.dash.stream")}</dt>
          <dd className="break-all whitespace-normal font-mono text-foreground">
            {stream ?? t("sync.dash.classicClient")}
          </dd>
          <dt className="text-muted-foreground">{t("sync.dash.p4Client")}</dt>
          <dd className="min-w-0 truncate font-mono text-foreground" title={p4Client ?? undefined}>
            {p4Client ?? "—"}
          </dd>
          <dt className="text-muted-foreground">{t("sync.dash.git")}</dt>
          <dd className="min-w-0 break-all font-mono text-foreground">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-4 w-4 shrink-0" />
              {gitIdentity}
            </span>
            {!gitBranchLoading && !gitBranchInfo?.branch && (
              <p className="mt-1 font-sans text-xs text-muted-foreground">
                {t("workspace.header.gitUnavailableHelp")}
              </p>
            )}
          </dd>
        </dl>
      </details>
    </header>
  );
}
