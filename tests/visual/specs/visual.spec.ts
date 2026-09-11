// Phase 23 (23-03, CONTRACT-03 / D-04): the pixel layer — the ONLY spec file
// in the tree containing toHaveScreenshot calls. Baseline goldens live under
// the tracked tests/visual/baselines/ tree (snapshotPathTemplate in
// playwright.config.ts), generated on the maintainer's pinned
// Windows/Chromium(headless-shell @playwright/test 1.63.0)/Segoe UI machine.
//
// D-04 separation, both directions:
//   - interaction.spec.ts / geometry.spec.ts contain ZERO toHaveScreenshot
//     calls — `--update-snapshots` cannot touch them, so approving pixels
//     can never green a behavior or geometry failure.
//   - Conversely a red pixel can never be waived by a green geometry run —
//     different files, different assertion kinds.
//
// The 11 captures mirror the canonical capture set (ugs-code-*.png) by name
// and state: idle / target / running / history / rollback / health /
// settings / app-settings / add / light / narrow. State setup reuses the
// same navigation helpers + setView states the geometry matrix measures —
// same states, then toHaveScreenshot instead of the bounds walk.
//
// Determinism (engineered, per D-04):
//   - harness mode stubs virtual:changelog (23-01)
//   - config-level timezoneId pins Intl.DateTimeFormat output
//   - the last-sync timestamp <time> region (epochMs = Date.now() at the
//     terminal event — the ONLY runtime-clock text) is MASKED in every
//     capture whose state can render it
//   - every other visible value is a fixture literal (behind badge counts,
//     progress bytes, history rows parse from locale-neutral literals)
//   - toHaveScreenshot defaults kept (animations disabled, caret hidden)
//
// Pre-migration context: these captures record the CURRENT (pre-Phase-24)
// UI. Geometry-known-red combos (see reports/PRE-MIGRATION-GEOMETRY.md)
// still capture here — geometry red does not block pixel capture; the
// baselines are the "before" record the migration phases will flip.
import { test, expect, type Page } from "@playwright/test";
import {
  gotoHarness,
  openSettingsAppTab,
  setTheme,
  setViewportSize,
  setView,
  switchTab,
  tZh,
} from "../helpers/navigation";

/**
 * Locator for the last-sync timestamp region — IdlePanel's
 * `formatTimestamp(lastSyncResult.epochMs, locale)` <time> element. The
 * epochMs comes from Date.now() at the terminal event, so its rendered text
 * varies per run; the mask covers exactly this element. (For the "cancelled"
 * status the element renders a dictionary label instead — masking is a
 * no-op there.)
 */
function lastSyncTimeLocator(page: Page) {
  // The <time> element lives inside the last-sync card (h3 title
  // 最近项目同步). Scope by tag name — IdlePanel renders exactly one
  // <time> element.
  return page.locator("#root time");
}

/** Wait one animation frame so the render settles before the capture. */
async function settleFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      ),
  );
}

