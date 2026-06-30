import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Play, GitPullRequest, GitBranch, ArrowDown, Check, Loader2 } from "lucide-react";
import type { GitBranchInfo, P4BehindInfo } from "@/lib/types";

interface IdlePanelProps {
  lastSyncResult: {
    cl: string | null;
    fileCount: number;
    time: string;
  } | null;
  hasWorkspace: boolean;
  targetCl: string;
  onTargetClChange: (cl: string) => void;
  onStartSync: () => void;
  onGitPull: () => void;
  isBusy: boolean;
  gitBranchInfo: GitBranchInfo | null;
  gitBranchLoading: boolean;
  behindInfo: P4BehindInfo | null;
  behindLoading: boolean;
  // Optional with defaults so existing test fixtures (and any other caller)
  // keep type-checking — App.tsx always threads both. null stream renders the
  // pinned `classic client` placeholder; null p4Client renders an empty Client
  // value (App never lets that happen at runtime).
  stream?: string | null;
  p4Client?: string | null;
}

export function IdlePanel({
  lastSyncResult,
  hasWorkspace,
  targetCl,
  onTargetClChange,
  onStartSync,
  onGitPull,
  isBusy,
  gitBranchInfo,
  gitBranchLoading,
  behindInfo,
  behindLoading,
  stream = null,
  p4Client = null,
}: IdlePanelProps) {
  const [clError, setClError] = useState<string | null>(null);

  const handleClChange = (value: string) => {
    onTargetClChange(value);
    if (value.length > 0 && !/^\d+$/.test(value)) {
      setClError("CL must be a number");
    } else {
      setClError(null);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 pt-12">
      <div className="text-center space-y-0.5">
        <p className="text-xs text-muted-foreground">
          Stream:{" "}
          <span className="font-mono">
            {stream ?? "classic client"}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Client: <span className="font-mono">{p4Client}</span>
        </p>
      </div>
      {lastSyncResult ? (
        <div className="text-center space-y-2">
          <p className="text-sm text-foreground">
            Last synced: CL #{lastSyncResult.cl ?? "?"} &mdash;{" "}
            {lastSyncResult.time} &mdash; {lastSyncResult.fileCount} files
          </p>
        </div>
      ) : (
        <h2 className="text-xl font-semibold text-foreground">Ready to sync</h2>
      )}

      <div className="w-full max-w-xs">
        <label className="text-sm text-muted mb-1 block">
          Target CL (optional)
        </label>
        <Input
          type="text"
          value={targetCl}
          onChange={(e) => handleClChange(e.target.value)}
          placeholder="Leave empty for HEAD"
          className="bg-[hsl(0,0%,9%)] border-border"
        />
        {clError && (
          <p className="text-xs text-destructive mt-1">{clError}</p>
        )}
        {targetCl.length > 0 && !clError && (
          <p className="text-xs text-muted-foreground mt-1">
            Syncing project + UnrealEngine
          </p>
        )}
      </div>

      {/* Perforce behind-check — visible right before syncing */}
      {behindLoading ? (
        <div className="w-full max-w-xs flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Checking for updates...</span>
        </div>
      ) : behindInfo ? (
        <div className="w-full max-w-xs flex items-center justify-center">
          {behindInfo.behind > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-500">
              <ArrowDown className="h-3 w-3" />
              Behind {behindInfo.behind} file{behindInfo.behind !== 1 ? "s" : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-500">
              <Check className="h-3 w-3" />
              Up to date
            </span>
          )}
        </div>
      ) : null}

      <Button
        onClick={onStartSync}
        disabled={!hasWorkspace || clError !== null || isBusy}
        className="h-9 px-6 bg-accent text-accent-foreground hover:bg-accent/90"
      >
        <Play className="h-4 w-4 mr-2" />
        Start Sync
      </Button>

      {/* Git section */}
      <div className="w-full max-w-xs mt-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Git</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        {gitBranchLoading ? (
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Checking...</span>
            </div>
          </div>
        ) : gitBranchInfo && gitBranchInfo.branch ? (
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="h-3 w-3" />
              <span className="font-medium text-foreground">{gitBranchInfo.branch}</span>
            </div>
            {gitBranchInfo.behind > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
                <ArrowDown className="h-3 w-3" />
                Behind {gitBranchInfo.behind}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500">
                <Check className="h-3 w-3" />
                Up to date
              </span>
            )}
          </div>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={onGitPull}
          disabled={!hasWorkspace || isBusy}
          className="w-full h-8 text-sm"
        >
          <GitPullRequest className="h-3.5 w-3.5 mr-2" />
          Git Pull UnrealEngine
        </Button>
      </div>

    </div>
  );
}
