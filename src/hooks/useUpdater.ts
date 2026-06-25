import { useState, useEffect, useCallback } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { ask } from "@tauri-apps/plugin-dialog";

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

  const checkForUpdate = useCallback(async () => {
    setInfo((p) => ({ ...p, state: "checking", error: null }));
    try {
      const update: Update | null = await check();
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

  // Auto-check once on startup (delayed 3s so the window is visible first)
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
