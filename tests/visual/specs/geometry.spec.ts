// Phase 23 (23-02, CONTRACT-02) → Phase 29 (29-01, PAR-01): the geometry
// matrix — the ported canonical measure() oracle (helpers/measure.ts) swept
// across 72 combinations (9 surfaces x dark/light x 1056/768/392/352, height
// 1300) plus the focused states, asserting zero out-of-bounds visible elements
// per combination — in BOTH locales (zh ledger ids byte-identical, en ids
// suffixed -en; 144 matrix rows + 24 focused rows = 168).
//
// D-04 separation: this file contains ZERO screenshot expectations — pixels
// are Plan 03 (visual.spec.ts). Geometry is zero-tolerance and font-agnostic.
//
// D-03 (Phase 29): the KNOWN_RED / FOCUSED_KNOWN_RED conditional-run protocol
// is RETIRED — every row is a plain gated test. The pre-migration flip-ledger
// history remains in tests/visual/reports/PRE-MIGRATION-GEOMETRY.md.
import { test, expect } from "@playwright/test";
import { measureBounds } from "../helpers/measure";
import {
  gotoHarness,
  openSettingsAppTab,
  setTheme,
  setViewportSize,
  setView,
  tZh,
  tEn,
  MATRIX_WIDTHS,
  type MatrixView,
  type HarnessLocale,
} from "../helpers/navigation";

/** The 9 matrix surfaces — CONTRACT-02: 9 x 2 themes x 4 widths = 72. */
const MATRIX_VIEWS: MatrixView[] = [
  "idle",
  "running",
  "completed",
  "error",
  "git-running",
  "git-error",
  "history",
  "health",
  "settings",
];

const THEMES = ["dark", "light"] as const;

/**
 * The locale dimension (29-01, PAR-01/D-01): every row executes twice — zh
 * first (the historical ledger), then en. zh combo ids stay byte-identical
 * (`{view}-{theme}-{width}`); en ids append `-en` at the loop call site.
 */
const LOCALES = ["zh", "en"] as const satisfies readonly HarnessLocale[];

/** Combo identifier used in titles (zh form is the historical ledger). */
export function comboId(view: MatrixView, theme: (typeof THEMES)[number], width: number): string {
  return `${view}-${theme}-${width}`;
}

/**
 * D-03 (Phase 29): the KNOWN_RED / FOCUSED_KNOWN_RED conditional-run protocol
 * is RETIRED and its wrapper indirection is deleted. Every matrix and focused
 * row — both locales — is a plain gated test(); nothing can be silently
 * demoted, and a red en row blocks PAR-01 as a must-fix in 29-02. The
 * pre-migration flip-ledger history remains in
 * tests/visual/reports/PRE-MIGRATION-GEOMETRY.md (retired protocol, not to be
 * re-edited).
 */

test.beforeEach(async ({ page }) => {
  // Ported from the canonical checker: collect uncaught page errors per
  // combination; asserted empty at the end of every test below.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Stash on the test context so each test body can assert at its end.
  (page as unknown as { __pageErrors: string[] }).__pageErrors = pageErrors;
});

async function assertCleanAndInBounds(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  const { outside, checked } = await measureBounds(page);
  expect(
    outside,
    `out-of-bounds [${label}] checked=${checked}: ${outside.join(", ")}`,
  ).toEqual([]);
  const pageErrors = (page as unknown as { __pageErrors: string[] }).__pageErrors;
  expect(pageErrors, `page errors [${label}]`).toEqual([]);
}

for (const locale of LOCALES) {
  test.describe(`geometry matrix (${locale})`, () => {
    for (const theme of THEMES) {
      for (const width of MATRIX_WIDTHS) {
        for (const view of MATRIX_VIEWS) {
          // zh ids are the historical ledger (byte-identical); en ids append
          // the locale suffix (e.g. idle-dark-1056-en).
          const id = locale === "en" ? `${comboId(view, theme, width)}-en` : comboId(view, theme, width);
          test(`bounds: ${id}`, async ({ page }) => {
            await setTheme(page, theme);
            await setViewportSize(page, width);
            await gotoHarness(page, { locale });
            await setView(page, view, locale);
            await assertCleanAndInBounds(page, id);
          });
        }
      }
    }
  });
}

