// Phase 24 (24-02, D-03): window-control adapter for the AppTitleBar.
//
// Production shape mirrors every other Tauri plugin consumer (useUpdater
// pattern): import the typed API, call it. The harness intercepts the IPC
// layer itself (tests/visual/tauri-mock.ts mockIPC dispatch on
// plugin:window|minimize / toggle_maximize / close), so NO test-injection
// seam is needed here — src/ carries zero setForTesting-style seams and this
// module does not introduce the first one (24-PATTERNS mismatch warning).
//
// getCurrentWindow() is resolved lazily per call (never at module scope) and
// constructs without IPC in the mock harness: mockWindows("main") sets
// __TAURI_INTERNALS__.metadata.currentWindow.label, and the Window
// constructor's skip:true guard performs no invocation (24-RESEARCH Q1).
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The product name shown in the titlebar. Identical in both locales
 * (v1.7 TRAY-01 pattern — reads the same in zh/en), so it is a shared
 * constant, NOT a per-locale dictionary entry.
 */
export const APP_TITLE = "Simple UnrealGameSync";

export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Bound window-control methods for the titlebar buttons. Resolve once per
 * component mount (useMemo/useRef in AppTitleBar) — not per render.
 */
export function getTitleBarControls(): WindowControls {
  return {
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    // close() raises CloseRequested, which the Rust handler
    // (src-tauri/src/lib.rs:127-133) intercepts with prevent_close() +
    // hide() — the close-to-tray policy (D-03). NEVER destroy() and NEVER
    // app.exit() from the frontend: both bypass the event and kill the
    // process (and any running sync).
    close: () => getCurrentWindow().close(),
  };
}
