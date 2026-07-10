import { useState, useEffect, useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { ask } from "@tauri-apps/plugin-dialog";
import { loadUpdaterSettings } from "@/lib/updaterSettings";

export type UpdaterState = "idle" | "checking" | "available" | "downloading" | "done" | "error";

export interface UpdaterInfo {
  state: UpdaterState;
  version: string | null;       // available version
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

export function useUpdater() {
  const [info, setInfo] = useState<UpdaterInfo>({
    state: "idle",
    version: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
  });

  // quick-260710-gfp: read proxy settings fresh on EVERY check so a user
  // toggling the proxy in Settings takes effect on the next manual
  // "check for update" without a restart. The settings module caches the
  // store handle, so this is one IPC round-trip of a tiny object — cheap
  // enough to read-per-call. When proxyEnabled is false we pass an empty
  // options object, which is byte-for-byte today's direct-GitHub behavior.
  //
  // NOTE: proxy is passed ONLY to check(). The plugin's CheckOptions.proxy
  // doc states it is "used when checking AND downloading updates" — the
  // reqwest client built inside the Rust `check` command reuses this proxy
  // for the subsequent downloadAndInstall(). Do NOT also pass proxy to
  // downloadAndInstall (DownloadOptions has no proxy field).
  const checkForUpdate = useCallback(async () => {
    setInfo((p) => ({ ...p, state: "checking", error: null }));
    try {
      const settings = await loadUpdaterSettings();
      const opts = settings.proxyEnabled ? { proxy: settings.proxyUrl } : {};
      const update: Update | null = await check(opts);
      if (!update) {
        setInfo((p) => ({ ...p, state: "idle" }));
        return;
      }
      setInfo((p) => ({ ...p, state: "available", version: update.version }));
      return update;
    } catch (e) {
      setInfo((p) => ({
        ...p,
        state: "error",
        error: String(e),
      }));
    }
  }, []);

  const downloadAndInstall = useCallback(async (update: Update) => {
    const confirmed = await ask(
      `Version ${update.version} is available. Install now? The app will restart.`,
      { title: "Update Available", kind: "info" },
    );
    if (!confirmed) {
      setInfo((p) => ({ ...p, state: "idle" }));
      return;
    }

    setInfo((p) => ({ ...p, state: "downloading", downloadedBytes: 0, totalBytes: null }));
    try {
      await update.downloadAndInstall((progress) => {
        if (progress.event === "Progress") {
          setInfo((p) => ({
            ...p,
            downloadedBytes: progress.data.chunkLength + p.downloadedBytes,
          }));
        } else if (progress.event === "Started") {
          setInfo((p) => ({
            ...p,
            totalBytes: progress.data.contentLength ?? null,
          }));
        }
      });
      setInfo((p) => ({ ...p, state: "done" }));
    } catch (e) {
      setInfo((p) => ({ ...p, state: "error", error: String(e) }));
    }
  }, []);

  const checkAndInstall = useCallback(async () => {
    const update = await checkForUpdate();
    if (update) {
      await downloadAndInstall(update);
    }
  }, [checkForUpdate, downloadAndInstall]);

  // Auto-check once on startup (delayed 3s so the window is visible first).
  // quick-260710-gfp: checkForUpdate awaits loadUpdaterSettings internally
  // before calling check(), so the very first auto-check already routes
  // through the configured proxy. The settings load is naturally serialized
  // ahead of `check` — no separate pre-load step needed.
  useEffect(() => {
    const t = setTimeout(() => {
      checkForUpdate().then((update) => {
        if (update) {
          // Update found — keep state as "available"; user will see the badge
        }
      });
    }, 3000);
    return () => clearTimeout(t);
  }, [checkForUpdate]);

  return { info, checkAndInstall, downloadAndInstall, checkForUpdate };
}
