// Phase 23 (23-01, CONTRACT-01) → Phase 29 (29-01, PAR-01/D-02): the ordered
// canonical interaction script, ported from check-code-preview.cjs:20-37,
// driven against the PRODUCTION UI through the fixture controller + Tauri
// mock seam — now in BOTH locales: zh through zh.ts and en through en.ts,
// step-for-step identical (runCanonicalScript below). D-04 separation:
// behavior specs carry no pixel assertions at all — screenshots are Plan 03.
//
// Assertion source of truth: the shipped typed dictionaries (tZh/tEn from
// helpers/navigation — identical makeT interpolation semantics; the 29-PATTERNS
// sanctioned approach). No hardcoded locale literals that could drift from the
// product copy.
import { test, expect, type Page } from "@playwright/test";
import {
  FIXTURE_HEALTH_REPORT,
} from "../fixtures/workspaces";
import {
  gotoHarness,
  openSettingsAppTab,
  tEn,
  tZh,
  type HarnessLocale,
} from "../helpers/navigation";

async function setNextScenario(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (scenario) =>
      (window as unknown as { __HARNESS__: { setNextScenario: (s: string) => void } })
        .__HARNESS__.setNextScenario(scenario),
    id,
  );
}

async function releaseCancel(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      (window as unknown as { __HARNESS__: { releaseCancel: () => void } })
        .__HARNESS__.releaseCancel(),
  );
}

/**
 * The canonical script, parameterized by locale (29-01 Task 3, D-02): the
 * dictionary is resolved once at the top (t = tEn | tZh) and every assertion
 * below routes through it — the en pass mirrors the zh pass step-for-step
 * through en.ts with zero hardcoded locale literals. The pageerror collector
 * and the final cleanliness gate live INSIDE the function so each pass gets
 * its own clean-window assertion on its own page.
 */
