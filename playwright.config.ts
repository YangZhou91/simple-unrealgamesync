import { defineConfig } from "@playwright/test";

/**
 * Phase 23 (23-01, D-01/D-04; 23-03 CONTRACT-03): canonical Playwright harness
 * config.
 *
 * - webServer boots the EXISTING vite dev script in `--mode harness`, which
 *   serves tests/visual/harness.html as a static dev-server route and stubs
 *   virtual:changelog (see vite.config.ts). index.html stays untouched.
 * - One default chromium project: headless shell binary class, viewport
 *   1056x1300 (canonical matrix height), colorScheme dark.
 * - 23-03 (CONTRACT-03 / D-04): screenshot goldens are deliberate, tracked
 *   artifacts. expect.toHaveScreenshot routes every baseline into the tracked
 *   tests/visual/baselines/ tree via snapshotPathTemplate; maxDiffPixels 200
 *   is a small antialiasing tolerance ONLY (the geometry oracle stays
 *   zero-tolerance in its own spec — pixels never waive bounds). The pinned
 *   timezoneId makes Intl.DateTimeFormat output (history rows, last-sync
 *   line) identical on every machine that runs the suite. toHaveScreenshot
 *   defaults are otherwise kept (animations disabled, caret hidden, css
 *   scale).
 * - workers: 1 — captures run serially for pixel stability (D-04). Behavior
 *   specs (boot/interaction) and geometry.spec.ts stay free of
 *   toHaveScreenshot, so --update-snapshots can never touch them.
 */
export default defineConfig({
  testDir: "./tests/visual/specs",
  outputDir: "./tests/visual/.results",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      // Small antialiasing tolerance for text-heavy captures. The geometry
      // oracle (geometry.spec.ts) is zero-tolerance forever — this pixel
      // slack can never green a bounds failure (different files, different
      // assertion kinds — D-04 separation).
      maxDiffPixels: 200,
      // Route every golden into the tracked tests/visual/baselines/ tree.
      // {testDir} = tests/visual/specs → baselines live beside the specs.
      // (Playwright 1.63 spells the per-expectation option `pathTemplate`;
      // the top-level config key is `snapshotPathTemplate`.)
      pathTemplate: "{testDir}/../baselines/{testFileDir}/{arg}{ext}",
    },
  },
  // Context options applied to every project: pin the timezone so
  // Intl.DateTimeFormat output (formatTimestamp — history rows / last-sync
  // line) is stable regardless of the machine running the suite.
  use: {
    timezoneId: "Asia/Shanghai",
  },
  fullyParallel: true,
  // 23-03: single worker — screenshot captures must not contend for CPU
  // (rendering under load shifts antialiased edge pixels, Pitfall 4).
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  webServer: {
    command: "npm run dev -- --mode harness --port 1422",
    url: "http://localhost:1422/tests/visual/harness.html",
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        baseURL: "http://localhost:1422",
        viewport: { width: 1056, height: 1300 },
        colorScheme: "dark",
      },
    },
  ],
});
