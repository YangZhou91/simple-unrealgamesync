// Phase 23 (23-01, D-02): typed SyncEvent scripts — the canonical scenario
// vocabulary the fixture controller plays over the real Channel wire. Every
// event matches the src/lib/types.ts SyncEvent union exactly; machine step
// tokens come from KNOWN_SUB_STEPS (steps.p4Sync.toCl etc.); all content
// literals are deterministic (T-23-03).
//
// Pure data (no functions) so the spec can inject these into the harness
// page via page.evaluate + window.__HARNESS__.registerScripts.
import type { ScenarioId, ScenarioScript } from "./controller";

/** Rollback's terminal warnings fixture (severity-grouped summary data). */
const ROLLBACK_WARNINGS = [
  {
    severity: "warning" as const,
    path: "//DemoGame/main/DemoGame/Config/DefaultEngine.ini",
    message: "fixture warning: file updated by another changelist",
    count: 2,
  },
];

const FIVE_STEPS: ScenarioScript["prologue"] = [
  { event: "stepStarted", data: { step: "closeUe", description: "fixture: closing UE editors", subStep: "check" } },
  { event: "stepCompleted", data: { step: "closeUe", success: true } },
  { event: "stepStarted", data: { step: "closeExcel", description: "fixture: closing Excel", subStep: "check" } },
  { event: "stepCompleted", data: { step: "closeExcel", success: true } },
  { event: "stepStarted", data: { step: "cleanDevDir", description: "fixture: cleaning Developers", subStep: "clean" } },
  { event: "stepCompleted", data: { step: "cleanDevDir", success: true } },
];

/**
 * Phase 30 (30-05): the canonical deterministic engine-update prologue. Two
 * probes then the real transfer: the `-n` count pass is indeterminate
 * (`total: 0` → the panel renders the count-phase machine-key label), then the
 * real sync streams a determinate `current/total` pair. Every literal is fixed
 * and every depot path is a `//DemoDepot/…` placeholder.
 *
 * NO `bytes*` / `percent` / `phase` field is supplied anywhere: the engine bar
 * is count-driven (UI-SPEC §8.3) and the phase prohibits any fixture byte
 * field, so the deferred FORC-27/28/29 byte bar can never light up from here.
 */
const ENGINE_PROLOGUE: ScenarioScript["prologue"] = [
  { event: "stepStarted", data: { step: "engineUpdate", description: "fixture: counting engine files", subStep: "count" } },
  { event: "progress", data: { current: 0, total: 0, currentFile: "Enumerating files..." } },
  { event: "stepStarted", data: { step: "engineUpdate", description: "fixture: updating engine", subStep: "sync" } },
  {
    event: "progress",
    data: {
      current: 3,
      total: 12,
      currentFile: "//DemoDepot/Demo/UnrealEngine/Engine/Source/Runtime/Core/Core.Build.cs",
    },
  },
  {
    event: "logBatch",
    data: {
      lines: [
        "//DemoDepot/Demo/UnrealEngine/Engine/Source/Runtime/Core/Core.Build.cs#7 - added as",
        "//DemoDepot/Demo/UnrealEngine/Engine/Source/Runtime/Core/Core.h#19 - updated",
      ],
      stream: "stdout",
    },
  },
  {
    event: "logBatch",
    data: {
      lines: [
        "//DemoDepot/Demo/UnrealEngine/Engine/Source/Runtime/Core/Core.cpp#23 - updated",
      ],
      stream: "stdout",
    },
  },
];

/**
 * Canonical scenario scripts (Task 3). Override the controller's minimal
 * built-ins; steps/subSteps limited to the production SyncStep machine
 * (gitPull uses the git machine step; networkCheck/genProject appear as
 * syncFailed step tokens exactly as the Rust pipeline emits them).
 */
