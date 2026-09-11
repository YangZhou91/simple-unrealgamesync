// Phase 23 (23-01, D-01): TEST-ONLY harness entry. Never imported by anything
// under src/; index.html still loads /src/main.tsx — the production entry is
// untouched.
//
// Boot order is load-bearing (Pitfall 1): the Tauri mock seam must be
// installed BEFORE the production App tree evaluates/mounts, or App boot
// effects race undefined __TAURI_INTERNALS__. Static imports all hoist, so
// App/I18nProvider/index.css load through a DYNAMIC import that runs after
// createHarness() has installed window.__TAURI_INTERNALS__ synchronously.
import { createHarness, resetWindowCalls, windowCalls } from "./tauri-mock";
import { harnessController } from "./fixtures/controller";
// react-dom/client has no Tauri access at module scope — safe to hoist.
import { createRoot } from "react-dom/client";

// 1) Seed the fixture controller from URL search params BEFORE anything else
//    (?locale=zh|en pins I18nProvider; ?workspaces=default|empty|long seeds
//    the controller's workspace mode).
const params = new URLSearchParams(window.location.search);
const workspacesParam = params.get("workspaces");
if (
  workspacesParam === "default" ||
  workspacesParam === "empty" ||
  workspacesParam === "long"
) {
  harnessController.setWorkspacesMode(workspacesParam);
}
const initialLocale = params.get("locale") === "en" ? ("en" as const) : ("zh" as const);

// 2) Install the mock seam synchronously (mockWindows + mockIPC from the
//    bundled @tauri-apps/api/mocks). From here on, EVERY invoke from the
//    production tree routes through the fixture dispatch table.
createHarness();

// 3) Spec driving surface (D-02): mirrors the canonical previewControls
//    surface — a state snapshot plus the change hooks specs need.
(window as unknown as Record<string, unknown>).__HARNESS__ = {
  state: harnessController.snapshot(),
  setNextScenario: (id: Parameters<typeof harnessController.setNextScenario>[0]) =>
    harnessController.setNextScenario(id),
  releaseCancel: () => harnessController.releaseCancel(),
  registerScripts: (scripts: Parameters<typeof harnessController.registerScripts>[0]) =>
    harnessController.registerScripts(scripts),
  getState: () => harnessController.snapshot(),
  // 24-02: titlebar adapter recorder — specs reset/read the recorded
  // plugin:window|* commands through this pass-through (page-side state).
  windowCalls: () => windowCalls(),
  resetWindowCalls: () => resetWindowCalls(),
};

// 4) Load the production composition root AFTER the mocks exist, pinned to a
//    literal locale (replaces main.tsx's resolveLocale flow, which would need
//    real invoke round-trips). The CSS side-effect import is typed for tsc
//    via the ambient module below (Vite handles it at runtime).
const rootEl = document.getElementById("root") as HTMLElement;
void Promise.all([
  import("@/App"),
  import("@/lib/i18n"),
  import("@/index.css"),
]).then(([{ default: App }, { I18nProvider }]) => {
  createRoot(rootEl).render(
    <I18nProvider initialLocale={initialLocale}>
      <App />
    </I18nProvider>,
  );
});
