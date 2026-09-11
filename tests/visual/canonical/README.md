# Canonical design reference

These v1.8 design references were copied into the repository in September 2026.
Private examples were replaced with fictional DemoDepot/Demo_Stream_Alice data;
all PNGs were rendered again from sanitized HTML. These are design references,
not runtime application inputs or screenshot-test baselines.

Run `node tests/visual/canonical/check-code-preview.cjs` after `npm ci` and
`npx playwright install chromium`. The checker uses the repository's pinned
Playwright browser, verifies interactions and geometry, and regenerates eleven
PNG states: idle, target, running, history, rollback, health, settings,
app-settings, add, light and narrow.

The canonical widget has a 32px wrapper (a 1056px viewport holds a 1024px widget).
The live harness captures the full app viewport. Account for this when comparing
references; runtime baselines remain in `tests/visual/baselines/`.

All reference files are covered by `npm run check:privacy`, without directory
exemptions. After regeneration, inspect every image at readable resolution and
deliberately update its reviewed SHA-256 in the image manifest. Matching hashes
attest reviewed bytes; they are not OCR or general secret detection.
