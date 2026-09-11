# Visual Harness — Baseline Contract (CONTRACT-03)

> The screenshot-baseline layer of the Phase 23 acceptance harness. This file is
> the process contract: how to run the suite, where goldens are valid, how to
> update them deliberately, and why approving pixels can never waive a behavior
> or geometry failure.

**Related layers:**

- Behavior (no pixels): `specs/interaction.spec.ts`, `specs/boot.spec.ts`
- Geometry (zero-tolerance bounds oracle, no pixels): `specs/geometry.spec.ts`, `helpers/measure.ts`
- Pixels (this layer): `specs/visual.spec.ts` → tracked goldens in `baselines/`
- Pre-migration geometry evidence: `reports/PRE-MIGRATION-GEOMETRY.md`
- Canonical design reference: `canonical/` (portable sanitized design captures)
- Isolation/portability guard: `npm run check:harness`
  (`scripts/guards/check-harness-isolation.mjs`, Plan 23-04)

---

## 1. Fresh-clone recipe

From a completely fresh checkout, with **no p4, no Tauri runtime, and no
user-local paths** — that is the point of the harness:

```bash
npm ci
npx playwright install chromium   # browsers do NOT download on npm install (since Playwright 1.38)
npm run test:visual
```

That is the entire setup. The `webServer` config boots the existing Vite dev
server in `--mode harness` (changelog stubbed), serves `tests/visual/harness.html`
on `http://localhost:1420`, and the fixture controller + `mockIPC` seam replace
every Tauri command — no Perforce client, no Rust backend, no reads of the
user-local visualization cache the canonical reference assets were copied from
(see §8 — the copies are tracked in-repo, nothing reads the original location).

**A caveat on step 2 (first run on a NEW machine):** Playwright writes missing
goldens locally instead of failing ("A snapshot doesn't exist, writing actual").
A green visual run on a machine that never generated the committed baselines is
therefore suspect — see §2.

## 2. Pinned environment policy (D-04)

Screenshot goldens are only reproducible on **one pinned environment**:

| Pin | Value |
|-----|-------|
| OS | The maintainer's Windows machine |
| Browser | Playwright-pinned Chromium **headless shell** (default headless binary class) |
| `@playwright/test` | **1.63.0 exact** (no caret) — the bundled Chromium revision, and therefore baseline pixels, are coupled to the package version |
| Font | Segoe UI (Windows system font; part of the pinned environment, not embedded) |
| Channel | One channel, forever — never mix default headless-shell with `channel: "chromium"` in the same baseline set |

**Baselines are valid only on this machine.** Browser rendering varies with OS,
settings, hardware, power source, and font smoothing (ClearType/GPU drivers)
even between two Windows boxes — sub-pixel glyph-edge differences are enough to
trip `maxDiffPixels: 200`. This project is single-maintainer by design: the
maintainer's machine IS the pinned environment. **Never regenerate baselines on
another machine**; a red visual suite on any other machine is expected and not
a code defect.

Cross-machine consequence, restated from §1: on a non-pinned machine the first
run silently *writes* local goldens that differ from the committed ones, so
"green" there means nothing about the committed contract.

## 3. Deliberate update process

Baseline updates are **reviewable, deliberate acts** — never a side effect.

**The update command:**

```bash
npm run test:visual:update    # = playwright test --update-snapshots
```

`--update-snapshots` is the *changed-only* updater: it rewrites exactly the
goldens whose captures differ and leaves identical ones untouched. Never set
`updateSnapshots: 'all'` in the config or script it — since Playwright 1.50 that
mode rewrites **every** golden unconditionally and would launder unrelated
drift into a single commit.

**Commit-message convention:**

```
visual(<scope>): update baselines — <reason>
```

Examples: `visual(shell): update baselines — Phase 24 semantic tokens landed`,
`visual(sync): update baselines — running pipeline indicator geometry fix`.

The baseline diff (old vs new PNG) is the reviewable artifact of that commit —
review it like code. If a capture change is not explainable in the commit
subject, it is not ready to commit.

**Scope guarantee:** `npm run test:visual:update` touches ONLY `visual.spec.ts`
goldens under `baselines/`. The interaction, boot, and geometry specs contain
zero `toHaveScreenshot` calls (verified by grep in the phase acceptance), so
they have no baselines to update — a pixel approval is structurally incapable
of changing them.

