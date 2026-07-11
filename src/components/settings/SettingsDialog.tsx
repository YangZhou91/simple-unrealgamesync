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
import { X, AlertTriangle, FolderOpen, Download } from "lucide-react";
import type { WorkspaceConfig } from "@/lib/types";
import * as commands from "@/lib/commands";
import {
  loadUpdaterSettings,
  saveUpdaterSettings,
  DEFAULT_UPDATER_PROXY_URL,
} from "@/lib/updaterSettings";
import { runProxyConnectionTest } from "@/lib/updaterProxyTest";

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

  // HOTUI-14 (Phase 12 D-06): the Logs section is app-global. The current log
  // path is resolved Rust-side by get_log_path (the real LogDir the plugin
  // writes to); the dialog only displays it. Cleared on close so a stale path
  // from a previous open never shows.
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logStatus, setLogStatus] = useState<
    { kind: "ok"; message: string } | { kind: "err"; message: string } | null
  >(null);

  // quick-260710-gfp: app-global updater-proxy state. Proxy toggle + editable
  // URL persisted via tauri-plugin-store (".settings" file). proxyLoaded
  // distinguishes "haven't read yet" from "read & off" so the toggle doesn't
  // visibly flash off→on when the dialog opens with the proxy enabled.
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState(DEFAULT_UPDATER_PROXY_URL);
  const [proxyLoaded, setProxyLoaded] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<
    { kind: "ok"; message: string } | { kind: "err"; message: string } | null
  >(null);
  // quick-260711-jpq: Test-button state. proxyTestStatus shadows proxyStatus
  // so the single inline <p> shows whichever fired most recently (a test
  // result shouldn't be buried under a stale "Saved" message, and vice
  // versa). Same ok/err shape as proxyStatus so the color branch is reused.
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestStatus, setProxyTestStatus] = useState<
    { kind: "ok"; message: string } | { kind: "err"; message: string } | null
  >(null);

  useEffect(() => {
    if (!open) {
      setLogPath(null);
      setLogStatus(null);
      // quick-260710-gfp: reset proxy loader state so the next open re-reads.
      setProxyLoaded(false);
      setProxyStatus(null);
      // quick-260711-jpq: clear any stale test result on close.
      setProxyTestStatus(null);
      return;
    }
    let cancelled = false;
    commands
      .getLogPath()
      .then((p) => {
        if (!cancelled) setLogPath(p);
      })
      .catch(() => {
        if (!cancelled) setLogPath(null);
      });
    // quick-260710-gfp: load persisted proxy settings when the dialog opens.
    // Mirrors the logPath loader's cancelled-guard shape.
    loadUpdaterSettings()
      .then((s) => {
        if (!cancelled) {
          setProxyEnabled(s.proxyEnabled);
          setProxyUrl(s.proxyUrl);
          setProxyLoaded(true);
        }
      })
      .catch(() => {
        // Read failed — fall through with defaults (proxy stays off, default
        // URL). The user can still toggle + save to write a fresh store.
        if (!cancelled) setProxyLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  // D-07: Rust-side explorer spawn survives a sluggish WebView2.
  const handleOpenLogsFolder = async () => {
    setLogStatus(null);
    try {
      await commands.openLogsFolder();
    } catch (e) {
      setLogStatus({ kind: "err", message: String(e) });
    }
  };

  // D-08: Rust-side save dialog + fs::copy. Operator-cancel returns
  // Err("cancelled") which is a no-op, not an error toast.
  const handleExportLog = async () => {
    setLogStatus(null);
    try {
      const dest = await commands.exportLog();
      setLogStatus({ kind: "ok", message: `Exported to ${dest}` });
    } catch (e) {
      const msg = String(e);
      if (msg !== "cancelled") {
        setLogStatus({ kind: "err", message: msg });
      }
    }
  };

  // quick-260710-gfp: toggle persists immediately so enable/disable takes
  // effect even if the user closes the dialog without hitting Save — the
  // next auto-check reads settings fresh and a stale in-memory toggle would
  // otherwise leak through. Carries the proxySaving guard.
  const handleProxyToggle = async (next: boolean) => {
    if (proxySaving) return;
    setProxyEnabled(next);
    setProxyStatus(null);
    // quick-260711-jpq: a toggle is a proxy state change — clear the stale
    // test result so the inline line doesn't lie about the old config.
    setProxyTestStatus(null);
    setProxySaving(true);
    try {
      await saveUpdaterSettings({ proxyEnabled: next, proxyUrl });
    } catch (e) {
      setProxyStatus({ kind: "err", message: String(e) });
    } finally {
      setProxySaving(false);
    }
  };

  // Save button for the URL field. Trims on blur-equivalent; if empty, falls
  // back to DEFAULT in state AND in what we persist (never store an empty
  // URL — saveUpdaterSettings enforces this too, defense in depth).
  const handleSaveProxyUrl = async () => {
    if (proxySaving) return;
    const trimmed = proxyUrl.trim();
    const normalized =
      trimmed.length > 0 ? trimmed : DEFAULT_UPDATER_PROXY_URL;
    setProxyUrl(normalized);
    setProxyStatus(null);
    // quick-260711-jpq: saving a new URL invalidates any prior test result.
    setProxyTestStatus(null);
    setProxySaving(true);
    try {
      await saveUpdaterSettings({ proxyEnabled, proxyUrl: normalized });
      setProxyStatus({ kind: "ok", message: "Saved" });
    } catch (e) {
      setProxyStatus({ kind: "err", message: String(e) });
    } finally {
      setProxySaving(false);
    }
  };

  // quick-260711-jpq: extract the port from a proxy URL for the
  // "代理不可达：Clash 未在 <port> 监听" message. Never throws — malformed
  // user input falls back to the substring after the last ":".
  function extractPort(url: string): string {
    try {
      const port = new URL(url).port;
      if (port) return port;
    } catch {
      // not a parseable URL — fall through to the substring heuristic
    }
    const idx = url.lastIndexOf(":");
    if (idx >= 0 && idx < url.length - 1) {
      const tail = url.slice(idx + 1);
      // Strip any trailing path/fragment/query so "host:7897/foo" -> "7897".
      const match = tail.match(/^\d+/);
      if (match) return match[0];
      return tail;
    }
    return url;
  }

  // quick-260711-jpq: Test-connection handler. Exercises the updater's
  // first-party check({ proxy, timeout }) — NOT fetch — so the proxy is
  // applied at the Rust reqwest layer (the only test that actually proves
  // the GFW-proxy reachability). Connectivity-only; NEVER installs.
  const handleTestProxy = async () => {
    if (proxyTesting || proxySaving || !proxyEnabled || !proxyLoaded) return;
    // Mirror handleSaveProxyUrl's fallback so an empty field still tests the
    // default — never test an empty string.
    const url = proxyUrl.trim() || DEFAULT_UPDATER_PROXY_URL;
    setProxyTesting(true);
    setProxyTestStatus(null);
    try {
      const result = await runProxyConnectionTest({ proxyUrl: url, timeout: 8000 });
      if (result.kind === "ok") {
        setProxyTestStatus({
          kind: "ok",
          message: result.note
            ? `✓ 代理可达 GitHub（${result.note}）`
            : "✓ 代理可达 GitHub",
        });
      } else if (result.kind === "refused") {
        setProxyTestStatus({
          kind: "err",
          message: `✗ 代理不可达：Clash 未在 ${extractPort(url)} 监听`,
        });
      } else if (result.kind === "timeout") {
        setProxyTestStatus({
          kind: "err",
          message: "✗ 代理可达但 GitHub 通不过：检查 Clash 规则是否放行 github.com",
        });
      } else {
        setProxyTestStatus({ kind: "err", message: `✗ ${result.message}` });
      }
    } catch (e) {
      // Defensive: runProxyConnectionTest should not throw, but a thrown
      // plugin shim would otherwise leave proxyTesting stuck.
      setProxyTestStatus({ kind: "err", message: `✗ ${String(e)}` });
    } finally {
      setProxyTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[hsl(0,0%,14%)] border-border text-foreground">
        <DialogHeader>
          <DialogTitle>
            {workspace ? "Workspace Settings" : "Settings"}
          </DialogTitle>
          <DialogDescription>
            {workspace
              ? `Configure sync options for ${workspace.name}`
              : "Diagnostics and log export"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* HOTUI-14 (Phase 12 D-06): app-global Logs section — always shown. */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <label className="text-sm text-muted block">Logs</label>
            <Input
              readOnly
              value={logPath ?? "resolving..."}
              className="bg-[hsl(0,0%,9%)] border-border text-muted-foreground"
              aria-label="Current log file path"
            />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenLogsFolder}
              >
                <FolderOpen className="h-4 w-4" />
                Open logs folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportLog}
              >
                <Download className="h-4 w-4" />
                Export log
              </Button>
            </div>
            {logStatus && (
              <p
                className={`text-xs mt-1 ${logStatus.kind === "ok" ? "text-emerald-400" : "text-destructive"}`}
              >
                {logStatus.message}
              </p>
            )}
          </div>

          {/* quick-260710-gfp: app-global Network/Proxy section — always shown.
              Routes the auto-updater's GitHub traffic through a local proxy
              (default off = direct GitHub, unchanged from pre-feature). */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <label className="text-sm text-muted block">Network / 代理</label>
            <p className="text-xs text-muted-foreground">
              Route the auto-updater's GitHub traffic through this proxy (e.g.
              a local Clash mixed-port). Leave off for direct connection.
            </p>
            <label className="flex items-center gap-2 text-sm pt-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={proxyEnabled}
                onChange={(e) => handleProxyToggle(e.target.checked)}
                disabled={proxySaving || !proxyLoaded}
                className="h-4 w-4 rounded border-border bg-[hsl(0,0%,9%)] accent-accent cursor-pointer"
                aria-label="Enable updater proxy"
              />
              <span>Enable proxy for auto-updater</span>
            </label>
            <Input
              type="text"
              value={proxyUrl}
              onChange={(e) => {
                setProxyUrl(e.target.value);
                setProxyStatus(null);
                // quick-260711-jpq: URL edit invalidates any prior test result.
                setProxyTestStatus(null);
              }}
              onBlur={() => {
                const trimmed = proxyUrl.trim();
                setProxyUrl(trimmed.length > 0 ? trimmed : DEFAULT_UPDATER_PROXY_URL);
              }}
              placeholder={DEFAULT_UPDATER_PROXY_URL}
              disabled={!proxyEnabled || proxySaving || !proxyLoaded}
              className="bg-[hsl(0,0%,9%)] border-border"
              aria-label="Proxy URL"
            />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveProxyUrl}
                disabled={proxySaving || !proxyEnabled || !proxyLoaded}
              >
                Save URL
              </Button>
              {/* quick-260711-jpq: Test button — exercises the updater's
                  first-party check({ proxy, timeout: 8000 }), NOT fetch. The
                  proxy is applied at the Rust reqwest layer; a fetch would
                  bypass it and only test direct connectivity. Disabled when
                  proxy off, URL empty (after trim), test-in-flight, or
                  settings saving. */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestProxy}
                disabled={
                  proxyTesting ||
                  proxySaving ||
                  !proxyEnabled ||
                  !proxyLoaded ||
                  proxyUrl.trim().length === 0
                }
              >
                {proxyTesting ? "测试中…" : "测试连接"}
              </Button>
              {/* Single inline status line: show the most-recent test result
                  if present, else the proxy save status. They never stack. */}
              {(() => {
                const status = proxyTestStatus ?? proxyStatus;
                if (!status) return null;
                return (
                  <p
                    className={`text-xs ${status.kind === "ok" ? "text-emerald-400" : "text-destructive"}`}
                  >
                    {status.message}
                  </p>
                );
              })()}
            </div>
          </div>

          {workspace && (
            <>
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
            </>
          )}
        </div>
        {workspace && (
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
        )}
      </DialogContent>
    </Dialog>
  );
}
