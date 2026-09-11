// Phase 24 (24-02, SHELL-02/SHELL-03): AppTitleBar behavior spec — a11y,
// adapter-call recording, drag-region DOM placement, config assertion,
// narrow-controls reachability, keyboard focus. D-04 separation: ZERO
// screenshot assertions (pixel proof lives in visual.spec.ts / Plan 24-04).
//
// Assertion sources: the shipped dictionaries (via tZh/tEn helpers — no
// hardcoded locale literals) and the harness's titlebar adapter recorder
// (__HARNESS__.windowCalls, the plugin:window|* mock-seam call log).
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { gotoHarness, setViewportSize, tEn, tZh } from "../helpers/navigation";

const TITLEBAR = '[data-titlebar="app"]';

type HarnessRecorder = {
  __HARNESS__: {
    windowCalls: () => readonly string[];
    resetWindowCalls: () => void;
  };
};

function titlebar(page: Page) {
  return page.locator(TITLEBAR);
}

test("titlebar renders exactly once with the app title", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await gotoHarness(page);

  await expect(titlebar(page)).toHaveCount(1);
  const brandIcon = titlebar(page).locator("[data-app-brand-icon]");
  await expect(brandIcon).toHaveCount(1);
  await expect(brandIcon).toHaveAttribute("src", /\S+/);
  await expect(brandIcon).toHaveCSS("width", "16px");
  await expect(brandIcon).toHaveCSS("height", "16px");
  // The title text is the shared APP_TITLE constant, identical both locales.
  await expect(
    titlebar(page).getByText("Simple UnrealGameSync"),
  ).toBeVisible();
  const box = await titlebar(page).boundingBox();
  expect(box?.height).toBe(34);

  expect(pageErrors).toEqual([]);
});

test("window controls expose dictionary aria-labels in both locales", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await gotoHarness(page); // zh (default)
  for (const key of ["titlebar.minimize", "titlebar.maximize", "titlebar.close"] as const) {
    await expect(page.getByRole("button", { name: tZh(key) })).toBeVisible();
  }

  await gotoHarness(page, { locale: "en" });
  for (const key of ["titlebar.minimize", "titlebar.maximize", "titlebar.close"] as const) {
    await expect(page.getByRole("button", { name: tEn(key) })).toBeVisible();
  }

  expect(pageErrors).toEqual([]);
});

test("buttons route through the adapter: minimize/toggle_maximize/close, never destroy or exit", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await gotoHarness(page);
  await page.evaluate(
    () =>
      (window as unknown as HarnessRecorder).__HARNESS__.resetWindowCalls(),
  );

  // Click in the printed order — the recorder must log the exact IPC
  // command names in click order (toggle_maximize is snake_case on the wire).
  await page.getByRole("button", { name: tZh("titlebar.minimize") }).click();
  await page
    .getByRole("button", { name: tZh("titlebar.maximize") })
    .click();
  await page.getByRole("button", { name: tZh("titlebar.close") }).click();

  const calls = await page.evaluate(
    () => (window as unknown as HarnessRecorder).__HARNESS__.windowCalls(),
  );
  expect(calls).toEqual([
    "plugin:window|minimize",
    "plugin:window|toggle_maximize",
    "plugin:window|close",
  ]);
  // T-24-04: the frontend close path must never terminate the process.
  expect(calls).not.toContain("plugin:window|destroy");
  expect(calls).not.toContain("plugin:process|exit");

  expect(pageErrors).toEqual([]);
});

test("drag regions sit on the bar and title span only — never on buttons", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await gotoHarness(page);

  // React renders the bare JSX attribute truthily (""); drag.js treats both
  // "" and "true" as the self-only form — assert presence, not exact value.
  expect(await titlebar(page).getAttribute("data-tauri-drag-region")).not.toBeNull();
  const titleSpan = titlebar(page).locator("span[data-tauri-drag-region]");
  await expect(titleSpan).toHaveCount(1);
  expect(await titleSpan.getAttribute("data-tauri-drag-region")).not.toBeNull();

  // T-24-05: all three controls must NOT be drag targets (clickable-element
  // exclusion is drag.js's job in production; in the harness we assert the
  // attribute placement that makes it hold).
  const buttons = titlebar(page).getByRole("button");
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) {
    expect(await button.getAttribute("data-tauri-drag-region")).toBeNull();
  }

  expect(pageErrors).toEqual([]);
});

