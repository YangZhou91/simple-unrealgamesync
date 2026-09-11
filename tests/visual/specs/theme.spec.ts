// Phase 24 (24-01, SHELL-01): light-dark() canary — the A1 mitigation proof.
//
// Research Q6 flagged one untestable-from-docs assumption: Playwright's
// emulateMedia({ colorScheme }) drives the prefers-color-scheme media feature,
// but whether it ALSO drives the "used color scheme" that light-dark() and
// color-scheme resolve against is Chromium-internal behavior. This spec is
// the cheap permanent de-risk for the whole theme-flip layer: the computed
// body background must flip between the canonical pair values when only the
// emulated scheme changes — no reload, no React involvement (D-02).
//
// ZERO screenshot assertions by construction (D-04 pixel/behavior
// separation — pixel baselines live only in visual.spec.ts, so
// --update-snapshots can never touch this file).
import { test, expect } from "@playwright/test";
import { gotoHarness, setTheme, setViewportSize, tZh } from "../helpers/navigation";

test("light-dark() tokens flip with emulated prefers-color-scheme (canary)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await setViewportSize(page, 1056);
  await gotoHarness(page);

  // :root must carry BOTH schemes — without color-scheme: light dark the
  // light-dark() tokens silently stick (research Pitfall 1).
  const rootScheme = await page.evaluate(
    () => getComputedStyle(document.documentElement).colorScheme,
  );
  expect(rootScheme).toContain("light dark");

  const bodyBackground = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // Dark scheme: --background resolves to #15181b.
  await setTheme(page, "dark");
  expect(await bodyBackground()).toBe("rgb(21, 24, 27)");

  // Light scheme: --background resolves to #f5f6f8 — a genuinely distinct
  // computed color, in place, from the same token (no reload happened).
  await setTheme(page, "light");
  expect(await bodyBackground()).toBe("rgb(245, 246, 248)");

  // Flip back to dark — proves the flip is repeatable and stateless.
  await setTheme(page, "dark");
  expect(await bodyBackground()).toBe("rgb(21, 24, 27)");

  expect(pageErrors).toEqual([]);
});


function relativeLuminance([red, green, blue]: readonly number[]): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(
  foreground: readonly number[],
  background: readonly number[],
): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function parseComputedRgb(value: string): [number, number, number] {
  const components = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!components || components.length !== 3) {
    throw new Error(`Expected a computed RGB value, received ${value}`);
  }
  return [components[0], components[1], components[2]];
}

async function tokenContrast(
  page: import("@playwright/test").Page,
  foreground: string,
  background: string,
): Promise<number> {
  const [foregroundColor, backgroundColor] = await page.evaluate(
    ({ foregroundToken, backgroundToken }) => {
      const resolve = (token: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      return [resolve(foregroundToken), resolve(backgroundToken)];
    },
    { foregroundToken: foreground, backgroundToken: background },
  );
  return contrastRatio(
    parseComputedRgb(foregroundColor),
    parseComputedRgb(backgroundColor),
  );
}

test("semantic foregrounds retain readable light and dark contrast", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await setViewportSize(page, 1056);
  await gotoHarness(page);

  const tokenPairs = [
    ["--foreground", "--card"],
    ["--muted", "--background"],
    ["--primary-foreground", "--primary"],
    ["--success", "--card"],
    ["--warning", "--warning-surface"],
    ["--destructive", "--destructive-surface"],
    ["--info", "--card"],
  ] as const;

  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const [foreground, background] of tokenPairs) {
      expect(
        await tokenContrast(page, foreground, background),
        `${theme}: ${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    // Canonical 26-01 P4 chip is a label, not a status tint (outlined
    // muted chrome). Status-token contrast stays in tokenPairs above;
    // the live status tint in this fixture is the warning behind badge.
    const p4Badge = page
      .locator("#target-changelist")
      .locator("xpath=ancestor::section")
      .getByText(tZh("sync.badge.p4"), { exact: true });
    expect(await p4Badge.getAttribute("class")).toContain("text-muted-foreground");
    const behindBadge = page.getByText(tZh("sync.behind.badge", { n: 3 }), {
      exact: true,
    });
    expect(await behindBadge.getAttribute("class")).toContain("text-warning");
  }

  expect(pageErrors).toEqual([]);
});
