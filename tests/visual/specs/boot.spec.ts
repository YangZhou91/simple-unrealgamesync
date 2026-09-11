// Phase 23 (23-01): tracer verify — the harness boots the PRODUCTION App in
// headless Chromium against deterministic fixtures with zero page errors.
// Ported from the canonical checker's error collection (check-code-preview.cjs:7).
import { test, expect } from "@playwright/test";
import { gotoHarness } from "../helpers/navigation";

test("harness boots the production App against fixtures with zero page errors", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await gotoHarness(page);

  // The fixture workspace renders in the sidebar (production useWorkspaces
  // got the list through the mocked get_workspaces). Anchored so the item's
  // own button matches, not the sibling delete button (aria "删除 DemoGame 开发区").
  const workspaceItem = page.getByRole("button", { name: /^DemoGame 开发区/ });
  await expect(workspaceItem).toBeVisible();

  // gotoHarness selects the fixture workspace and waits for the dashboard.
  await expect(page.getByText("CL 381699")).toBeVisible();

  // Dashboard header now shows the selected workspace name (SyncDashboard h1).
  await expect(page.getByRole("heading", { name: "DemoGame 开发区" })).toBeVisible();

  // Sidebar resolves the mocked plugin:app|version after the 3s-delayed
  // updater auto-check has also run (plugin:store + plugin:updater|check are
  // part of the boot surface — exercise them before asserting clean errors).
  await expect(page.getByText("v1.7.0")).toBeVisible();
  await page.waitForTimeout(3_300);

  // Zero uncaught page errors — the canonical checker's gate.
  expect(pageErrors).toEqual([]);
});
