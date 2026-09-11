// Phase 23 (23-01, D-01/D-02): centralized Tauri IPC mock for the visual
// harness. One mockIPC handler intercepts the ENTIRE surface — app commands
// AND every JS plugin (store/updater/dialog/log/app/autostart) — because all
// of them route through window.__TAURI_INTERNALS__.invoke.
//
// Fail-closed: any unmocked command throws "fixture: unmocked command" so a
// new boot command surfaces immediately instead of silently returning
// undefined.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { harnessController } from "./fixtures/controller";
import {
  FIXTURE_ADDED_WORKSPACE,
  FIXTURE_CHANGELISTS_PAGE1,
  FIXTURE_CHANGELISTS_PAGE2,
  FIXTURE_CURRENT_CL,
  FIXTURE_GIT_BRANCH,
  FIXTURE_HEALTH_REPORT,
  FIXTURE_HISTORY,
  FIXTURE_STREAM,
  workspacesForMode,
} from "./fixtures/workspaces";

/** Matches the mocked app version surfaced in the sidebar changelog button. */
const FIXTURE_APP_VERSION = "1.7.0";
const FIXTURE_LOG_PATH = "D:\\Fixtures\\logs\\sugs.log";

// Phase 24 (24-02, SHELL-02): titlebar adapter call log. Records the exact
// IPC command names the AppTitleBar buttons invoke, in click order, so specs
// can assert minimize/toggle_maximize/close routing (and that NO destroy /
// exit command is ever issued). Read via the __HARNESS__ pass-through in
// tests/visual/main.tsx — the Node-side spec process shares no module state
// with the page, so the recorder must be page-reachable.
const recordedWindowCalls: string[] = [];

/** Snapshot of the recorded window-control commands, oldest first. */
export function windowCalls(): readonly string[] {
  return [...recordedWindowCalls];
}

/** Clear the recorder between assertions. */
export function resetWindowCalls(): void {
  recordedWindowCalls.length = 0;
}

/**
 * Extract the Channel id from a start-type invoke's onEvent arg.
 *
 * core.js serializes a Channel to `__CHANNEL__:<id>` for the real backend,
 * but mockIPC hands the dispatch the RAW (unserialized) args — so onEvent is
 * the Channel instance itself, whose public `.id` is the transformCallback id
 * registered in the page. Support both shapes.
 */
function channelArgId(args: Record<string, unknown> | undefined): number | null {
  const onEvent = args?.onEvent as { id?: number } | string | undefined;
  if (onEvent == null) return null;
  if (typeof onEvent === "string") {
    const m = /^__CHANNEL__:(\d+)$/.exec(onEvent);
    return m ? Number(m[1]) : null;
  }
  return typeof onEvent.id === "number" ? onEvent.id : null;
}

/** Paged changelists: page 1 first, then page 2, then exhausted. */
function fixtureChangelists(afterCl: string | null) {
  if (afterCl == null) return FIXTURE_CHANGELISTS_PAGE1;
  return afterCl > "381203" ? FIXTURE_CHANGELISTS_PAGE2 : [];
}

/**
 * Install the harness mock seam. MUST run synchronously before the production
 * App tree mounts (Pitfall 1) — tests/visual/main.tsx calls this at module
 * top before the dynamic App import.
 */
