// Phase 23 (23-01, D-02): typed fixture controller — the test-side analogue
// of the canonical preview's `previewControls` surface (state object +
// change hooks), driving the PRODUCTION useSync/useGit/useHistory state
// machines over the real Channel wire (`window.__TAURI_INTERNALS__.
// runCallback(id, { message, index })`), never a parallel demo state machine.
//
// TEST-ONLY: nothing under src/ may import this file. Plain TS state — no
// state library (project constraint).
import type { SyncEvent } from "@/lib/types";
import { workspacesForMode, type WorkspaceConfig } from "./workspaces";

/** Scripted scenario ids — the canonical interaction vocabulary. */
export type ScenarioId =
  | "quick-complete"
  | "running-hold"
  | "cancel-hold"
  | "network-error"
  | "step-error"
  | "git-running-hold"
  | "git-quick-success"
  | "git-error"
  | "rollback-complete";

/** Which start command opened the channel being scripted. */
export type StartKind = "sync" | "rollback" | "git";

/**
 * Canonical view union mirroring the preview's view names (ugs-code-preview-
 * check.html select options). The harness never renders these directly —
 * scenarios drive production hooks whose projections correspond to them
 * (e.g. canonical "completed" === production idle + lastSyncResult).
 */
export type CanonicalView =
  | "idle"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "error"
  | "network-error"
  | "git-running"
  | "git-success"
  | "git-error"
  | "rollback";

/** Fixture workspace seeding mode (?workspaces=default|empty|long). */
export type WorkspacesMode = "default" | "empty" | "long";

type TerminalEvent = Extract<
  SyncEvent,
  { event: "syncCompleted" | "syncFailed" | "syncCancelled" }
>;

/**
 * A scenario script: events emitted when the start command arrives, plus an
 * optional terminal event. Absent terminal (or deferCancel) keeps the invoke
 * promise pending — the held running state the 5s is_sync_running reconcile
 * in useSync must NOT reset.
 */
export interface ScenarioScript {
  prologue: SyncEvent[];
  terminal?: TerminalEvent;
  /** cancel-hold: terminal is delivered only when releaseCancel() fires. */
  deferCancel?: boolean;
}

interface PendingStart {
  channelId: number;
  kind: StartKind;
  scenario: ScenarioId;
  script: ScenarioScript;
  resolve: () => void;
}

function defaultScenarioFor(kind: StartKind): ScenarioId {
  switch (kind) {
    case "git":
      return "git-quick-success";
    case "rollback":
      return "rollback-complete";
    default:
      return "quick-complete";
  }
}

/**
 * Minimal built-in scripts. Plan 23-01 Task 3's events.ts registers the full
 * canonical typed scripts over these via registerScripts() (injected from the
 * spec through window.__HARNESS__), so this file needs no Task-3 edits.
 */
const BUILTIN_SCRIPTS: Record<ScenarioId, ScenarioScript> = {
  "quick-complete": {
    prologue: [{ event: "stepStarted", data: { step: "p4Sync", description: "fixture sync", subStep: "all" } }],
    terminal: { event: "syncCompleted", data: { changelist: "381700", filesSynced: 12, warnings: [] } },
  },
  "running-hold": {
    prologue: [{ event: "stepStarted", data: { step: "p4Sync", description: "fixture sync", subStep: "all" } }],
  },
  "cancel-hold": {
    prologue: [{ event: "stepStarted", data: { step: "p4Sync", description: "fixture sync", subStep: "all" } }],
    terminal: { event: "syncCancelled", data: { step: "p4Sync" } },
    deferCancel: true,
  },
  "network-error": {
    prologue: [],
    terminal: { event: "syncFailed", data: { step: "networkCheck", error: "fixture: network check failed" } },
  },
  "step-error": {
    prologue: [],
    terminal: { event: "syncFailed", data: { step: "genProject", error: "fixture: GenerateProjectFiles failed" } },
  },
  "git-running-hold": {
    prologue: [{ event: "stepStarted", data: { step: "gitPull", description: "fixture git pull", subStep: "run" } }],
  },
  "git-quick-success": {
    prologue: [],
    terminal: { event: "syncCompleted", data: { changelist: null, filesSynced: 0, warnings: [] } },
  },
  "git-error": {
    prologue: [],
    terminal: { event: "syncFailed", data: { step: "gitPull", error: "fixture: git pull failed" } },
  },
  "rollback-complete": {
    prologue: [],
    terminal: { event: "syncCompleted", data: { changelist: "381204", filesSynced: 40, warnings: [] } },
  },
};

interface HarnessInternals {
  __TAURI_INTERNALS__?: {
    runCallback?: (id: number, data: { message: unknown; index: number }) => void;
  };
}

