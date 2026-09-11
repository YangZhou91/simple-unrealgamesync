// Phase 23 (23-02, CONTRACT-02): matrix/focused-state navigation helpers.
// These drive the PRODUCTION UI through real interactions — every view maps
// onto hook-level state (syncState/lastSyncResult/gitState) reached via real
// UI actions with pre-selected controller scenarios. Never a parallel render
// branch (SYNC-04 pre-compliance).
//
// Reused by Plan 23-03's visual captures — keep the surface stable.
import { expect, type Page } from "@playwright/test";
import zh from "../../../src/lib/i18n/locales/zh";
import en from "../../../src/lib/i18n/locales/en";
import { CANONICAL_SCRIPTS } from "../fixtures/events";
import { FIXTURE_WORKSPACE_DEV } from "../fixtures/workspaces";

/** Dictionary lookup with makeT-compatible {token} interpolation. */
function makeT(dict: Record<string, string>) {
  return (
    key: keyof typeof zh,
    params?: Record<string, string | number>,
  ): string => {
    let str: string = dict[key];
    if (params) {
      for (const [token, value] of Object.entries(params)) {
        str = str.split(`{${token}}`).join(String(value));
      }
    }
    return str;
  };
}

export const tZh = makeT(zh as unknown as Record<string, string>);
export const tEn = makeT(en as unknown as Record<string, string>);

/**
 * The two harness locales (29-01, PAR-01/D-02). zh is the DEFAULT for every
 * helper below — all pre-existing call sites stay behaviorally byte-identical;
 * the en dimension is threaded explicitly by the 29-01 geometry/interaction
 * parametrization.
 */
export type HarnessLocale = "zh" | "en";

/** Resolve the dictionary lookup for a locale (identical makeT semantics). */
function dictFor(locale: HarnessLocale) {
  return locale === "en" ? tEn : tZh;
}

/** The 9 matrix surfaces (CONTRACT-02: 9 surfaces x 2 themes x 4 widths = 72). */
export type MatrixView =
  | "idle"
  | "running"
  | "completed"
  | "error"
  | "git-running"
  | "git-error"
  | "history"
  | "health"
  | "settings";

/** Harness URL params — locale + workspaces seeding (23-01 entry contract). */
export interface HarnessOptions {
  locale?: "zh" | "en";
  workspaces?: "default" | "empty" | "long";
}

/** Open the harness page with URL-param seeding (?locale, ?workspaces). */
export async function gotoHarness(
  page: Page,
  opts: HarnessOptions = {},
): Promise<void> {
  const params = new URLSearchParams();
  params.set("locale", opts.locale ?? "zh");
  params.set("workspaces", opts.workspaces ?? "default");
  await page.goto(`/tests/visual/harness.html?${params.toString()}`);
  // Inject the canonical typed scenario scripts (canonical log/progress
  // density) over the controller's minimal built-ins — same registerScripts
  // seam interaction.spec.ts uses (23-01 Task 3 pattern).
  await page.evaluate(
    (scripts) =>
      (
        window as unknown as {
          __HARNESS__: { registerScripts: (s: unknown) => void };
        }
      ).__HARNESS__.registerScripts(scripts),
    CANONICAL_SCRIPTS as unknown as Record<string, unknown>,
  );
  // Select the fixture workspace — production useWorkspaces boots with
  // selectedId null and requires an explicit sidebar selection. Empty mode
  // renders WorkspaceEmptyState instead (nothing to select) — wait for its
  // heading so React's async mount completes before the caller measures.
  // The heading is DICTIONARY COPY — resolve it for the active locale so the
  // en no-workspace focused row boots (29-01 Task 1).
  if (opts.workspaces === "empty") {
    const tEmpty = dictFor(opts.locale ?? "zh");
    await expect(page.getByText(tEmpty("workspace.empty.title"))).toBeVisible();
    return;
  }
  const workspaceItem = page.getByRole("button", {
    name: new RegExp(`^${FIXTURE_WORKSPACE_DEV.name}`),
  });
  await workspaceItem.click();
  // Wait until the selection's boot command chain has fed the dashboard.
  // The dashboard h1 (workspace name, truncate) is width-independent: at
  // narrow widths the idle panel's "ready" h2 squeezes to width 0 (a
  // genuine pre-migration finding recorded in the report), and the sidebar
  // CL badge can clip — the h1 stays measurable at all four contract widths.
  await expect(
    page.getByRole("heading", {
      name: FIXTURE_WORKSPACE_DEV.name,
      level: 1,
    }),
  ).toBeVisible();
}

/** Emulate the color scheme (dark | light) — canonical checker pattern. */
export async function setTheme(
  page: Page,
  theme: "dark" | "light",
): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
}

/** The four contract widths at the canonical matrix height 1300. */
export const MATRIX_WIDTHS = [1056, 768, 392, 352] as const;
export type MatrixWidth = (typeof MATRIX_WIDTHS)[number];
export const MATRIX_HEIGHT = 1300;

/** Resize to a contract width at the canonical matrix height. */
export async function setViewportSize(
  page: Page,
  width: MatrixWidth,
): Promise<void> {
  await page.setViewportSize({ width, height: MATRIX_HEIGHT });
}

/** Switch the dashboard tab (sync | history | health). */
export async function switchTab(
  page: Page,
  tab: "sync" | "history" | "health",
  locale: HarnessLocale = "zh",
): Promise<void> {
  const t = dictFor(locale);
  const key = { sync: "sync.tab.sync", history: "sync.tab.history", health: "sync.tab.health" }[
    tab
  ] as keyof typeof zh;
  await page.getByRole("tab", { name: t(key) }).click();
}

