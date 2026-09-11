// Phase 23 (23-01, D-02/T-23-03): deterministic workspace/CL/history/changelog
// and health literals for the visual harness. TEST-ONLY — nothing under src/
// may import this file, and nothing here may contain real credentials, real
// user paths, or machine-identifying strings. CLs 381700 / 381204 exist ONLY
// here as test data (canonical fixture CLs, T-23-05).
//
// Type-only imports from production keep the wire shapes honest without any
// runtime dependency on src/.
import type {
  ChangelistEntry,
  GitBranchInfo,
  HistoryRecord,
  WorkspaceConfig,
  WorkspaceHealthReport,
} from "@/lib/types";

// Re-export so test-tree consumers can keep importing the production wire
// type from one place (controller.ts consumed this via `type WorkspaceConfig`
// before 23-03's tsconfig.visual.json type coverage made the missing export
// a compile error).
export type { WorkspaceConfig };

/** Workspace A — the default selectable fixture. */
export const FIXTURE_WORKSPACE_DEV: WorkspaceConfig = {
  id: "ws-fixture-dev",
  name: "DemoGame 开发区",
  projectDir: "DemoGame",
  rootPath: "D:\\Fixtures\\DemoGame-Dev",
  p4Client: "fixture-dev-client",
  p4User: "fixture_user",
  lastSyncCl: "381699",
  lastSyncTime: "2026-09-08 09:00:00",
  lastSyncFileCount: 8,
  parallelThreads: 8,
  exclusions: [],
  intervalMinutes: 60,
};

/**
 * Workspace B — deliberately long CJK+Latin name for the long-name-at-352
 * focused case (CONTRACT-02 focused list, exercised by Plan 03).
 */
export const FIXTURE_WORKSPACE_LONG: WorkspaceConfig = {
  id: "ws-fixture-long",
  name: "DemoGame 发布候选区 Release Candidate With A Very Long Mixed Name",
  projectDir: "DemoGame",
  rootPath: "D:\\Fixtures\\DemoGame-LongName",
  p4Client: "fixture-long-client",
  p4User: "fixture_user",
  lastSyncCl: "381204",
  lastSyncTime: "2026-09-05 16:45:00",
  lastSyncFileCount: 156,
  parallelThreads: 4,
  exclusions: [],
  intervalMinutes: 120,
};

/** Selected workspace's current CL (mirrors the production get_current_cl). */
export const FIXTURE_CURRENT_CL = "381699";

/** p4 stream bound to the fixture client (dashboard header + health report). */
export const FIXTURE_STREAM = "//DemoGame/main-DemoGame-Release";

/** Deterministic git status for the UnrealEngine repo card. */
export const FIXTURE_GIT_BRANCH: GitBranchInfo = {
  branch: "main",
  ahead: 0,
  behind: 2,
  remote: "origin",
  short_hash: "a1b2c3d",
  is_detached: false,
};

/** Locale-neutral history literals (production format "YYYY-MM-DD HH:MM:SS"). */
export const FIXTURE_HISTORY: HistoryRecord[] = [
  {
    changelist: "381699",
    timestamp: "2026-09-08 10:00:00",
    fileCount: 8,
    workspaceId: "ws-fixture-dev",
    durationMs: 45_000,
  },
  {
    changelist: "381450",
    timestamp: "2026-09-07 18:30:00",
    fileCount: 34,
    workspaceId: "ws-fixture-dev",
    durationMs: 120_000,
  },
  {
    changelist: "381204",
    timestamp: "2026-09-06 09:15:00",
    fileCount: 156,
    workspaceId: "ws-fixture-dev",
    durationMs: 600_000,
  },
];

/**
 * Changelist list for the rollback dialog. Page 1 (25 entries) deliberately
 * contains 381700, 381699 AND 381204 — the canonical interaction selects
 * 381204 without infinite-scroll paging, so it must be in the first batch.
 * Numbers are non-contiguous on purpose (a real p4 shortlog has gaps);
 * every field is a deterministic literal.
 */
const PAGE1_NUMBERS: string[] = [
  "381700",
  "381699",
  "381204",
  "381698",
  "381697",
  "381696",
  "381695",
  "381694",
  "381693",
  "381692",
  "381691",
  "381690",
  "381689",
  "381688",
  "381687",
  "381686",
  "381685",
  "381684",
  "381683",
  "381682",
  "381681",
  "381680",
  "381679",
  "381678",
  "381677",
];

function changelistEntry(number: string, description: string): ChangelistEntry {
  return {
    number,
    date: "2026-09-08",
    user: "fixture_user",
    client: "fixture-dev-client",
    description,
  };
}

/** First 25-entry batch returned by the mocked get_changelists. */
export const FIXTURE_CHANGELISTS_PAGE1: ChangelistEntry[] = PAGE1_NUMBERS.map(
  (n) => changelistEntry(n, `Fixture changelist ${n} — deterministic description`),
);

/** Second batch — returned after any afterCl below 381203; small and finite. */
export const FIXTURE_CHANGELISTS_PAGE2: ChangelistEntry[] = [
  changelistEntry("381202", "Fixture changelist 381202 — deterministic description"),
  changelistEntry("381201", "Fixture changelist 381201 — deterministic description"),
];

/** Workspace returned by the mocked add_workspace. */
export const FIXTURE_ADDED_WORKSPACE: WorkspaceConfig = {
  id: "ws-fixture-added",
  name: "DemoGame 新增区",
  projectDir: "DemoGame",
  rootPath: "D:\\Fixture\\Root",
  p4Client: "fixture-added-client",
  p4User: "fixture_user",
  lastSyncCl: null,
  lastSyncTime: null,
  lastSyncFileCount: null,
  parallelThreads: 4,
  exclusions: [],
  intervalMinutes: 60,
};

/**
 * Read-only workspace-health report (missing-on-disk 2 paths, differs 1 path)
 * for the on-demand audit assertion.
 */
export const FIXTURE_HEALTH_REPORT: WorkspaceHealthReport = {
  categories: [
    {
      category: "missing-on-disk",
      count: 2,
      paths: [
        "D:\\Fixtures\\DemoGame-Dev\\DemoGame\\Config\\DefaultEngine.ini",
        "D:\\Fixtures\\DemoGame-Dev\\DemoGame\\Source\\DemoGame.Target.cs",
      ],
    },
    {
      category: "differs",
      count: 1,
      paths: ["D:\\Fixtures\\DemoGame-Dev\\DemoGame\\DemoGame.uproject"],
    },
  ],
  stream: FIXTURE_STREAM,
};

/** Workspace list per harness workspaces mode (?workspaces=default|empty|long). */
export function workspacesForMode(
  mode: "default" | "empty" | "long",
): WorkspaceConfig[] {
  switch (mode) {
    case "empty":
      return [];
    case "long":
      return [FIXTURE_WORKSPACE_DEV, FIXTURE_WORKSPACE_LONG];
    default:
      return [FIXTURE_WORKSPACE_DEV];
  }
}