/**
 * The fixture controller. One instance per harness page (created by
 * tests/visual/main.tsx). Owns:
 *   - the scenario selected for the NEXT start-type invoke (setNextScenario)
 *   - per-channel monotonically increasing index counters (Channel queues
 *     out-of-order messages — Pitfall 2)
 *   - pending-invoke bookkeeping: start-type invokes resolve ONLY after the
 *     terminal SyncEvent is delivered, so useSync's authoritative-completion
 *     reconcile never fires early
 *   - the cancel-hold handshake (releaseCancel)
 */
export class FixtureController {
  #scripts: Record<ScenarioId, ScenarioScript> = { ...BUILTIN_SCRIPTS };
  #nextScenario: ScenarioId | null = null;
  #activeScenario: ScenarioId | null = null;
  #workspacesMode: WorkspacesMode = "default";
  #channelIndex = new Map<number, number>();
  #pending: PendingStart | null = null;
  #stopResolve: (() => void) | null = null;

  /** Fixture workspaces for the current mode (mocked get_workspaces). */
  workspaces(): WorkspaceConfig[] {
    return workspacesForMode(this.#workspacesMode);
  }

  setWorkspacesMode(mode: WorkspacesMode): void {
    this.#workspacesMode = mode;
  }

  get workspacesMode(): WorkspacesMode {
    return this.#workspacesMode;
  }

  /** Selects the scenario for the next start-type invoke (one-shot). */
  setNextScenario(id: ScenarioId): void {
    this.#nextScenario = id;
  }

  /**
   * Merge canonical scripts over the built-ins. Called from the spec side via
   * window.__HARNESS__.registerScripts (scripts are plain JSON-able data).
   */
  registerScripts(scripts: Partial<Record<ScenarioId, ScenarioScript>>): void {
    this.#scripts = { ...this.#scripts, ...scripts };
  }

  /** True while a scripted start invoke is streaming (mocked is_sync_running). */
  isScenarioActive(): boolean {
    return this.#pending !== null;
  }

  /** Per-channel sequential index — Channel orders strictly by index. */
  emitOnChannel(channelId: number, event: SyncEvent): void {
    const index = this.#channelIndex.get(channelId) ?? 0;
    this.#channelIndex.set(channelId, index + 1);
    const internals = (window as unknown as HarnessInternals).__TAURI_INTERNALS__;
    if (!internals?.runCallback) {
      throw new Error("fixture: __TAURI_INTERNALS__.runCallback missing — install mocks first");
    }
    internals.runCallback(channelId, { message: event, index });
  }

  /**
   * Handle a start-type invoke (start_sync / retry_step / start_rollback /
   * git_pull). Emits the scenario script on the captured channel and returns
   * a promise that resolves ONLY after the terminal event is delivered (or
   * stays pending forever for hold scenarios).
   */
  beginStart(channelId: number, kind: StartKind): Promise<void> {
    const scenario = this.#nextScenario ?? defaultScenarioFor(kind);
    this.#nextScenario = null;
    const script = this.#scripts[scenario] ?? this.#scripts[defaultScenarioFor(kind)];
    const entry: PendingStart = {
      channelId,
      kind,
      scenario,
      script,
      resolve: () => {},
    };
    this.#activeScenario = scenario;
    this.#pending = entry;
    const invoke = new Promise<void>((resolve) => {
      entry.resolve = resolve;
    });
    for (const event of script.prologue) {
      this.emitOnChannel(channelId, event);
    }
    if (script.terminal && !script.deferCancel) {
      this.#finishPending();
    }
    return invoke;
  }

  /**
   * Handle stop_sync / stop_git_pull. For the cancel-hold scenario the mocked
   * stop also pends until releaseCancel() — the cancel button stays in its
   * disabled "cancelling" state until the fixture backend "acknowledges".
   */
  stopStart(): Promise<void> {
    if (this.#pending?.script.deferCancel) {
      return new Promise<void>((resolve) => {
        this.#stopResolve = resolve;
      });
    }
    return Promise.resolve();
  }

  /** Cancel-hold handshake: deliver the terminal cancel event + resolve. */
  releaseCancel(): void {
    if (this.#pending?.script.deferCancel) {
      this.#finishPending();
    }
    this.#stopResolve?.();
    this.#stopResolve = null;
  }

  #finishPending(): void {
    const entry = this.#pending;
    if (!entry) return;
    if (entry.script.terminal) {
      this.emitOnChannel(entry.channelId, entry.script.terminal);
    }
    this.#pending = null;
    this.#activeScenario = null;
    entry.resolve();
  }

  /** Snapshot for assertions/debugging through window.__HARNESS__.state. */
  snapshot(): {
    scenario: ScenarioId | null;
    workspacesMode: WorkspacesMode;
    active: boolean;
  } {
    return {
      scenario: this.#activeScenario,
      workspacesMode: this.#workspacesMode,
      active: this.isScenarioActive(),
    };
  }
}

/** The singleton used by tests/visual/main.tsx. */
export const harnessController = new FixtureController();