/** Open the Settings dialog via the sidebar Settings affordance. */
export async function openSettingsDialog(
  page: Page,
  locale: HarnessLocale = "zh",
): Promise<void> {
  const t = dictFor(locale);
  await page
    .getByRole("button", { name: t("workspace.sidebar.settingsAria"), exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/**
 * Switch Settings onto the App scope. Scope controls are native buttons with
 * aria-pressed (D-06) — never role=tab (that is dashboard switchTab).
 *
 * Playwright's AX tree exposes pressed=true but omits pressed=false, so the
 * unpressed predicate is aria-pressed="false" rather than { pressed: false }.
 */
export async function openSettingsAppTab(
  page: Page,
  locale: HarnessLocale = "zh",
): Promise<void> {
  const t = dictFor(locale);
  const appTab = page.getByRole("button", { name: t("settings.tab.app") });
  await expect(appTab).toHaveAttribute("aria-pressed", "false");
  await appTab.click();
  await expect(
    page.getByRole("button", { name: t("settings.tab.app"), pressed: true }),
  ).toBeVisible();
}

/** Open the Add-Workspace form dialog via the sidebar affordance. */
export async function openAddWorkspaceDialog(
  page: Page,
  locale: HarnessLocale = "zh",
): Promise<void> {
  const t = dictFor(locale);
  await page.getByRole("button", { name: t("workspace.sidebar.add") }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: t("workspace.form.title") }),
  ).toBeVisible();
}

/** Close the topmost dialog with Escape. */
export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
}

async function setNextScenario(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (scenario) =>
      (
        window as unknown as {
          __HARNESS__: { setNextScenario: (s: string) => void };
        }
      ).__HARNESS__.setNextScenario(scenario),
    id,
  );
}

/**
 * Drive one of the 9 matrix surfaces via REAL UI actions onto hook-level
 * states (never a parallel render branch):
 *   idle        — ensured: no operation running, CL field empty
 *   running     — Start with the "running-hold" scenario (held running state)
 *   completed   — Start with "quick-complete" (terminal syncCompleted → idle
 *                 + lastSyncResult = the canonical "completed" projection)
 *   error       — Start with "network-error" (syncState error + errorInfo)
 *   git-running — Git Pull with "git-running-hold" (gitState running)
 *   git-error   — Git Pull with "git-error" (gitState error)
 *   history     — switchTab history
 *   health      — switchTab health (pre-Audit empty state)
 *   settings    — open the Settings dialog (Radix portal)
 */
export async function setView(
  page: Page,
  view: MatrixView,
  locale: HarnessLocale = "zh",
): Promise<void> {
  const t = dictFor(locale);
  switch (view) {
    case "idle": {
      // Ensure no operation is in flight and the CL field is empty — the
      // pristine idle surface. The "ready" h2 squeezes to width 0 at 392/352
      // (pre-migration narrow-width reality, report row idle-*-392/352), so
      // presence is checked on the start button instead — always visible.
      await switchTab(page, "sync", locale);
      await expect(
        page.getByRole("button", { name: t("sync.start") }),
      ).toBeVisible();
      const clInput = page.locator("#target-changelist");
      if ((await clInput.inputValue()) !== "") {
        await clInput.fill("");
      }
      return;
    }
    case "running": {
      await switchTab(page, "sync", locale);
      await setNextScenario(page, "running-hold");
      await page
        .getByRole("button", { name: t("sync.start") })
        .click();
      await expect(
        page.getByRole("button", { name: t("sync.cancel") }),
      ).toBeVisible();
      return;
    }
    case "completed": {
      await switchTab(page, "sync", locale);
      await setNextScenario(page, "quick-complete");
      const startButton = page.getByRole("button", { name: t("sync.start") });
      await startButton.click();
      // Terminal syncCompleted at CL 381700 → idle + lastSyncResult. The
      // last-sync card's h3/line squeeze to width 0 at 392/352 (pre-migration
      // narrow-width reality); the width-independent terminal signal is the
      // Start button re-enabling (disabled while isBusy, enabled at idle).
      await expect(startButton).toBeEnabled();
      return;
    }
    case "error": {
      await switchTab(page, "sync", locale);
      await setNextScenario(page, "network-error");
      await page
        .getByRole("button", { name: t("sync.start") })
        .click();
      await expect(
        page.getByRole("button", { name: t("sync.error.restart") }),
      ).toBeVisible();
      return;
    }
    case "git-running": {
      await switchTab(page, "sync", locale);
      await setNextScenario(page, "git-running-hold");
      await page
        .getByRole("button", { name: t("sync.git.pull") })
        .click();
      await expect(
        page.getByRole("button", { name: t("sync.git.cancel") }),
      ).toBeVisible();
      return;
    }
    case "git-error": {
      await switchTab(page, "sync", locale);
      await setNextScenario(page, "git-error");
      await page
        .getByRole("button", { name: t("sync.git.pull") })
        .click();
      await expect(
        page.getByRole("button", { name: t("sync.git.back") }),
      ).toBeVisible();
      return;
    }
    case "history": {
      await switchTab(page, "history", locale);
      // First history row is visible — the table rendered.
      await expect(
        page.getByText(t("history.clBadge", { cl: "381699" })),
      ).toBeVisible();
      return;
    }
    case "health": {
      await switchTab(page, "health", locale);
      await expect(page.getByText(t("sync.health.emptyHint"))).toBeVisible();
      return;
    }
    case "settings": {
      await openSettingsDialog(page, locale);
      return;
    }
  }
}