export function createHarness(): void {
  mockWindows("main");
  // mockIPC's callback types payload as the InvokeArgs union; every command
  // in this table receives a plain object — narrow once at the boundary.
  type MockArgs = Record<string, unknown>;
  const arg = (a: unknown): MockArgs => (a ?? {}) as MockArgs;
  mockIPC((cmd, args) => {
    switch (cmd) {
      // ---- app commands (src/lib/commands.ts) ----
      case "get_workspaces":
        return workspacesForMode(harnessController.workspacesMode);
      case "get_current_cl":
        return FIXTURE_CURRENT_CL;
      case "get_workspace_stream":
        return FIXTURE_STREAM;
      case "git_status":
        return FIXTURE_GIT_BRANCH;
      case "get_history":
        return FIXTURE_HISTORY;
      case "get_changelists":
        return fixtureChangelists((arg(args).afterCl as string | null) ?? null);
      case "check_sync_behind":
        return { behind: 3 };
      case "cancel_sync_behind":
        return null;
      case "check_workspace_health":
        return FIXTURE_HEALTH_REPORT;
      // true only while a scripted sync/rollback/git scenario is streaming —
      // the 5s reconcile poll in useSync must not reset a held running state
      case "is_sync_running":
        return harnessController.isScenarioActive();
      case "start_sync":
      case "retry_step": {
        const id = channelArgId(arg(args));
        if (id == null) throw new Error(`fixture: ${cmd} without onEvent channel`);
        return harnessController.beginStart(id, "sync");
      }
      case "start_rollback": {
        const id = channelArgId(arg(args));
        if (id == null) throw new Error("fixture: start_rollback without onEvent channel");
        return harnessController.beginStart(id, "rollback");
      }
      case "git_pull": {
        const id = channelArgId(arg(args));
        if (id == null) throw new Error("fixture: git_pull without onEvent channel");
        return harnessController.beginStart(id, "git");
      }
      // defers the terminal cancel event until releaseCancel() under cancel-hold
      case "stop_sync":
      case "stop_git_pull":
        return harnessController.stopStart();
      case "add_workspace":
        return FIXTURE_ADDED_WORKSPACE;
      case "delete_workspace":
        return null;
      case "switch_workspace": {
        const wanted = workspacesForMode(harnessController.workspacesMode).find(
          (ws) => ws.id === arg(args).id,
        );
        if (!wanted) throw new Error(`fixture: switch_workspace unknown id ${String(arg(args).id)}`);
        return wanted;
      }
      case "update_workspace_settings": {
        const a = arg(args);
        const current = workspacesForMode(harnessController.workspacesMode).find(
          (ws) => ws.id === a.workspaceId,
        );
        if (!current) throw new Error("fixture: update_workspace_settings unknown workspace");
        return {
          ...current,
          parallelThreads: a.parallelThreads as number,
          exclusions: a.exclusions as string[],
          intervalMinutes: a.intervalMinutes as number,
        };
      }
      case "validate_exclusions":
        return [];
      case "set_locale":
        return null;
      case "get_system_locale":
        return "zh-CN";
      case "open_logs_folder":
        return null;
      case "export_log":
        return "D:\\Fixtures\\logs\\sugs-exported.log";
      case "get_log_path":
        return FIXTURE_LOG_PATH;

      // ---- plugin surface (all route through core invoke) ----
      case "plugin:app|version":
        return FIXTURE_APP_VERSION;
      case "plugin:app|name":
        return "simple-unrealgamesync";
      case "plugin:app|tauri_version":
        return "2";
      // plugin-store: load/get_store return the resource id; get returns the
      // [value, exists] tuple keyed on args.key
      case "plugin:store|load":
      case "plugin:store|get_store":
        return 1;
      case "plugin:store|get": {
        switch (arg(args).key) {
          case "app.locale":
            return ["zh", true];
          case "updater.proxy_enabled":
            return [false, true];
          case "updater.proxy_url":
            return ["http://localhost:7897", true];
          default:
            return [null, false];
        }
      }
      case "plugin:store|set":
      case "plugin:store|save":
      case "plugin:store|delete":
      case "plugin:store|has":
        return null;
      // null = no update available — keeps useUpdater idle at boot
      case "plugin:updater|check":
        return null;
      case "plugin:dialog|open":
        return "D:\\Fixture\\Root";
      case "plugin:dialog|ask":
        return false;
      case "plugin:log|log":
        return null;
      case "plugin:autostart|is_enabled":
        return false;
      case "plugin:autostart|enable":
      case "plugin:autostart|disable":
        return null;

      // ---- plugin:window (AppTitleBar adapter, 24-02) — exact command
      // names from @tauri-apps/api/window.js; toggle_maximize is snake_case
      // on the WIRE (the permission identifier is hyphenated
      // allow-toggle-maximize). Drag-region commands (start_dragging /
      // internal_toggle_maximize) need NO entries: drag.js is a Rust-injected
      // init script absent in the harness (24-RESEARCH Q3). ----
      case "plugin:window|minimize":
      case "plugin:window|toggle_maximize":
      case "plugin:window|close":
        recordedWindowCalls.push(cmd);
        return null;

      default:
        throw new Error(`fixture: unmocked command ${cmd}`);
    }
  });
}