## 4. The separation contract (D-04)

Pixels, bounds, and behavior are **different files with different assertion
kinds** — that is the whole defense:

- **A behavior or geometry failure can never be resolved by approving pixels.**
  `--update-snapshots` only rewrites goldens in `baselines/`; interaction and
  geometry assertions compare against dictionaries and DOM bounds, not images.
  There is no mechanism by which a pixel update greens them.
- **Conversely, a red pixel cannot be waived by a green geometry run.** The
  geometry oracle (`helpers/measure.ts`) is zero-tolerance and font-agnostic
  forever; visual tolerances (`maxDiffPixels: 200`) may loosen in later phases,
  but bounds never waive — and a pixel diff still fails `visual.spec.ts`
  regardless of geometry's verdict.
- **Pixel-free behavior runs:** `npx playwright test --ignore-snapshots` runs
  the full behavior/geometry suites with screenshot expectations skipped —
  useful when iterating on UI code on a non-pinned machine where pixels are
  expected to differ.

## 5. Determinism notes

Baseline stability is engineered, not hoped for:

| Source of churn | Mitigation |
|---|---|
| `virtual:changelog` varies with git history | Harness mode stubs it (empty export) — see `vite.config.ts` |
| Timestamps via `Intl.DateTimeFormat` | Config-level `timezoneId: "Asia/Shanghai"` pins formatting on every machine; history rows parse locale-neutral literals (`YYYY-MM-DD HH:MM:SS`) |
| Last-sync line (`epochMs` = `Date.now()` at the terminal event — the ONLY runtime-clock text) | Masked via `toHaveScreenshot({ mask })` on the `<time>` element in every capture whose state can render it |
| Behind badge / progress bytes / history file counts | All fixture literals (see `fixtures/`, `fixtures/events.ts`) — deterministic by construction |
| Animations / caret / CSS transitions | `toHaveScreenshot` defaults kept: animations disabled, caret hidden, `scale: "css"` |
| Parallel-capture CPU contention | `workers: 1` — captures run serially |

**When a new nondeterministic region appears** (e.g. a future surface renders a
live timer or elapsed duration): mask it with a scoped locator and record WHY
in a comment next to the mask, in the same style as the last-sync mask in
`visual.spec.ts`. Do not delete the capture; do not widen `maxDiffPixels` to
hide churn.

## 6. The 32px canonical-wrapper normalization (D-03)

Canonical captures (`ugs-code-*.png`) were taken with the preview widget inside
a wrapper: **a canonical 1056px viewport contains a 1024px widget**. The repo
harness measures and captures the app root directly: **a repo capture at
viewport 1056 contains a 1056px app**.

Any comparison against canonical captures must account for this **32px delta**
(e.g. the canonical widget is 32px narrower and its content reflows
accordingly). **Repo-to-repo comparisons — the only comparisons this baseline
suite makes — are unaffected** by the normalization; it matters only when a
human diffs a repo golden against a canonical PNG by eye.

## 7. Known-red pointer (pre-migration evidence)

`reports/PRE-MIGRATION-GEOMETRY.md` records the pre-migration geometry state of
the current UI: 40/72 matrix combinations red (tab-strip overflow at 392/352,
the determinate progress indicator's `translateX(-100%)` mount signature at all
widths) plus 4/11 focused states. Each red id is gated behind a report-citing
`test.fixme` in `geometry.spec.ts` (KNOWN_RED / FOCUSED_KNOWN_RED).

**The unfixme protocol:** as Phases 24–28 land (24 responsive shell + tokens,
25 workspace frame, 26 core surfaces, 27 history, 28 dialogs), the owning phase
removes the corresponding fixme entries and the row flips green. Pixel
baselines of currently-red combos are still meaningful — they are the "before"
record the migration flips; `light.png` in particular intentionally records the
current dark-token render under a light color scheme until Phase 24 (SHELL-01)
lands semantic tokens, at which point it updates via §3.

## 8. Canonical reference pointer

`tests/visual/canonical/` contains sanitized design HTML and eleven rendered
reference states. Its portable checker uses the installed project Playwright
package. It is run explicitly, not imported by the application or test harness.
See `canonical/README.md` for regeneration and image review instructions.

`npm run check:privacy` scans all tracked text including canonical and guard
scripts, and verifies reviewed image hashes. New documentation images are also
included before staging. No canonical directory exemption exists.