export const CANONICAL_SCRIPTS: Partial<Record<ScenarioId, ScenarioScript>> = {
  // All five stepStarted/stepCompleted pairs, a bounded byte-aware progress
  // sequence, two logBatch bursts, terminal syncCompleted at CL 381700.
  "quick-complete": {
    prologue: [
      ...FIVE_STEPS.slice(0, 6),
      { event: "stepStarted", data: { step: "p4Sync", description: "fixture: p4 sync to CL 381700", subStep: "toCl" } },
      {
        event: "logBatch",
        data: {
          lines: [
            "//DemoGame/main/DemoGame/Config/DefaultEngine.ini#12 - added as",
            "//DemoGame/main/DemoGame/Source/DemoGame.Target.cs#7 - updated",
          ],
          stream: "stdout",
        },
      },
      {
        event: "progress",
        data: {
          current: 2,
          total: 12,
          currentFile: "//DemoGame/main/DemoGame/Config/DefaultEngine.ini",
          bytesDone: 1024,
          bytesTotal: 4096,
          bytesRate: 512,
        },
      },
      {
        event: "progress",
        data: {
          current: 8,
          total: 12,
          currentFile: "//DemoGame/main/DemoGame/Source/DemoGameGameModeBase.cpp",
          bytesDone: 3072,
          bytesTotal: 4096,
          bytesRate: 700,
        },
      },
      {
        event: "logBatch",
        data: {
          lines: ["//DemoGame/main/DemoGame/Content/Paks/DemoGame.pak#3 - added as"],
          stream: "stdout",
        },
      },
      { event: "stepCompleted", data: { step: "p4Sync", success: true } },
      { event: "stepStarted", data: { step: "genProject", description: "fixture: GenerateProjectFiles", subStep: "gen" } },
      { event: "stepCompleted", data: { step: "genProject", success: true } },
    ],
    terminal: {
      event: "syncCompleted",
      data: { changelist: "381700", filesSynced: 12, warnings: [] },
    },
  },

  // Advance to p4Sync then stop emitting — no terminal event; the held
  // invoke keeps get_active_operation == "sync" (5s reconcile must not reset it).
  "running-hold": {
    prologue: [
      ...FIVE_STEPS.slice(0, 6),
      { event: "stepStarted", data: { step: "p4Sync", description: "fixture: p4 sync to head", subStep: "all" } },
      {
        event: "progress",
        data: {
          current: 3,
          total: 12,
          currentFile: "//DemoGame/main/DemoGame/Config/DefaultInput.ini",
          bytesDone: 2048,
          bytesTotal: 8192,
          bytesRate: 640,
        },
      },
    ],
  },

  // Stream pauses; terminal syncCancelled is delivered ONLY on releaseCancel().
  "cancel-hold": {
    prologue: [
      ...FIVE_STEPS.slice(0, 6),
      { event: "stepStarted", data: { step: "p4Sync", description: "fixture: p4 sync to CL 381700", subStep: "toCl" } },
      {
        event: "progress",
        data: {
          current: 5,
          total: 12,
          currentFile: "//DemoGame/main/DemoGame/Source/DemoGame.cpp",
          bytesDone: 1536,
          bytesTotal: 4096,
          bytesRate: 480,
        },
      },
    ],
    terminal: { event: "syncCancelled", data: { step: "p4Sync" } },
    deferCancel: true,
  },

  // networkCheck is a real Rust step token outside KNOWN_SUB_STEPS — the
  // ErrorPanel maps it to the restart-the-whole-sync action.
  "network-error": {
    prologue: [
      { event: "stepStarted", data: { step: "closeUe", description: "fixture: closing UE editors", subStep: "check" } },
      { event: "stepCompleted", data: { step: "closeUe", success: true } },
    ],
    terminal: {
      event: "syncFailed",
      data: { step: "networkCheck", error: "fixture: Perforce server unreachable (check VPN)" },
    },
  },

  // Per-step retry semantics: genProject failure offers retry-this-step.
  "step-error": {
    prologue: [
      ...FIVE_STEPS.slice(0, 6),
      { event: "stepStarted", data: { step: "p4Sync", description: "fixture: p4 sync to head", subStep: "all" } },
      { event: "stepCompleted", data: { step: "p4Sync", success: true } },
      { event: "stepStarted", data: { step: "genProject", description: "fixture: GenerateProjectFiles", subStep: "gen" } },
    ],
    terminal: {
      event: "syncFailed",
      data: { step: "genProject", error: "fixture: GenerateProjectFiles.bat exited with code 1" },
    },
  },

  "git-running-hold": {
    prologue: [
      { event: "stepStarted", data: { step: "gitPull", description: "fixture: git pull UnrealEngine", subStep: "run" } },
      { event: "progress", data: { current: 0, total: 0, currentFile: "", percent: 42, phase: "Receiving objects" } },
    ],
  },

  "git-quick-success": {
    prologue: [
      { event: "stepStarted", data: { step: "gitPull", description: "fixture: git pull UnrealEngine", subStep: "run" } },
      { event: "progress", data: { current: 0, total: 0, currentFile: "", percent: 100, phase: "Resolving deltas" } },
      {
        event: "logBatch",
        data: { lines: ["Fast-forward"], stream: "stdout" },
      },
    ],
    terminal: {
      event: "syncCompleted",
      data: { changelist: null, filesSynced: 0, warnings: [] },
    },
  },

  "git-error": {
    prologue: [
      { event: "stepStarted", data: { step: "gitPull", description: "fixture: git pull UnrealEngine", subStep: "run" } },
    ],
    terminal: {
      event: "syncFailed",
      data: { step: "gitPull", error: "fixture: fatal unable to access github.com" },
    },
  },

  // Full five-step stream ending syncCompleted with the warnings fixture.
  "rollback-complete": {
    prologue: [
      ...FIVE_STEPS,
      { event: "stepStarted", data: { step: "p4Sync", description: "fixture: rollback p4 sync to CL 381204", subStep: "toCl" } },
      {
        event: "progress",
        data: {
          current: 156,
          total: 156,
          currentFile: "//DemoGame/main/DemoGame/Content/Paks/DemoGame.pak",
          bytesDone: 65536,
          bytesTotal: 65536,
          bytesRate: 1024,
        },
      },
      { event: "stepCompleted", data: { step: "p4Sync", success: true } },
      { event: "stepStarted", data: { step: "genProject", description: "fixture: GenerateProjectFiles", subStep: "gen" } },
      { event: "stepCompleted", data: { step: "genProject", success: true } },
    ],
    terminal: {
      event: "syncCompleted",
      data: { changelist: "381204", filesSynced: 40, warnings: ROLLBACK_WARNINGS },
    },
  },

  // Phase 30 (30-05): the canonical engine scripts. The engine drains emit
  // `logBatch` (500 lines / 200 ms), not per-line `logLine`, and the terminal
  // CL is fixed at 381234 — the engine subtree's own CL, distinct from the
  // project's Current CL and the sync fixtures' 381700/381204.
  //
  // engine-running-hold: the shared prologue, NO terminal — the held running
  // state the `engine-running` matrix view and the mutual-exclusion step read.
  "engine-running-hold": {
    prologue: [...ENGINE_PROLOGUE],
  },

  // engine-quick-success: full success — a final determinate 12/12 probe, one
  // more log burst, then syncCompleted carrying the engine CL.
  "engine-quick-success": {
    prologue: [
      ...ENGINE_PROLOGUE,
      {
        event: "progress",
        data: {
          current: 12,
          total: 12,
          currentFile: "//DemoDepot/Demo/UnrealEngine/Engine/Source/Runtime/Core/Core.cpp",
        },
      },
      {
        event: "logBatch",
        data: {
          lines: ["//DemoDepot/Demo/UnrealEngine/Engine/Source/Runtime/Core/Core.cpp#23 - updated"],
          stream: "stdout",
        },
      },
    ],
    terminal: {
      event: "syncCompleted",
      data: { changelist: "381234", filesSynced: 12, warnings: [] },
    },
  },

  // engine-error: the count and sync probes, then a lone syncFailed (no prior
  // syncCompleted → the reducer resolves a plain `error`, never `partial`).
  "engine-error": {
    prologue: [
      { event: "stepStarted", data: { step: "engineUpdate", description: "fixture: counting engine files", subStep: "count" } },
      { event: "progress", data: { current: 0, total: 0, currentFile: "Enumerating files..." } },
      { event: "stepStarted", data: { step: "engineUpdate", description: "fixture: updating engine", subStep: "sync" } },
    ],
    terminal: {
      event: "syncFailed",
      data: { step: "engineUpdate", error: "fixture: p4 sync UnrealEngine/Engine/... failed with exit code 1" },
    },
  },

  // engine-partial: the D-03 ordered pair. The engine's real success
  // (syncCompleted with the engine CL) is in the prologue, then the fatal
  // genProject step, then syncFailed{genProject} as the terminal. The reducer
  // sees a prior completion and resolves `partial` — the engine's success is
  // never collapsed into a plain error card.
  "engine-partial": {
    prologue: [
      ...ENGINE_PROLOGUE,
      {
        event: "progress",
        data: {
          current: 12,
          total: 12,
          currentFile: "//DemoDepot/Demo/UnrealEngine/Engine/Source/Runtime/Core/Core.cpp",
        },
      },
      { event: "syncCompleted", data: { changelist: "381234", filesSynced: 12, warnings: [] } },
      { event: "stepStarted", data: { step: "genProject", description: "fixture: GenerateProjectFiles", subStep: "gen" } },
    ],
    terminal: {
      event: "syncFailed",
      data: { step: "genProject", error: "GenerateProjectFiles.bat not found" },
    },
  },

  // engine-cancel-hold: the terminal syncCancelled is deferred until
  // releaseCancel() — the in-place cancel-pending handshake (the engine variant
  // of `cancel-hold`).
  "engine-cancel-hold": {
    prologue: [...ENGINE_PROLOGUE],
    terminal: { event: "syncCancelled", data: { step: "engineUpdate" } },
    deferCancel: true,
  },
};
