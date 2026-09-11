import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X, AlertTriangle, FolderOpen, Download } from "lucide-react";
import type { WorkspaceConfig } from "@/lib/types";
import * as commands from "@/lib/commands";
import {
  loadUpdaterSettings,
  saveUpdaterSettings,
  DEFAULT_UPDATER_PROXY_URL,
} from "@/lib/updaterSettings";
import { runProxyConnectionTest } from "@/lib/updaterProxyTest";
import { proxyUrlHasCredentials } from "@/lib/updaterProxyPrivacy";
import { useT, type MessageKey } from "@/lib/i18n";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

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

type ExclusionError = "empty" | "invalid" | "duplicate";
const EXCLUSION_ERROR: Record<ExclusionError, MessageKey> = {
  empty: "settings.exclusions.error.empty",
  invalid: "settings.exclusions.error.invalid",
  duplicate: "settings.exclusions.error.duplicate",
};

type ProxySaveStatus = { kind: "ok" } | { kind: "credentials" } | { kind: "err"; message: string } | null;
type LogStatus = { kind: "ok"; dest: string } | { kind: "err"; message: string } | null;
type StartupStatus = { kind: "err"; message: string } | null;

// Refused-status {port}: parsed URLs use explicit port or scheme default; heuristic is malformed-only.
export function extractPort(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.port) return parsed.port;
    if (parsed.protocol === "https:") return "443";
    if (parsed.protocol === "http:") return "80";
    if (parsed.host) return parsed.host;
  } catch {
    // malformed — substring after last ":"
  }
  const idx = url.lastIndexOf(":");
  if (idx >= 0 && idx < url.length - 1) {
    const tail = url.slice(idx + 1);
    const match = tail.match(/^\d+/);
    if (match) return match[0];
    return tail;
  }
  return url;
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
  const [exclusionError, setExclusionError] = useState<ExclusionError | null>(null);
  const [nonexistentPaths, setNonexistentPaths] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [mountedWorkspaceId, setMountedWorkspaceId] = useState(
    () => workspace?.id ?? null,
  );
  const [scope, setScope] = useState<"workspace" | "app">(
    workspace ? "workspace" : "app",
  );

  // I18N-02: language state from I18nProvider context.
  const { locale, setLocale, t } = useT();

  // HOTUI-14 (Phase 12 D-06): the Logs section is app-global. The current log
  // path is resolved Rust-side by get_log_path (the real LogDir the plugin
  // writes to); the dialog only displays it. Cleared on close so a stale path
  // from a previous open never shows.
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logStatus, setLogStatus] = useState<LogStatus>(null);

  // quick-260710-gfp: app-global updater-proxy state. Proxy toggle + editable
  // URL persisted via tauri-plugin-store (".settings" file). proxyLoaded
  // distinguishes "haven't read yet" from "read & off" so the toggle doesn't
  // visibly flash off→on when the dialog opens with the proxy enabled.
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyUrl, setProxyUrl] = useState(DEFAULT_UPDATER_PROXY_URL);
  const [proxyLoaded, setProxyLoaded] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<ProxySaveStatus>(null);
  // quick-260711-jpq / SWEEP-04: Test-button state. proxyTestStatus shadows
  // proxyStatus so the single inline <p> shows whichever fired most recently
  // (a test result shouldn't be buried under a stale "Saved" message, and
  // vice versa). I18N-02: the snapshot stores the machine KIND (+ port /
  // note-truthiness / raw error string) — the visible message is DERIVED at
  // render via t("settings.proxy.*") so a live locale switch re-labels an
  // already-painted status (Interaction Contract mid-switch rule). The lib
  // returns hasNote, never a display string.
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestStatus, setProxyTestStatus] = useState<
    | { kind: "ok"; hasNote: boolean }
    | { kind: "refused"; port: string }
    | { kind: "timeout" }
    | { kind: "error"; raw: string }
    | null
  >(null);

  // LAUNCH-01: OS autostart is the source of truth (plugin-autostart isEnabled),
  // not a parallel store key. Default off until isEnabled resolves true.
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [startupLoaded, setStartupLoaded] = useState(false);
  const [startupSaving, setStartupSaving] = useState(false);
  const [startupStatus, setStartupStatus] = useState<StartupStatus>(null);

  const openRef = useRef(open);
  openRef.current = open;
  const proxyTestGenRef = useRef(0);

  useEffect(() => {
    proxyTestGenRef.current += 1;
    if (!open) {
      setLogPath(null);
      setLogStatus(null);
      // quick-260710-gfp: reset proxy loader state so the next open re-reads.
      setProxyLoaded(false);
      setProxyStatus(null);
      // quick-260711-jpq: clear any stale test result on close.
      setProxyTestStatus(null);
      setProxyTesting(false);
      setStartupLoaded(false);
      setStartupStatus(null);
      return;
    }
    setProxyTestStatus(null);
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
    // LAUNCH-01: re-read OS autostart state on every open. Failure leaves the
    // checkbox off (safe default) but still unlocks the control.
    isEnabled()
      .then((enabled) => {
        if (!cancelled) {
          setLaunchAtStartup(enabled);
          setStartupLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLaunchAtStartup(false);
          setStartupLoaded(true);
          setStartupStatus({ kind: "err", message: String(e) });
        }
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
      // App.tsx mounts this dialog at boot with workspace=null (scope "app").
      // Adopting a workspace must land on the UI-SPEC workspace default;
      // do not put `scope` in this effect's deps.
      setScope("workspace");
    } else if (!workspace && mountedWorkspaceId !== null) {
      // Workspace removed mid-session (e.g. a delete IPC resolving while the
      // dialog is open): UI-SPEC forces scope "app" when !workspace — both
      // panels render empty/hidden with no tab strip to recover otherwise.
      // Reset the sentinel so re-adopting even the same workspace id
      // re-initializes drafts.
      setMountedWorkspaceId(null);
      setScope("app");
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
      setExclusionError("empty");
      return;
    }
    if (trimmed.includes("..")) {
      setExclusionError("invalid");
      return;
    }
    if (exclusions.includes(trimmed)) {
      setExclusionError("duplicate");
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
      setLogStatus({ kind: "ok", dest });
    } catch (e) {
      const msg = String(e);
      if (msg !== "cancelled") {
        setLogStatus({ kind: "err", message: msg });
      }
    }
  };

  // LAUNCH-01: persist immediately on toggle so closing without a Save button
  // still updates HKCU Run. Revert the checkbox if enable/disable rejects.
  const handleLaunchAtStartupToggle = async (next: boolean) => {
    if (startupSaving || !startupLoaded) return;
    const previous = launchAtStartup;
    setLaunchAtStartup(next);
    setStartupStatus(null);
    setStartupSaving(true);
    try {
      if (next) {
        await enable();
      } else {
        await disable();
      }
    } catch (e) {
      setLaunchAtStartup(previous);
      setStartupStatus({ kind: "err", message: String(e) });
    } finally {
      setStartupSaving(false);
    }
  };

  // quick-260710-gfp: toggle persists immediately so enable/disable takes
  // effect even if the user closes the dialog without hitting Save — the
  // next auto-check reads settings fresh and a stale in-memory toggle would
  // otherwise leak through. Carries the proxySaving guard.
  const handleProxyToggle = async (next: boolean) => {
    if (proxySaving) return;
    if (proxyUrlHasCredentials(proxyUrl)) {
      setProxyTestStatus(null);
      setProxyStatus({ kind: "credentials" });
      return;
    }
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
    if (proxyUrlHasCredentials(proxyUrl)) {
      setProxyTestStatus(null);
      setProxyStatus({ kind: "credentials" });
      return;
    }
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
      setProxyStatus({ kind: "ok" });
    } catch (e) {
      setProxyStatus({ kind: "err", message: String(e) });
    } finally {
      setProxySaving(false);
    }
  };

  // quick-260711-jpq: Test-connection handler. Exercises the updater's
  // first-party check({ proxy, timeout }) — NOT fetch — so the proxy is
  // applied at the Rust reqwest layer (the only test that actually proves
  // the GFW-proxy reachability). Connectivity-only; NEVER installs.
  const handleTestProxy = async () => {
    if (proxyTesting || proxySaving || !proxyEnabled || !proxyLoaded) return;
    // Mirror handleSaveProxyUrl's fallback so an empty field still tests the
    // default — never test an empty string.
    const url = proxyUrl.trim() || DEFAULT_UPDATER_PROXY_URL;
    const gen = proxyTestGenRef.current;
    setProxyTesting(true);
    setProxyTestStatus(null);
    try {
      const result = await runProxyConnectionTest({ proxyUrl: url, timeout: 8000 });
      if (!openRef.current || gen !== proxyTestGenRef.current) return;
      // Store the machine kind + derived-at-render inputs only.
      // hasNote is a boolean from the lib — never a display string.
      if (result.kind === "ok") {
        setProxyTestStatus({
          kind: "ok",
          hasNote: Boolean(result.hasNote),
        });
      } else if (result.kind === "credentials") {
        setProxyTestStatus(null);
        setProxyStatus({ kind: "credentials" });
      } else if (result.kind === "refused") {
        setProxyTestStatus({ kind: "refused", port: extractPort(url) });
      } else if (result.kind === "timeout") {
        setProxyTestStatus({ kind: "timeout" });
      } else {
        setProxyTestStatus({ kind: "error", raw: result.message });
      }
    } catch (e) {
      if (!openRef.current || gen !== proxyTestGenRef.current) return;
      // Defensive: runProxyConnectionTest should not throw, but a thrown
      // plugin shim would otherwise leave proxyTesting stuck.
      setProxyTestStatus({ kind: "error", raw: String(e) });
    } finally {
      if (gen === proxyTestGenRef.current) setProxyTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-foreground sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="text-section font-medium">
            {workspace
              ? t("settings.title.workspace")
              : t("settings.title")}
          </DialogTitle>
          <DialogDescription className="text-note">
            {!workspace
              ? t("settings.description")
              : scope === "workspace"
                ? t("settings.description.workspace", { name: workspace.name })
                : t("settings.scope.app")}
          </DialogDescription>
        </DialogHeader>
        {workspace && (
          <div
            role="group"
            aria-label={t("settings.tabsAria")}
            className="mb-4 flex flex-wrap gap-2"
          >
            <button
              type="button"
              aria-pressed={scope === "workspace"}
              onClick={() => setScope("workspace")}
              className={`min-h-8 rounded-sm border border-border px-2 py-2 text-note font-normal [@media(pointer:coarse)]:min-h-11 ${
                scope === "workspace"
                  ? "bg-well text-foreground"
                  : "bg-transparent text-muted"
              }`}
            >
              {t("settings.tab.workspace")}
            </button>
            <button
              type="button"
              aria-pressed={scope === "app"}
              onClick={() => setScope("app")}
              className={`min-h-8 rounded-sm border border-border px-2 py-2 text-note font-normal [@media(pointer:coarse)]:min-h-11 ${
                scope === "app"
                  ? "bg-well text-foreground"
                  : "bg-transparent text-muted"
              }`}
            >
              {t("settings.tab.app")}
            </button>
          </div>
        )}
        <div hidden={scope !== "app"}>
          {/* I18N-02: Language section — first app-global section, before Startup. */}
          <div className="space-y-2 border-b border-border py-4 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-body font-medium">{t("settings.language.title")}</h3>
              <span className="inline-flex whitespace-nowrap rounded-sm border border-border px-2 py-px text-caption font-normal leading-[1.5] text-muted">
                {t("settings.persist.immediate")}
              </span>
            </div>
            <p className="text-note text-muted">{t("settings.language.description")}</p>
            <div className="flex flex-wrap gap-2 pt-1" role="radiogroup" aria-label={t("settings.language.title")}>
              <button
                type="button"
                className={`min-h-8 px-4 py-2 text-note rounded-md rounded-r-none cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11 ${locale === "zh" ? "bg-accent text-accent-foreground" : "bg-well text-muted-foreground border border-border"}`}
                role="radio"
                aria-pressed={locale === "zh"}
                onClick={() => setLocale("zh")}
              >
                {t("settings.language.zh")}
              </button>
              <button
                type="button"
                className={`min-h-8 px-4 py-2 text-note rounded-md rounded-l-none cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11 ${locale === "en" ? "bg-accent text-accent-foreground" : "bg-well text-muted-foreground border border-border"}`}
                role="radio"
                aria-pressed={locale === "en"}
                onClick={() => setLocale("en")}
              >
                {t("settings.language.en")}
              </button>
            </div>
          </div>
          {/* LAUNCH-01: app-global Startup section — always shown, even with no
              workspace selected. OS isEnabled() is the source of truth. */}
          <div className="space-y-2 border-b border-border py-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-body font-medium">{t("settings.startup.title")}</h3>
              <span className="inline-flex whitespace-nowrap rounded-sm border border-border px-2 py-px text-caption font-normal leading-[1.5] text-muted">
                {t("settings.persist.immediate")}
              </span>
            </div>
            <p className="text-note text-muted">
              {t("settings.startup.description")}
            </p>
            <label className="flex min-h-8 items-center gap-2 text-note pt-1 cursor-pointer select-none [@media(pointer:coarse)]:min-h-11">
              <input
                type="checkbox"
                checked={launchAtStartup}
                onChange={(e) => handleLaunchAtStartupToggle(e.target.checked)}
                disabled={startupSaving || !startupLoaded}
                className="h-4 w-4 rounded border-border bg-well accent-primary cursor-pointer"
                aria-label={t("settings.startup.launch")}
              />
              <span>{t("settings.startup.launch")}</span>
            </label>
            {startupStatus && (
              <p className="text-note mt-1 text-destructive">
                {t("settings.startup.error", { message: startupStatus.message })}
              </p>
            )}
          </div>

          {/* HOTUI-14 (Phase 12 D-06): app-global Logs section — always shown. */}
          <div className="space-y-2 border-b border-border py-4">
            <h3 className="text-body font-medium">{t("settings.logs.title")}</h3>
            <Input
              readOnly
              value={logPath ?? t("settings.logs.resolving")}
              className="bg-well border-border font-mono text-note text-muted [overflow-wrap:anywhere]"
              aria-label={t("settings.logs.pathAria")}
            />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenLogsFolder}
                className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
              >
                <FolderOpen className="h-4 w-4" />
                {t("settings.logs.openFolder")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportLog}
                className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
              >
                <Download className="h-4 w-4" />
                {t("settings.logs.export")}
              </Button>
            </div>
            {logStatus && (
              <p
                className={`text-note mt-1 ${logStatus.kind === "ok" ? "text-success" : "text-destructive"}`}
              >
                {logStatus.kind === "ok"
                  ? t("settings.logs.exported", { dest: logStatus.dest })
                  : t("settings.logs.error", { message: logStatus.message })}
              </p>
            )}
          </div>

          {/* quick-260710-gfp: app-global Network/Proxy section — always shown.
              Routes the auto-updater's GitHub traffic through a local proxy
              (default off = direct GitHub, unchanged from pre-feature). */}
          <div className="space-y-2 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-body font-medium">{t("settings.network.title")}</h3>
              <span className="inline-flex whitespace-nowrap rounded-sm border border-border px-2 py-px text-caption font-normal leading-[1.5] text-muted">
                {t("settings.persist.immediate")}
              </span>
            </div>
            <p className="text-note text-muted">
              {t("settings.network.description")}
            </p>
            <label className="flex min-h-8 items-center gap-2 text-note pt-1 cursor-pointer select-none [@media(pointer:coarse)]:min-h-11">
              <input
                type="checkbox"
                checked={proxyEnabled}
                onChange={(e) => handleProxyToggle(e.target.checked)}
                disabled={proxySaving || !proxyLoaded}
                className="h-4 w-4 rounded border-border bg-well accent-primary cursor-pointer"
                aria-label={t("settings.network.enable")}
              />
              <span>{t("settings.network.enable")}</span>
            </label>
            <Input
              type={proxyUrlHasCredentials(proxyUrl) ? "password" : "text"}
              autoComplete="off"
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
              className="bg-well border-border font-mono text-note [overflow-wrap:anywhere]"
              aria-label={t("settings.network.urlAria")}
            />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveProxyUrl}
                disabled={proxySaving || !proxyEnabled || !proxyLoaded}
                className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
              >
                {t("settings.network.saveUrl")}
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
                className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
              >
                {proxyTesting ? t("settings.network.testing") : t("settings.network.test")}
              </Button>
              {/* Single inline status line: show the most-recent test result
                  if present, else the proxy save status. They never stack.
                  SWEEP-04: the proxy-test message is derived HERE at render
                  from the kind snapshot via t("settings.proxy.*") — a live
                  locale switch re-labels an already-painted status (I18N-02
                  Interaction Contract). Raw plugin strings never reach JSX
                  except as interpolated {note}/{message} tokens. */}
              {(() => {
                // Save-URL proxyStatus is a kind snapshot looked up at render
                // (ok → settings.network.saved; err → settings.proxy.error).
                if (proxyTestStatus !== null) {
                  const message =
                    proxyTestStatus.kind === "ok"
                      ? proxyTestStatus.hasNote
                        ? t("settings.proxy.reachableWithNote", {
                            note: t("settings.proxy.updateAvailable"),
                          })
                        : t("settings.proxy.reachable")
                      : proxyTestStatus.kind === "refused"
                        ? t("settings.proxy.refused", {
                            port: proxyTestStatus.port,
                          })
                        : proxyTestStatus.kind === "timeout"
                          ? t("settings.proxy.timeout")
                          : t("settings.proxy.error", {
                              message: proxyTestStatus.raw,
                            });
                  return (
                    <p
                      className={`text-note ${proxyTestStatus.kind === "ok" ? "text-success" : "text-destructive"}`}
                    >
                      {message}
                    </p>
                  );
                }
                if (proxyStatus !== null) {
                  return (
                    <p
                      className={`text-note ${proxyStatus.kind === "ok" ? "text-success" : "text-destructive"}`}
                    >
                      {proxyStatus.kind === "ok"
                        ? t("settings.network.saved")
                        : proxyStatus.kind === "credentials"
                          ? t("settings.proxy.credentials")
                          : t("settings.proxy.error", { message: proxyStatus.message })}
                    </p>
                  );
                }
                return null;
              })()}
            </div>
          </div>
        </div>

        <div hidden={scope !== "workspace"}>
          {workspace && (
            <>
              <div className="grid grid-cols-2 gap-4 narrow:grid-cols-1">
              <div>
                <label htmlFor="parallel-threads" className="text-note text-muted mb-1 block">
                  {t("settings.threads.label")}
                </label>
                <Input
                  id="parallel-threads"
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
                  className="bg-well border-border"
                />
                <p className="text-note text-muted mt-1">
                  {t("settings.threads.hint")}
                </p>
              </div>

              <div>
                <label htmlFor="behind-check-interval" className="text-note text-muted mb-1 block">
                  {t("settings.behind.label")}
                </label>
                <Input
                  id="behind-check-interval"
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
                  className="bg-well border-border"
                />
                <p className="text-note text-muted mt-1">
                  {t("settings.behind.hint")}
                </p>
              </div>
              </div>

              <div className="mt-4">
                <h3 className="text-body font-medium mb-1">
                  {t("settings.exclusions.title")}
                </h3>
                <p className="text-note text-muted mb-2">
                  {t("settings.exclusions.relativeTo", {
                    projectDir:
                      workspace.projectDir || t("settings.exclusions.projectFallback"),
                  })}
                </p>
                <div className="mb-2">
                  {exclusions.map((ex) => {
                    const isMissing = nonexistentPaths.includes(ex);
                    return (
                      <div
                        key={ex}
                        className={`flex items-center justify-between gap-2 border-b border-border bg-well px-2 py-2 font-mono text-note ${
                          isMissing ? "text-warning" : ""
                        }`}
                      >
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {isMissing && (
                            <AlertTriangle className="mr-1 inline h-3 w-3" />
                          )}
                          {ex}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveExclusion(ex)}
                          className="inline-flex min-h-8 shrink-0 items-center hover:text-foreground [@media(pointer:coarse)]:min-h-11"
                          aria-label={t("settings.exclusions.removeAria", { path: ex })}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <Input
                    aria-label={t("settings.exclusions.inputAria")}
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
                    placeholder={t("settings.exclusions.placeholder")}
                    className="bg-well border-border font-mono text-note [overflow-wrap:anywhere]"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddExclusion}
                    className="shrink-0 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
                  >
                    {t("settings.exclusions.add")}
                  </Button>
                </div>
                {exclusionError && (
                  <p className="text-note text-destructive mt-1">
                    {t(EXCLUSION_ERROR[exclusionError])}
                  </p>
                )}
                {nonexistentPaths.length > 0 && !exclusionError && (
                  <p className="text-note text-warning mt-1 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {nonexistentPaths.length === 1
                      ? t("settings.exclusions.missing.one", {
                          paths: nonexistentPaths.join(", "),
                        })
                      : t("settings.exclusions.missing.other", {
                          paths: nonexistentPaths.join(", "),
                        })}
                  </p>
                )}
              </div>
              <DialogFooter className="sticky bottom-0 mt-4 border-t border-border bg-popover pt-4">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isSaving}
                  className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
                >
                  {t("settings.cancel")}
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
                >
                  {t("settings.save")}
                </Button>
              </DialogFooter>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