test("window config and capability ACL match the least-privilege contract", () => {
  // SHELL-03 / T-24-03: minWidth 352 (D-04), decorations false (D-03),
  // minHeight 500 unchanged (undecorated minima are client-area logical px —
  // the 34px titlebar comes OUT of the 500; research Q7). Playwright
  // transpiles specs as ESM — resolve paths from import.meta.url, not
  // __dirname (undefined there).
  const confPath = fileURLToPath(
    new URL("../../../src-tauri/tauri.conf.json", import.meta.url),
  );
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  const win = conf.app.windows[0];
  expect(win.minWidth).toBe(352);
  expect(win.decorations).toBe(false);
  expect(win.minHeight).toBe(500);

  // Exactly the four VERIFIED identifiers (research Q1) and nothing broader:
  // every core:window:* permission must be one of them — no wildcards, no
  // set-decorations, no destroy, no explicit core:window:default.
  const capsPath = fileURLToPath(
    new URL("../../../src-tauri/capabilities/default.json", import.meta.url),
  );
  const caps = JSON.parse(fs.readFileSync(capsPath, "utf8"));
  const capPermissions: unknown[] = caps.permissions;
  const perms: string[] = capPermissions.map((p: unknown) =>
    typeof p === "string" ? p : (p as { identifier: string }).identifier,
  );
  const verified = [
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
  ];
  for (const id of verified) {
    expect(perms).toContain(id);
  }
  expect(perms.filter((p) => p.startsWith("core:window:"))).toEqual(
    verified,
  );
  expect(perms).toContain("core:default");

  // The main WebView orchestrates processes through Rust commands, never the
  // shell plugin. Reject any future shell allow-list that accepts arbitrary
  // arguments, even if its executable name looks narrowly scoped.
  const arbitraryArgShellGrants = capPermissions.flatMap((permission) => {
    if (
      typeof permission !== "object" ||
      permission === null ||
      !("identifier" in permission) ||
      !String(permission.identifier).startsWith("shell:")
    ) {
      return [];
    }
    const allow = "allow" in permission && Array.isArray(permission.allow)
      ? permission.allow
      : [];
    return allow.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "args" in entry &&
        entry.args === true,
    );
  });
  expect(arbitraryArgShellGrants).toEqual([]);
  expect(perms).not.toContain("shell:allow-spawn");
});

test("at 352px all three controls stay visible and the title truncates", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await gotoHarness(page);
  await setViewportSize(page, 352);

  // Controls NEVER hide at narrow (locked deviation from canonical's
  // uc-chrome display:none — SHELL-02/SHELL-03 floor).
  for (const key of ["titlebar.minimize", "titlebar.maximize", "titlebar.close"] as const) {
    await expect(page.getByRole("button", { name: tZh(key) })).toBeVisible();
  }
  // The title span carries the truncate utility (ellipsis under overflow).
  const titleSpan = titlebar(page).locator("span[data-tauri-drag-region]");
  expect(await titleSpan.getAttribute("class")).toContain("truncate");

  expect(pageErrors).toEqual([]);
});

test("Tab from the titlebar chrome focuses the minimize button with a focus-visible ring class", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await gotoHarness(page);

  // Titlebar is first in DOM, so the first tabbable element from its own
  // chrome is the minimize button. Click the non-interactive bar area to set
  // Chromium's sequential focus navigation starting point there (a plain
  // blur() retains the previously-focused element's starting point — the
  // sidebar — and Tab would walk the sidebar's tabbables instead).
  await page
    .locator('[data-titlebar="app"]')
    .click({ position: { x: 60, y: 17 } });
  await page.keyboard.press("Tab");
  const minimize = page.getByRole("button", { name: tZh("titlebar.minimize") });
  await expect(minimize).toBeFocused();
  // The ring is outline-based (canonical .btn:focus-visible) — the class
  // carries it; the ring itself paints under :focus-visible.
  expect(await minimize.getAttribute("class")).toContain(
    "focus-visible:outline-ring",
  );

  expect(pageErrors).toEqual([]);
});