async function runCanonicalScript(
  page: Page,
  locale: HarnessLocale,
): Promise<void> {
  const t = locale === "en" ? tEn : tZh;

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // gotoHarness performs exactly the three preamble steps the inline version
  // did (page.goto harness.html, registerScripts evaluate, anchored
  // fixture-workspace click) with the locale URL param added.
  await gotoHarness(page, { locale });

  // Canonical step 0: idle surface visible.
  const clInput = page.locator("#target-changelist");
  await expect(page.getByText(t("sync.p4.cardTitle"))).toBeVisible();

  // Canonical step 1: CL validation — "wrong" disables Start.
  await clInput.fill("wrong");
  await expect(page.getByText(t("sync.targetCl.error"))).toBeVisible();
  const startButton = page.getByRole("button", { name: t("sync.start") });
  await expect(startButton).toBeDisabled();

  // Canonical step 2: "381700" — engine opt-in visible, default OFF.
  await clInput.fill("381700");
  const engineCheckbox = page.getByLabel(t("sync.engine.checkbox"), { exact: true });
  await expect(engineCheckbox).toBeVisible();
  await expect(engineCheckbox).not.toBeChecked();
  await expect(page.getByText(t("sync.engine.hintOff"))).toBeVisible();

  // Canonical step 3: check engine — hint flips to the ON dictionary value.
  await engineCheckbox.check();
  await expect(page.getByText(t("sync.engine.hintOn"))).toBeVisible();

  // Canonical step 4: start — running view visible AND sidebar Settings locked.
  // cancel-hold carries the whole running phase: held running state, then the
  // deferred terminal for the cancel handshake below.
  await setNextScenario(page, "cancel-hold");
  await startButton.click();
  const cancelButton = page.getByRole("button", { name: t("sync.cancel") });
  await expect(cancelButton).toBeVisible();
  const settingsButton = page.getByRole("button", {
    name: t("workspace.sidebar.settingsAria"),
    exact: true,
  });
  await expect(settingsButton).toBeDisabled();

  // Canonical step 5: history tab — rollback locked while busy.
  await page.getByRole("tab", { name: t("sync.tab.history") }).click();
  const rollbackOpener = page.getByRole("button", { name: t("history.rollback") });
  await expect(rollbackOpener).toBeDisabled();

  // Canonical step 6: back to sync tab, cancel — pending-disabled, then idle.
  await page.getByRole("tab", { name: t("sync.tab.sync") }).click();
  await cancelButton.click();
  const cancellingButton = page.getByRole("button", { name: t("sync.cancelling") });
  await expect(cancellingButton).toBeDisabled();
  await releaseCancel(page);
  await expect(page.getByText(t("sync.p4.cardTitle"))).toBeVisible();
  // Cancelled result rendered from the dictionary's cancelledAt composition.
  await expect(
    page.getByText(
      t("steps.status.cancelledAt", {
        step: t("steps.p4Sync.toCl", { cl: "381700" }),
      }),
    ),
  ).toBeVisible();

  // Canonical step 7: network-error — action offers restart-whole-sync.
  await setNextScenario(page, "network-error");
  await clInput.fill("");
  await startButton.click();
  const restartButton = page.getByRole("button", { name: t("sync.error.restart") });
  await expect(restartButton).toBeVisible();
  await page.getByRole("button", { name: t("sync.error.dismiss") }).click();
  await expect(page.getByText(t("sync.p4.cardTitle"))).toBeVisible();

  // Canonical step 8: git-error — action offers back-to-idle only.
  await setNextScenario(page, "git-error");
  await page.getByRole("button", { name: t("sync.git.pull") }).click();
  const gitBackButton = page.getByRole("button", { name: t("sync.git.back") });
  await expect(gitBackButton).toBeVisible();
  await gitBackButton.click();
  await expect(page.getByText(t("sync.p4.cardTitle"))).toBeVisible();

  // Canonical step 9: rollback — Next disabled with no CL, select 381204,
  // distinct destructive confirmation, confirm runs to completion.
  await page.getByRole("tab", { name: t("sync.tab.history") }).click();
  await rollbackOpener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(t("history.rollback.dialogTitle"))).toBeVisible();
  const rollbackNext = dialog.getByRole("button", { name: t("history.rollback") });
  await expect(rollbackNext).toBeDisabled();
  await dialog.getByText(t("history.clBadge", { cl: "381204" })).click();
  // The primary button's label switches to the toCl form once a CL is chosen.
  const rollbackGo = dialog.getByRole("button", {
    name: t("history.rollback.toCl", { cl: "381204" }),
  });
  await expect(rollbackGo).toBeEnabled();
  await rollbackGo.click();
  // Confirmation stage: distinct title + selected CL shown.
  await expect(dialog.getByText(t("history.rollback.confirmTitle"))).toBeVisible();
  await expect(dialog.getByText(t("history.rollback.selected", { cl: "381204" }))).toBeVisible();
  await setNextScenario(page, "rollback-complete");
  await rollbackGo.click();
  await expect(dialog).toBeHidden();
  // Rollback runs through the real useHistory channel; busy lock releases.
  await expect(rollbackOpener).toBeEnabled();

  // Canonical step 10: health — report hidden before Audit (on-demand only).
  await page.getByRole("tab", { name: t("sync.tab.health") }).click();
  await expect(page.getByText(t("sync.health.emptyHint"))).toBeVisible();
  await page
    .getByRole("button", { name: t("sync.health.audit"), exact: true })
    .click();
  await expect(page.getByText(t("sync.health.missingOnDisk"))).toBeVisible();
  await expect(
    page.getByText(FIXTURE_HEALTH_REPORT.categories[1].paths[0]),
  ).toBeVisible();

  // Canonical step 11: settings — click the App tab (settings.tab.app) before
  // any proxy queries. URL stays disabled until proxy is on, then enabled;
  // Escape hides Settings (D-07). Workspace/app are sibling HTML-hidden panels,
  // not one stacked form.
  await settingsButton.click();
  const settingsDialog = page.getByRole("dialog");
  await expect(settingsDialog).toBeVisible();
  await openSettingsAppTab(page, locale);
  const proxyToggle = page.getByLabel(t("settings.network.enable"), { exact: true });
  const proxyUrlInput = page.getByLabel(t("settings.network.urlAria"), { exact: true });
  await expect(proxyUrlInput).toBeDisabled();
  await proxyToggle.check();
  await expect(proxyUrlInput).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(settingsDialog).toBeHidden();

  // Canonical step 12: add-workspace form opens and Escape dismisses.
  await page.getByRole("button", { name: t("workspace.sidebar.add") }).click();
  const formDialog = page.getByRole("dialog");
  await expect(
    formDialog.getByRole("heading", { name: t("workspace.form.title") }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(formDialog).toBeHidden();

  // Canonical checker's cleanliness gate.
  expect(pageErrors).toEqual([]);
}

test("canonical interaction script reproduces through the production harness (zh)", async ({
  page,
}) => {
  await runCanonicalScript(page, "zh");
});

test("canonical interaction script reproduces through the production harness (en)", async ({
  page,
}) => {
  await runCanonicalScript(page, "en");
});