// The focused block runs in BOTH locales (29-01 Task 2, D-01/D-05): each
// describe re-executes every case below with locale threading; zh ids keep
// their historical form, en ids gain the -en suffix. The standalone
// english-at-352-dark-352 case was DEDUPLICATED (D-05): the matrix now runs
// every view at width 352 under en (18 rows including idle-en-dark-352), so
// the standalone boot-state case is redundant — its proof survives in the
// matrix en-at-352 rows.
for (const locale of LOCALES) {
  test.describe(`focused states (${locale})`, () => {
    // Dictionary for this pass — every expected string below resolves through
    // the ACTIVE locale's dictionary (zero hardcoded locale literals).
    const t = locale === "en" ? tEn : tZh;
    /** zh ids keep the historical form; en ids gain the -en suffix. */
    const fid = (base: string) => (locale === "en" ? `${base}-en` : base);

    // target+engine: CL 381700 filled, engine checked — at 1056 and 352.
    for (const width of [1056, 352] as const) {
      const id = fid(`target+engine-dark-${width}`);
      test(`focused: target+engine ${width}`, async ({ page }) => {
        await setTheme(page, "dark");
        await setViewportSize(page, width);
        await gotoHarness(page, { locale });
        const clInput = page.locator("#target-changelist");
        await clInput.fill("381700");
        const engineCheckbox = page.getByLabel(t("sync.engine.checkbox"), { exact: true });
        await expect(engineCheckbox).toBeVisible();
        await engineCheckbox.check();
        await expect(page.getByText(t("sync.engine.hintOn"))).toBeVisible();
        await assertCleanAndInBounds(page, id);
      });
    }

    // health-empty: health tab, no Audit yet (on-demand only).
    test("focused: health-empty dark-1056", async ({ page }) => {
      await setTheme(page, "dark");
      await setViewportSize(page, 1056);
      await gotoHarness(page, { locale });
      await setView(page, "health", locale);
      await assertCleanAndInBounds(page, fid("health-empty-dark-1056"));
    });

    // rollback-confirm: rollback dialog open, fixture CL 381204 selected,
    // confirmation stage visible — the Radix portal case.
    test("focused: rollback-confirm dark-1056", async ({ page }) => {
      await setTheme(page, "dark");
      await setViewportSize(page, 1056);
      await gotoHarness(page, { locale });
      await page.getByRole("tab", { name: t("sync.tab.history") }).click();
      await page.getByRole("button", { name: t("history.rollback") }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByText(t("history.clBadge", { cl: "381204" })).click();
      const rollbackGo = dialog.getByRole("button", {
        name: t("history.rollback.toCl", { cl: "381204" }),
      });
      await expect(rollbackGo).toBeEnabled();
      await rollbackGo.click();
      await expect(
        dialog.getByText(t("history.rollback.confirmTitle")),
      ).toBeVisible();
      await assertCleanAndInBounds(page, fid("rollback-confirm-dark-1056"));
    });

    // app-settings proxy on: App tab, proxy enabled, URL input active.
    // Matrix settings-* stays workspace-default (setView settings only).
    for (const width of [1056, 352] as const) {
      const id = fid(`app-settings-proxy-on-dark-${width}`);
      test(`focused: app-settings-proxy-on dark-${width}`, async ({ page }) => {
        await setTheme(page, "dark");
        await setViewportSize(page, width);
        await gotoHarness(page, { locale });
        await setView(page, "settings", locale);
        await openSettingsAppTab(page, locale);
        const proxyToggle = page.getByLabel(t("settings.network.enable"), {
          exact: true,
        });
        await proxyToggle.check();
        const proxyUrlInput = page.getByLabel(t("settings.network.urlAria"), {
          exact: true,
        });
        await expect(proxyUrlInput).toBeEnabled();
        await assertCleanAndInBounds(page, id);
      });
    }

    // add-workspace: form dialog open (Radix portal) at 1056 and 352 (DLG-02).
    for (const width of [1056, 352] as const) {
      const id = fid(`add-workspace-dark-${width}`);
      test(`focused: add-workspace dark-${width}`, async ({ page }) => {
        await setTheme(page, "dark");
        await setViewportSize(page, width);
        await gotoHarness(page, { locale });
        await page
          .getByRole("button", { name: t("workspace.sidebar.add") })
          .click();
        await expect(
          page
            .getByRole("dialog")
            .getByRole("heading", { name: t("workspace.form.title") }),
        ).toBeVisible();
        await assertCleanAndInBounds(page, id);
      });
    }

    // no-workspace: workspaces=empty — WorkspaceEmptyState renders in bounds.
    // gotoHarness's workspace selection is skipped for this mode (there is
    // nothing to select) — the empty state IS the surface. The empty-title
    // wait inside gotoHarness is locale-aware (29-01 Task 1).
    test("focused: no-workspace dark-1056", async ({ page }) => {
      await setTheme(page, "dark");
      await setViewportSize(page, 1056);
      await gotoHarness(page, { workspaces: "empty", locale });
      await assertCleanAndInBounds(page, fid("no-workspace-dark-1056"));
    });

    // cancel-pending: running + cancel clicked under cancel-hold, button
    // disabled state held (the loading focused-state row).
    // Promoted by Plan 26-04 (2026-09-10): strict green proof + width-0 probe
    // recorded in the Phase 26 flip/triage ledger
    // (reports/PRE-MIGRATION-GEOMETRY.md).
    test("focused: cancel-pending dark-1056", async ({ page }) => {
      await setTheme(page, "dark");
      await setViewportSize(page, 1056);
      await gotoHarness(page, { locale });
      await page.evaluate(
        (scenario) =>
          (
            window as unknown as {
              __HARNESS__: { setNextScenario: (s: string) => void };
            }
          ).__HARNESS__.setNextScenario(scenario),
        "cancel-hold",
      );
      await page.getByRole("button", { name: t("sync.start") }).click();
      const cancelButton = page.getByRole("button", { name: t("sync.cancel") });
      await expect(cancelButton).toBeVisible();
      await cancelButton.click();
      await expect(
        page.getByRole("button", { name: t("sync.cancelling") }),
      ).toBeDisabled();
      await assertCleanAndInBounds(page, fid("cancel-pending-dark-1056"));
    });
    // git-success: git pull with "git-quick-success" (terminal success banner).
    test("focused: git-success dark-1056", async ({ page }) => {
      await setTheme(page, "dark");
      await setViewportSize(page, 1056);
      await gotoHarness(page, { locale });
      await page.evaluate(
        (scenario) =>
          (
            window as unknown as {
              __HARNESS__: { setNextScenario: (s: string) => void };
            }
          ).__HARNESS__.setNextScenario(scenario),
        "git-quick-success",
      );
      await page.getByRole("button", { name: t("sync.git.pull") }).click();
      await expect(page.getByText(t("sync.git.success"))).toBeVisible();
      await assertCleanAndInBounds(page, fid("git-success-dark-1056"));
    });

    // long-workspace-names at 352 (workspaces=long).
    // Flipped green by the Phase 24 responsive shell (Plan 24-04 unfixme —
    // see PRE-MIGRATION-GEOMETRY.md "Phase 24 flip/triage ledger").
    test("focused: long-workspace-names dark-352", async ({ page }) => {
      await setTheme(page, "dark");
      await setViewportSize(page, 352);
      await gotoHarness(page, { workspaces: "long", locale });
      await assertCleanAndInBounds(page, fid("long-workspace-names-dark-352"));
    });
  });
}
