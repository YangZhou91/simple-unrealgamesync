import { expect, test, type Page } from "@playwright/test";
import { gotoHarness, setViewportSize, switchTab, tZh } from "../helpers/navigation";
import { measureBounds } from "../helpers/measure";

function expectNoPageErrors(page: Page): void {
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as unknown as { errors: string[] }).errors = errors;
});

test("workspace frame keeps live header, tabs, and long rows bounded at 352", async ({ page }) => {
  await setViewportSize(page, 352);
  await gotoHarness(page, { workspaces: "long" });

  const header = page.getByRole("heading", { level: 1 });
  await expect(header).toBeVisible();
  const details = page.locator("details").first();
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");

  for (const tab of ["history", "health", "sync"] as const) {
    await switchTab(page, tab);
    await expect(page.getByRole("tab")).toHaveCount(3);
    for (const trigger of await page.getByRole("tab").all()) {
      await expect(trigger).toBeEnabled();
    }
  }

  expect((await measureBounds(page)).outside).toEqual([]);
  expectNoPageErrors(page);
});

test("empty workspace onboarding opens the existing WorkspaceForm portal", async ({ page }) => {
  await setViewportSize(page, 352);
  await gotoHarness(page, { workspaces: "empty" });
  await page.getByRole("main").getByRole("button", { name: tZh("workspace.empty.add") }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect((await measureBounds(page)).outside).toEqual([]);
  expectNoPageErrors(page);
});