test.describe("canonical captures (dark 1056)", () => {
  test("capture: idle", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    await setView(page, "idle");
    await settleFrame(page);
    await expect(page).toHaveScreenshot("idle.png", {
      mask: [lastSyncTimeLocator(page)],
    });
  });

  test("capture: target", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    // CL 381700 + engine checked — the canonical target surface (mirrors
    // geometry.spec.ts's focused target+engine state at 1056).
    const clInput = page.locator("#target-changelist");
    await clInput.fill("381700");
    const engineCheckbox = page.getByLabel(tZh("sync.engine.checkbox"), {
      exact: true,
    });
    await expect(engineCheckbox).toBeVisible();
    await engineCheckbox.check();
    await expect(page.getByText(tZh("sync.engine.hintOn"))).toBeVisible();
    await settleFrame(page);
    await expect(page).toHaveScreenshot("target.png", {
      mask: [lastSyncTimeLocator(page)],
    });
  });

  test("capture: running", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    // running-hold with the canonical script's fixed fixture progress/log
    // literals (gotoHarness injects CANONICAL_SCRIPTS — byte counts, file
    // paths and log lines are deterministic literals).
    await setView(page, "running");
    // One extra frame: the determinate progress indicator is a contained
    // width-based fill (clamped [0,100], width-only transition). Disabling
    // animations (toHaveScreenshot default) freezes CSS transitions at
    // capture, and the fixture's byte progress (2048/8192, 25%) is a
    // literal — the bar position is stable across runs.
    await settleFrame(page);
    await expect(page).toHaveScreenshot("running.png");
  });

  test("capture: git-running", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    // git-running-hold: deterministic fixture progress (42% Receiving objects)
    // and log literals via CANONICAL_SCRIPTS injected by gotoHarness.
    await setView(page, "git-running");
    await settleFrame(page);
    await expect(page).toHaveScreenshot("git-running.png");
  });

  test("capture: history", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    await setView(page, "history");
    await settleFrame(page);
    await expect(page).toHaveScreenshot("history.png", {
      // History rows format locale-neutral timestamp literals through
      // Intl.DateTimeFormat — pinned timezoneId makes them identical every
      // run; no mask needed. Mask kept OFF to keep the rows reviewable.
    });
  });

  test("capture: rollback", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    // Rollback dialog, fixture CL 381204 selected, confirmation stage —
    // mirrors geometry.spec.ts's focused rollback-confirm state.
    await page.getByRole("tab", { name: tZh("sync.tab.history") }).click();
    await page
      .getByRole("button", { name: tZh("history.rollback") })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByText(tZh("history.clBadge", { cl: "381204" })).click();
    const rollbackGo = dialog.getByRole("button", {
      name: tZh("history.rollback.toCl", { cl: "381204" }),
    });
    await expect(rollbackGo).toBeEnabled();
    await rollbackGo.click();
    await expect(
      dialog.getByText(tZh("history.rollback.confirmTitle")),
    ).toBeVisible();
    await settleFrame(page);
    await expect(page).toHaveScreenshot("rollback.png");
  });

  test("capture: health", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    // Post-Audit report (on-demand): the empty hint first, then Audit, then
    // the fixture report renders.
    await switchTab(page, "health");
    await expect(page.getByText(tZh("sync.health.emptyHint"))).toBeVisible();
    await page
      .getByRole("button", { name: tZh("sync.health.audit"), exact: true })
      .click();
    await expect(page.getByText(tZh("sync.health.missingOnDisk"))).toBeVisible();
    await settleFrame(page);
    await expect(page).toHaveScreenshot("health.png");
  });

  test("capture: settings", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    // Workspace-default Settings (D-06): threads / interval / exclusions.
    // Do not click the App tab here — that is capture: app-settings.
    await setView(page, "settings");
    await settleFrame(page);
    await expect(page).toHaveScreenshot("settings.png");
  });

  test("capture: app-settings", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    await setView(page, "settings");
    // App tab first, then proxy ENABLED — mirrors geometry.spec.ts's
    // focused app-settings-proxy-on (D-06 / D-07).
    await openSettingsAppTab(page);
    const proxyToggle = page.getByLabel(tZh("settings.network.enable"), {
      exact: true,
    });
    await proxyToggle.check();
    const proxyUrlInput = page.getByLabel(tZh("settings.network.urlAria"), {
      exact: true,
    });
    await expect(proxyUrlInput).toBeEnabled();
    await settleFrame(page);
    await expect(page).toHaveScreenshot("app-settings.png");
  });

  test("capture: add", async ({ page }) => {
    await setTheme(page, "dark");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    // Add-workspace form dialog (Radix portal).
    await page
      .getByRole("button", { name: tZh("workspace.sidebar.add") })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: tZh("workspace.form.title") }),
    ).toBeVisible();
    await settleFrame(page);
    await expect(page).toHaveScreenshot("add.png");
  });
});

test.describe("canonical captures (theme/width variants)", () => {
  test("capture: light (light scheme idle at 1056)", async ({ page }) => {
    // Pre-Phase-24 this intentionally records the CURRENT dark-token render
    // under a light color scheme — the pixel record of "before" the Phase 24
    // semantic token migration. Expect it to be visually dark until SHELL-01
    // lands; the baseline flips deliberately then (documented update
    // process, tests/visual/README.md).
    await setTheme(page, "light");
    await setViewportSize(page, 1056);
    await gotoHarness(page);
    await setView(page, "idle");
    await settleFrame(page);
    await expect(page).toHaveScreenshot("light.png", {
      mask: [lastSyncTimeLocator(page)],
    });
  });

  test("capture: narrow (dark idle at 392)", async ({ page }) => {
    // Dark idle at 392 — the narrow-canvas canonical capture. Pre-Phase-24
    // the current UI overflows here (minWidth 800 design); the baseline is
    // the pre-migration record (see reports/PRE-MIGRATION-GEOMETRY.md rows
    // idle-dark-392, owned by Phase 24).
    await setTheme(page, "dark");
    await setViewportSize(page, 392);
    await gotoHarness(page);
    await setView(page, "idle");
    await settleFrame(page);
    await expect(page).toHaveScreenshot("narrow.png", {
      mask: [lastSyncTimeLocator(page)],
    });
  });
});
