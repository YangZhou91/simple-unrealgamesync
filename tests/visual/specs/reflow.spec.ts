// Phase 24 (24-03, SHELL-04 / D-05): mount-identity + state-survival probes.
//
// The no-remount proof: one AppLayout DOM tree reflows via CSS at the two
// inclusive breakpoints (@media max-width 850px / 620px). Each probe grabs
// the aside elementHandle, crosses a breakpoint BOTH directions with
// setViewportSize, and asserts the SAME DOM node survives (toBe identity),
// plus observable app state across crossings / a theme flip / a locale
// switch: sidebar-width persistence, an open dialog, a running operation,
// the active locale, and buffered log lines.
//
// D-04 separation (tests/visual/README.md §4): zero screenshot expectations
// in this file — pixels are visual.spec.ts, bounds are geometry.spec.ts; this
// spec is pure behavior/identity. --update-snapshots can never touch it.
import { test, expect, type Page } from "@playwright/test";
import {
  gotoHarness,
  setTheme,
  setViewportSize,
  setView,
  openSettingsDialog,
  openSettingsAppTab,
  closeDialog,
  tZh,
  tEn,
} from "../helpers/navigation";
import { CANONICAL_SCRIPTS } from "../fixtures/events";
import type { ScenarioId, ScenarioScript } from "../fixtures/controller";
import { FIXTURE_WORKSPACE_DEV } from "../fixtures/workspaces";
import { SIDEBAR_WIDTH_STORAGE_KEY } from "../../../src/lib/sidebarWidth";

test.beforeEach(async ({ page }) => {
  // Ported from the canonical checker via geometry.spec.ts: collect uncaught
  // page errors per test; asserted empty at the end of every test below.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  (page as unknown as { __pageErrors: string[] }).__pageErrors = pageErrors;
});

/** The pageerror gate — every test below ends with this assertion. */
function expectNoPageErrors(page: Page): void {
  const pageErrors = (page as unknown as { __pageErrors: string[] })
    .__pageErrors;
  expect(pageErrors).toEqual([]);
}

/** The mount-identity token — the sidebar aside element handle. */
async function asideHandle(page: Page) {
  return page.locator("aside").elementHandle();
}

/**
 * TRUE node-identity assertion: Playwright elementHandle wrappers are fresh
 * objects per call, so expect(a).toBe(b) compares wrapper _guids and can
 * never pass — resolve the strict equality INSIDE the page, where === means
 * DOM-node identity.
 */
async function expectSameAsideNode(
  page: Page,
  expected: Awaited<ReturnType<typeof asideHandle>>,
): Promise<void> {
  expect(expected).not.toBeNull();
  const sameNode = await page.evaluate(
    (expectedNode) => document.querySelector("aside") === expectedNode,
    expected,
  );
  expect(sameNode).toBe(true);
}

/** Inline style.width of the aside (what AppLayout.test.tsx asserts on). */
function asideStyleWidth(page: Page): Promise<string> {
  return page.locator("aside").evaluate((el) => el.style.width);
}

/** Persisted sidebar width straight from localStorage (in-page read). */
function storedSidebarWidth(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), SIDEBAR_WIDTH_STORAGE_KEY);
}

/**
 * Let a viewport change's window resize event flush (rAF + macrotask) —
 * consecutive setViewportSize calls can otherwise coalesce in Chromium.
 */
function settleResize(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 50)),
      ),
  );
}

/**
 * logs-persist probe fixture: the canonical "running-hold" script holds the
 * running state but emits no log events (events.ts prologue is steps +
 * progress only) — append a logBatch so the LogViewer buffers real lines to
 * count across the crossing. Registered over the canonical script through
 * the SAME registerScripts seam gotoHarness itself uses.
 */
