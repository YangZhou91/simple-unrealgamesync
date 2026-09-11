import { test } from "@playwright/test";
import { gotoHarness, setView } from "./helpers/navigation";

// Explicit documentation rendering; not part of the normal visual test suite.
for (const state of ["idle", "running", "history", "light", "narrow"] as const) {
  test(`documentation ${state}`, async ({ page }) => {
    await page.setViewportSize({ width: state === "narrow" ? 392 : 1056, height: 900 });
    await page.emulateMedia({ colorScheme: state === "light" ? "light" : "dark" });
    await gotoHarness(page);
    await setView(page, state === "light" || state === "narrow" ? "idle" : state);
    await page.screenshot({ path: `docs/screenshot-${state}.png`, fullPage: true, animations: "disabled" });
  });
}