const PERSIST_LOG_LINES = [
  "fixture-log: p4 sync routing table line 1",
  "fixture-log: p4 sync routing table line 2",
];
const RUNNING_HOLD_WITH_LOGS: Partial<Record<ScenarioId, ScenarioScript>> = {
  "running-hold": {
    ...CANONICAL_SCRIPTS["running-hold"]!,
    prologue: [
      ...CANONICAL_SCRIPTS["running-hold"]!.prologue,
      {
        event: "logBatch",
        data: { lines: PERSIST_LOG_LINES, stream: "stdout" },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// (1) mount-identity-850 — crossing the medium breakpoint both directions.
// ---------------------------------------------------------------------------
test("mount-identity-850: aside node survives crossing 850 both directions", async ({
  page,
}) => {
  await setViewportSize(page, 1056);
  await gotoHarness(page);

  const handle = await asideHandle(page);

  await page.setViewportSize({ width: 850, height: 1300 }); // inclusive medium boundary
  await settleResize(page);
  await expectSameAsideNode(page, handle);
  await expect(page.locator("main")).toHaveCSS("padding-left", "18px");

  await setViewportSize(page, 1056); // back above 850
  await settleResize(page);
  await expectSameAsideNode(page, handle);
  await expect(page.locator("main")).toHaveCSS("padding-left", "0px");

  expectNoPageErrors(page);
});

// ---------------------------------------------------------------------------
// (2) mount-identity-620-both-directions — crossing the narrow breakpoint.
// ---------------------------------------------------------------------------
test("mount-identity-620: aside node survives crossing both breakpoints in both directions", async ({
  page,
}) => {
  // 1056 -> 352 (crosses 850 AND 620) -> back.
  await setViewportSize(page, 1056);
  await gotoHarness(page);
  const fromWide = await asideHandle(page);

  await setViewportSize(page, 352);
  await expectSameAsideNode(page, fromWide);

  await setViewportSize(page, 1056);
  await expectSameAsideNode(page, fromWide);

  // 768 (medium) -> 352 (crosses 620 only) -> back — fresh mount for a clean
  // medium-bucket origin.
  await setViewportSize(page, 768);
  await gotoHarness(page);
  const fromMedium = await asideHandle(page);

  await setViewportSize(page, 352);
  await expectSameAsideNode(page, fromMedium);

  await setViewportSize(page, 768);
  await expectSameAsideNode(page, fromMedium);

  expectNoPageErrors(page);
});

// ---------------------------------------------------------------------------
// (3) sidebar-width-persists — user width + localStorage survive a crossing.
// ---------------------------------------------------------------------------
test("sidebar-width-persists: persisted width unchanged and restored above 620", async ({
  page,
}) => {
  await setViewportSize(page, 1056);
  await gotoHarness(page);

  // A REAL user resize (pointer drag on the separator) — this is what fires
  // saveSidebarWidth; a breakpoint crossing never may. The separator strip
  // spans the aside's right edge (right:-6px, w-3) but the aside is
  // overflow-hidden, so only its INNER half is hit-testable — grab the
  // quarter point, safely inside the interactive half.
  const separator = page.getByRole("separator");
  const box = (await separator.boundingBox())!;
  const y = box.y + 120;
  const grabX = box.x + box.width / 4;
  await page.mouse.move(grabX, y);
  await page.mouse.down();
  await page.mouse.move(grabX + 80, y, { steps: 4 });
  await page.mouse.up();

  const widthBefore = "308px"; // 228 default + 80 drag, within clamp at 1056
  await expect.poll(() => asideStyleWidth(page)).toBe(widthBefore);
  await expect.poll(() => storedSidebarWidth(page)).toBe("308");

  // Cross both breakpoints and back — the persisted value must be untouched
  // by the crossing and the SAME inline px must restore above 620. The rAF
  // settle between the two resizes guarantees the intermediate viewport's
  // resize event is dispatched (rapid consecutive setViewportSize calls can
  // coalesce in Chromium, making the crossing racy instead of exercised).
  await setViewportSize(page, 352);
  await settleResize(page);
  await setViewportSize(page, 1056);
  await settleResize(page);

  expect(await storedSidebarWidth(page)).toBe("308");
  await expect.poll(() => asideStyleWidth(page)).toBe(widthBefore);

  expectNoPageErrors(page);
});

test("sidebar-width-narrow-first: persisted intent restores after 352->1056", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: SIDEBAR_WIDTH_STORAGE_KEY, value: "308" },
  );
  await setViewportSize(page, 352);
  await gotoHarness(page);

  await page.setViewportSize({ width: 1056, height: 1300 });
  await settleResize(page);

  await expect.poll(() => asideStyleWidth(page)).toBe("308px");
  expect(await storedSidebarWidth(page)).toBe("308");
  expectNoPageErrors(page);
});

// ---------------------------------------------------------------------------
// (4) dialog-survives — an open dialog stays open across crossings.
// ---------------------------------------------------------------------------
test("dialog-survives: settings dialog stays open across 1056->352->1056", async ({
  page,
}) => {
  await setViewportSize(page, 1056);
  await gotoHarness(page);
  await openSettingsDialog(page);

  await setViewportSize(page, 352);
  await expect(page.getByRole("dialog")).toBeVisible();

  await setViewportSize(page, 1056);
  await expect(page.getByRole("dialog")).toBeVisible();

  await closeDialog(page);
  expectNoPageErrors(page);
});

// ---------------------------------------------------------------------------
// (5) running-op-survives — held running state survives crossings AND a
//     mid-running theme flip (T-24-08 probe: controls stay reachable).
// ---------------------------------------------------------------------------
test("running-op-survives: Cancel stays visible across crossings and theme flips", async ({
  page,
}) => {
  await setViewportSize(page, 1056);
  await gotoHarness(page);
  await setView(page, "running"); // running-hold + Start -> Cancel visible

  const cancel = page.getByRole("button", { name: tZh("sync.cancel") });

  await setViewportSize(page, 352);
  await expect(cancel).toBeVisible();

  await setViewportSize(page, 1056);
  await expect(cancel).toBeVisible();

  // Theme flip mid-running: CSS-only repaint, the operation must continue.
  await setTheme(page, "light");
  await expect(cancel).toBeVisible();

  await setTheme(page, "dark");
  await expect(cancel).toBeVisible();

  expectNoPageErrors(page);
});

// ---------------------------------------------------------------------------
// (6) locale-switch-survives — in-place dictionary switch keeps state.
//     The dialog is opened at 1056 (the sidebar Settings affordance lives in
//     the brand block, which the <=620 reflow hides) and the SWITCH itself
//     happens while parked at 352 — proving the locale change rides React
//     state through the crossing, not a remount.
// ---------------------------------------------------------------------------
test("locale-switch-survives: Settings is reachable at 352 and state survives widening", async ({
  page,
}) => {
  await setViewportSize(page, 352);
  await gotoHarness(page);
  await openSettingsDialog(page);

  // 29-02 machinery repair: since Phase 28's scope split (c0e27e7), a
  // workspace-scoped Settings dialog opens on the WORKSPACE panel — the
  // language radios live on the App panel (HTML-hidden via scope!=="app").
  // The pre-28 test clicked the radio blindly and only passed because the
  // pre-split dialog had a single stacked form. Switch to the App scope
  // first (the openSettingsAppTab aria-pressed seam) — the dialog stays the
  // SAME mounted instance through the click, so the probe still proves the
  // locale switch rides React state, not a remount.
  await openSettingsAppTab(page);
  await page.getByRole("radio", { name: tZh("settings.language.en") }).click();
  await closeDialog(page);
  await page.setViewportSize({ width: 1056, height: 1300 });
  await settleResize(page);

  // English renders in place...
  await expect(
    page.getByRole("tab", { name: tEn("sync.tab.sync") }),
  ).toBeVisible();
  // ...and the previously-selected workspace is still the dashboard subject.
  await expect(
    page.getByRole("heading", {
      name: FIXTURE_WORKSPACE_DEV.name,
      level: 1,
    }),
  ).toBeVisible();

  expectNoPageErrors(page);
});

// ---------------------------------------------------------------------------
// (7) logs-persist — buffered log lines survive crossings (LogViewer state).
// ---------------------------------------------------------------------------
test("logs-persist: buffered log lines survive 1056->352->1056", async ({
  page,
}) => {
  await setViewportSize(page, 1056);
  await gotoHarness(page);

  // running-hold + a logBatch prologue (see RUNNING_HOLD_WITH_LOGS above).
  await page.evaluate(
    (scripts) =>
      (
        window as unknown as {
          __HARNESS__: { registerScripts: (s: unknown) => void };
        }
      ).__HARNESS__.registerScripts(scripts),
    RUNNING_HOLD_WITH_LOGS as unknown as Record<string, unknown>,
  );

  await setView(page, "running");

  const logNodes = page
    .locator("main")
    .getByText("fixture-log:", { exact: false });
  await expect(page.getByText(PERSIST_LOG_LINES[0])).toBeVisible();
  const before = await logNodes.count();
  expect(before).toBeGreaterThan(0);

  await setViewportSize(page, 352);
  await settleResize(page);
  await expect(page.getByText(PERSIST_LOG_LINES[0])).toBeVisible();

  await setViewportSize(page, 1056);
  await settleResize(page);
  await expect(page.getByText(PERSIST_LOG_LINES[0])).toBeVisible();

  // The buffered lines are still rendered — the count never reset to zero.
  await expect(page.getByText(PERSIST_LOG_LINES[0])).toBeVisible();
  const after = await logNodes.count();
  expect(after).toBe(before);

  expectNoPageErrors(page);
});

// ---------------------------------------------------------------------------
// (8) separator-hidden-at-narrow — the resize separator display:nones below
//     620 (no width to resize) and returns above it.
// ---------------------------------------------------------------------------
test("separator-hidden-at-narrow: separator visible at 1056, hidden at 352", async ({
  page,
}) => {
  await setViewportSize(page, 1056);
  await gotoHarness(page);

  const separator = page.getByRole("separator");
  await expect(separator).toBeVisible();

  await setViewportSize(page, 352);
  await expect(separator).toBeHidden();

  await setViewportSize(page, 1056);
  await expect(separator).toBeVisible();

  expectNoPageErrors(page);
});
