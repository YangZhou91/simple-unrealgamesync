# Pre-Migration Geometry Report — Current UI Baseline

**Recorded:** 2026-09-08 (Phase 23, Plan 23-02, Task 2) — BEFORE any v1.8 production UI change.
**Harness:** Playwright 1.63.0 (exact pin), Chromium headless shell, ported canonical `measure()` oracle (portal-extended), `@playwright/test` config viewport height 1300.

## Context

- The current UI was built for native `minWidth` 800 (`src-tauri/tauri.conf.json`) — the 392/352 width contract is reached only via browser viewport emulation in this harness, which is the point of the harness.
- The current UI is **dark-only** (`src/index.css` forces `color-scheme: dark` with static HSL literals). Light-scheme rows render non-distinct colors pre-Phase-24 **by design** and only assert geometry (bounds), never light appearance.
- **Red rows here are the pre-migration baseline.** They are expected to flip green as Phases 24–28 land (Phase 24 responsive shell + tokens, Phase 26 core surfaces, Phase 25 workspace frame, Phase 28 dialogs). No production UI was modified to turn any row green in Phase 23 (phase boundary).

## Failure signatures (from the measure output)

| Signature | Meaning | Owning phase |
|---|---|---|
| `radix-*_trigger-history`, `radix-*_trigger-health`, tab `<svg>`/`<path>` | Dashboard tab strip overflows the root rect at narrow widths (tabs don't wrap/collapse) | Phase 24 (responsive shell) |
| `flex items-center h-10 px-4 …` history row, `w-[80px] … min-w-[80px] …` columns | History table fixed-width columns overflow the viewport at 392/352 | Phase 27 |
| `flex gap-3 … text-[13px] font-semibold …` idle card headers + badges | IdlePanel two-card grid (`min-[960px]:grid-cols-…`) overflows when the grid degenerates below 960px | Phase 24/26 |
| `h-full w-full flex-1 bg-primary transition-all` | Determinate progress indicator mounts at `translateX(-100%)` (value 0 → the full-width indicator is transformed entirely left of the root rect); `transition-all` means mid-transition frames are also outside | Phase 26 (running pipeline); indicator geometry is transform-based, not overflow-driven |
| `flex flex-col items-center gap-1.5 … h-3 w-3 …` StepIndicator clusters | Five-step indicator row overflows at 392/352 (nowrap labels) | Phase 26 |
| width-0 squeeze (`准备同步` h2, `最近项目同步` h3 hidden at 392/352) | Flex children with `min-w-0` collapse to zero width when the sidebar consumes most of the viewport — recorded as a rendering finding; the oracle skips width-0 elements per the canonical filter | Phase 24/26 |

## Matrix results — 72 combinations (9 surfaces × dark/light × 1056/768/392/352)

Result column: green = zero out-of-bounds visible elements; red = oracle reported offenders (first entries of the outside list shown, truncated).

| # | Surface | Theme | Width | Result | Offending elements (first entries) |
|---|---------|-------|-------|--------|------------------------------------|
| 1 | idle | dark | 1056 | green | — |
| 2 | running | dark | 1056 | red | `h-full w-full flex-1 bg-primary transition-all` (progress indicator at translateX(-100%)) |
| 3 | completed | dark | 1056 | green | — |
| 4 | error | dark | 1056 | green | — |
| 5 | git-running | dark | 1056 | red | `h-full w-full flex-1 bg-primary transition-all` (same indicator signature) |
| 6 | git-error | dark | 1056 | green | — |
| 7 | history | dark | 1056 | green | — |
| 8 | health | dark | 1056 | green | — |
| 9 | settings | dark | 1056 | green | — (portal in bounds) |
| 10 | idle | dark | 768 | green | — |
| 11 | running | dark | 768 | red | `h-full w-full flex-1 bg-primary transition-all` |
| 12 | completed | dark | 768 | green | — |
| 13 | error | dark | 768 | green | — |
| 14 | git-running | dark | 768 | red | `h-full w-full flex-1 bg-primary transition-all` |
| 15 | git-error | dark | 768 | green | — |
| 16 | history | dark | 768 | green | — |
| 17 | health | dark | 768 | green | — |
| 18 | settings | dark | 768 | green | — |
| 19 | idle | dark | 392 | red | `radix-_r_*_-trigger-history`, `radix-_r_*_-trigger-health`, tab `<svg>`/`<path>`, `rounded bg-sky-500/15 … text-sky-400` (Git badge), `text-muted-foreground` |
| 20 | running | dark | 392 | red | tab triggers + StepIndicator clusters (`flex flex-col items-center gap-1.5`, `h-3 w-3 …`, `text-xs whitespace-nowrap …`) |
| 21 | completed | dark | 392 | red | tab triggers + idle-card headers (`flex gap-3`, `text-[13px] font-semibold …`, sky badge) |
| 22 | error | dark | 392 | red | tab triggers + `flex gap-3`, restart-button cluster |
| 23 | git-running | dark | 392 | red | tab triggers + tab icons |
| 24 | git-error | dark | 392 | red | tab triggers + tab icons |
| 25 | history | dark | 392 | red | `radix-_r_*_-trigger-health` + history rows (`flex items-center h-10 px-4 …`, `w-[80px] … min-w-[80px]` columns) |
| 26 | health | dark | 392 | green | — |
| 27 | settings | dark | 392 | red | tab triggers + idle-card headers visible behind portal overlay |
| 28 | idle | dark | 352 | red | tab triggers + icons + idle-card headers |
| 29 | running | dark | 352 | red | tab triggers + StepIndicator clusters |
| 30 | completed | dark | 352 | red | tab triggers + idle-card headers |
| 31 | error | dark | 352 | red | tab triggers + `flex gap-3` + restart cluster |
| 32 | git-running | dark | 352 | red | tab triggers + icons |
| 33 | git-error | dark | 352 | red | tab triggers + icons + back-button |
| 34 | history | dark | 352 | red | `radix-_r_*_-trigger-health` + history rows/columns |
| 35 | health | dark | 352 | green | — |
| 36 | settings | dark | 352 | red | tab triggers + idle-card headers behind portal |
| 37 | idle | light | 1056 | green | — (non-distinct light render expected pre-Phase-24; bounds only) |
| 38 | running | light | 1056 | red | `h-full w-full flex-1 bg-primary transition-all` |
| 39 | completed | light | 1056 | green | — |
| 40 | error | light | 1056 | green | — |
| 41 | git-running | light | 1056 | red | `h-full w-full flex-1 bg-primary transition-all` |
| 42 | git-error | light | 1056 | green | — |
| 43 | history | light | 1056 | green | — |
| 44 | health | light | 1056 | green | — |
| 45 | settings | light | 1056 | green | — |
| 46 | idle | light | 768 | green | — |
| 47 | running | light | 768 | red | `h-full w-full flex-1 bg-primary transition-all` |
| 48 | completed | light | 768 | green | — |
| 49 | error | light | 768 | green | — |
| 50 | git-running | light | 768 | red | `h-full w-full flex-1 bg-primary transition-all` |
| 51 | git-error | light | 768 | green | — |
| 52 | history | light | 768 | green | — |
| 53 | health | light | 768 | green | — |
| 54 | settings | light | 768 | green | — |
| 55 | idle | light | 392 | red | tab triggers + sky badge + muted text |
| 56 | running | light | 392 | red | tab triggers + StepIndicator clusters |
| 57 | completed | light | 392 | red | tab triggers + idle-card headers |
| 58 | error | light | 392 | red | tab triggers + `flex gap-3` + restart cluster |
| 59 | git-running | light | 392 | red | tab triggers + icons |
| 60 | git-error | light | 392 | red | tab triggers + icons |
| 61 | history | light | 392 | red | health trigger + history rows/columns |
| 62 | health | light | 392 | green | — |
| 63 | settings | light | 392 | red | tab triggers + sky badge + muted text |
| 64 | idle | light | 352 | red | tab triggers + icons + idle-card headers |
| 65 | running | light | 352 | red | tab triggers + StepIndicator clusters |
| 66 | completed | light | 352 | red | tab triggers + idle-card headers |
| 67 | error | light | 352 | red | tab triggers + `flex gap-3` + restart cluster |
| 68 | git-running | light | 352 | red | tab triggers + icons |
| 69 | git-error | light | 352 | red | tab triggers + icons + back-button |
| 70 | history | light | 352 | red | health trigger + history rows/columns |
| 71 | health | light | 352 | green | — |
| 72 | settings | light | 352 | red | tab triggers + idle-card headers behind portal |

**Matrix tally: 32 green / 40 red.**

## Focused states

| Focused state | Result | Offending elements / note |
|---|---|---|
| target+engine 1056 | green | CL 381700 + engine checked, hint ON — in bounds |
| target+engine 352 | red | tab triggers + idle-card headers (narrow-width overflow) |
| health-empty dark-1056 | green | pre-Audit empty hint in bounds |
| rollback-confirm dark-1056 | green | Radix portal confirmation stage in bounds (portal extension exercised) |
| app-settings-proxy-on dark-1056 | green | proxy enabled + URL input active — in bounds |
| add-workspace dark-1056 | green | form dialog portal in bounds |
| no-workspace dark-1056 | green | WorkspaceEmptyState in bounds |
| cancel-pending dark-1056 | red | `h-full w-full flex-1 bg-primary transition-all` (progress indicator signature; cancelling button held disabled) |
| git-success dark-1056 | green | success banner + Back button in bounds |
| long-workspace-names dark-352 | red | tab triggers + idle-card headers (long names render, sidebar truncates; overflow from shell not names) |
| english-at-352 dark-352 | red | tab triggers + idle-card headers (English copy) |

**Focused tally: 7 green / 4 red.**

## KNOWN_RED gate mapping

Every red row above is gated in `tests/visual/specs/geometry.spec.ts` via `KNOWN_RED` + `test.fixme` with a citation to this report. Unfixme as the owning phase lands:

- **Phase 24 (Semantic Themes, Custom Titlebar & Responsive Shell):** all 392/352 tab-strip overflow signatures (rows 19–36, 55–72 narrow columns), width-0 squeeze findings.
- **Phase 26 (Core Sync & Git Surfaces):** the `translateX(-100%)` determinate progress-indicator signature (running/git-running/cancel-pending at every width — rows 2, 5, 11, 14, 38, 41, 47, 50), StepIndicator clusters.
- **Phase 27 (History, Rollback & Workspace Health):** history row/column overflow at 392/352.

**Determinism:** two consecutive full-suite runs (83 tests) produced identical red sets — 40/72 matrix red, 4/11 focused red, zero flaky rows.

---

## Phase 24 flip/triage ledger (Plan 24-04, 2026-09-09)

The full matrix re-run ungated after the Phase 24 responsive shell + semantic
tokens + custom titlebar landed (24-01/24-02/24-03). Gate locally neutralized
(scratch edit, file restored byte-identical), JSON-reporter run over all 83
tests. **24 of the 40 matrix reds and 3 of the 4 focused reds flipped green;
25 ids total remain red, every one citing its CURRENT offender signature and
a later owning phase.** Tally after the flip: 48/72 matrix green (was 32),
10/11 focused green (was 7). Gated suite: 58 passed + 25 skipped, exit 0.

### Flipped green (19 ids — unfixme'd, removed from KNOWN_RED/FOCUSED_KNOWN_RED)

All Phase-24-owned narrow shell signatures cleared: the tab-strip overflow
(`radix-*_trigger-*`, tab `<svg>`/`<path>`), idle-card headers, sky badge,
muted text, restart/back clusters, and the recorded width-0 squeezes.

| Report row | id | Pre-migration offenders | Post-flip evidence |
|---|---|---|---|
| 19 | idle-dark-392 | tab triggers + sky badge + muted text | oracle green, width-0 probe green |
| 21 | completed-dark-392 | tab triggers + idle-card headers | oracle green, width-0 probe green |
| 22 | error-dark-392 | tab triggers + `flex gap-3` + restart cluster | oracle green, width-0 probe green |
| 24 | git-error-dark-392 | tab triggers + tab icons | oracle green, width-0 probe green |
| 28 | idle-dark-352 | tab triggers + icons + idle-card headers | oracle green, width-0 probe green |
| 30 | completed-dark-352 | tab triggers + idle-card headers | oracle green, width-0 probe green |
| 31 | error-dark-352 | tab triggers + `flex gap-3` + restart cluster | oracle green, width-0 probe green |
| 33 | git-error-dark-352 | tab triggers + icons + back-button | oracle green, width-0 probe green |
| 55 | idle-light-392 | tab triggers + sky badge + muted text | oracle green, width-0 probe green |
| 57 | completed-light-392 | tab triggers + idle-card headers | oracle green, width-0 probe green |
| 58 | error-light-392 | tab triggers + `flex gap-3` + restart cluster | oracle green, width-0 probe green |
| 60 | git-error-light-392 | tab triggers + icons | oracle green, width-0 probe green |
| 64 | idle-light-352 | tab triggers + icons + idle-card headers | oracle green, width-0 probe green |
| 66 | completed-light-352 | tab triggers + idle-card headers | oracle green, width-0 probe green |
| 67 | error-light-352 | tab triggers + `flex gap-3` + restart cluster | oracle green, width-0 probe green |
| 69 | git-error-light-352 | tab triggers + icons + back-button | oracle green, width-0 probe green |
| focused | target+engine-dark-352 | tab triggers + idle-card headers | oracle green (matches 24-03 evidence) |
| focused | long-workspace-names-dark-352 | tab triggers + idle-card headers | oracle green (matches 24-03 evidence) |
| focused | english-at-352-dark-352 | tab triggers + idle-card headers | oracle green (matches 24-03 evidence) |

**Width-0 laundering guard (research Pitfall 5 warning):** before the unfixme,
a scratch probe asserted at 392 and 352, both themes, for every flipping
surface: (a) every `[role=tab]` renders with width > 0 and inside the
viewport (the previously-offending tab strip is in bounds, not collapsed);
(b) zero visible elements with height > 0 but width 0 across the tree (SVG
icon internals excluded — icon geometry, not layout boxes); (c) the two
recorded squeeze findings — `准备同步` h2 (idle) and `最近项目同步` h3
(completed) — render with width > 0. **24/24 probes green: no row flips via
width-0 collapse.**

### Stays red (25 ids — re-triaged with current offenders + owning phase)

| Report rows | ids | Current offender signature (post-shell) | Owning phase |
|---|---|---|---|
| 2, 5, 11, 14, 38, 41, 47, 50 | running/git-running @ 1056/768 both themes | `h-full w-full flex-1 bg-primary transition-all` (progress fill mounts at translateX(-100%)) | Phase 26 |
| 20, 23, 29, 32, 56, 59, 65, 68 | running/git-running @ 392/352 both themes | same progress-fill signature; running rows additionally StepIndicator clusters (`flex flex-col items-center gap-1.5`, `text-xs whitespace-nowrap`) — tab-strip offenders GONE | Phase 26 |
| 25, 34, 61, 70 | history @ 392/352 both themes | `flex items-center h-10 px-4 …` history rows + `min-w-[80px] shrink-0` fixed columns | Phase 27 |
| focused | cancel-pending-dark-1056 | progress-fill translateX(-100%) signature | Phase 26 |

Notes on judgment calls (CONTEXT-granted discretion):
- **history rows (Pitfall 5):** their tab-strip co-offenders cleared with the
  shell, but the primary history-row/column offenders remain — unfixme
  requires ALL offenders non-Phase-24-owned; these stay red per protocol.
- **settings rows (Phase 25 unfixme):** `settings-dark-392`, `settings-dark-352`, `settings-light-392`, and `settings-light-352` were run ungated on 2026-09-09 after the narrow footer trigger landed. All four opened the real Settings portal and passed strict root/portal bounds at ±1px (geometry run: 62 passed / 21 later-owned skips). They are now enforced rows; Settings-dialog internals remain Phase 28-owned.
- **running @ 392/352:** strictly MORE offenders visible now than
  pre-migration (the shell no longer masks surface overflow behind the
  tab-strip offenders) — still all Phase 26 signatures.

All 44 previously-red ids are accounted for: 23 flipped + 21 re-triaged.

---

## Phase 26 flip/triage ledger (Plan 26-04, 2026-09-10)

The full matrix re-run ungated after the Phase 26 core sync/Git surfaces
landed (26-01 idle/target/result cards, 26-02 running pipeline with the
contained progress fill + responsive five-step rail, 26-03 error + Git
surfaces). Gate locally neutralized (scratch edit, file restored
byte-identical), full-suite run over all 83 tests. **The 16 running/
git-running matrix rows and the focused cancel-pending row flipped green;
the four Phase-27-owned history rows are the only remaining failures.**
Tally after the flip: 68/72 matrix green (was 52), 11/11 focused green
(was 10). Gated suite after promotion: 79 passed + 4 skipped, exit 0.

### Flipped green (17 ids — unfixme'd, removed from KNOWN_RED/FOCUSED_KNOWN_RED)

All Phase-26-owned signatures cleared: the determinate progress fill is now
a contained width-based element (the `translateX(-100%)` full-width mount
signature is gone from the DOM) and the five-step rail reflows responsively
(the old nowrap StepIndicator clusters are gone).

| Report row | id | Pre-migration offenders | Post-flip evidence |
|---|---|---|---|
| 2 | running-dark-1056 | `h-full w-full flex-1 bg-primary transition-all` (indicator at translateX(-100%)) | oracle green, width-0 probe green |
| 5 | git-running-dark-1056 | same progress-fill signature | oracle green, width-0 probe green |
| 11 | running-dark-768 | progress-fill signature | oracle green, width-0 probe green |
| 14 | git-running-dark-768 | progress-fill signature | oracle green, width-0 probe green |
| 38 | running-light-1056 | progress-fill signature | oracle green, width-0 probe green |
| 41 | git-running-light-1056 | progress-fill signature | oracle green, width-0 probe green |
| 47 | running-light-768 | progress-fill signature | oracle green, width-0 probe green |
| 50 | git-running-light-768 | progress-fill signature | oracle green, width-0 probe green |
| 20 | running-dark-392 | progress fill + StepIndicator clusters (`flex flex-col items-center gap-1.5`, `text-xs whitespace-nowrap`) | oracle green, width-0 probe green |
| 23 | git-running-dark-392 | progress-fill signature | oracle green, width-0 probe green |
| 29 | running-dark-352 | progress fill + StepIndicator clusters | oracle green, width-0 probe green |
| 32 | git-running-dark-352 | progress-fill signature | oracle green, width-0 probe green |
| 56 | running-light-392 | progress fill + StepIndicator clusters | oracle green, width-0 probe green |
| 59 | git-running-light-392 | progress-fill signature | oracle green, width-0 probe green |
| 65 | running-light-352 | progress fill + StepIndicator clusters | oracle green, width-0 probe green |
| 68 | git-running-light-352 | progress-fill signature | oracle green, width-0 probe green |
| focused | cancel-pending-dark-1056 | progress-fill translateX(-100%) signature (disabled Cancelling held) | oracle green, width-0 probe green |

**Width-0 laundering guard (same Pitfall-5 protocol as Phase 24):** before
the unfixme, an ephemeral probe (not committed) asserted at 392 and 352,
both themes, for both the running and git-running surfaces: (a) every
`[role=tab]` renders with width > 0 and inside the viewport; (b) zero
visible elements with height > 0 but width 0 across the tree (SVG icon
internals excluded — icon geometry, not layout boxes); (c) the five step
labels (running surface), the determinate progress number, the 5px progress
track, and the Cancel / Cancel Pull controls each report width > 0.
**8/8 probes green: no row flips via width-0 collapse.**

### Ungated run evidence

- Pre-flight gates green on the tree under test (this session, 2026-09-10):
  `npm run check:harness` (7/7 checks), `npm test` (403 passed / 33 files),
  `npm run build` (vite production), `npm run typecheck:visual`.
- Width-0 probe (ephemeral `tests/visual/specs/_probe-width0.spec.ts`, not
  committed): **8/8 passed (7.9s)** at 392/352 × dark/light ×
  running/git-running. Tabs 同步/历史/健康 all w>0 and in-viewport
  (89.3px @392, 76.0px @352); zero non-SVG visible width-0 elements;
  five running step labels all w>0 (关闭 UE 编辑器 111.9, 关闭 Excel 84.6,
  清理 Dev 目录 106.0, 同步文件 79.0, 生成项目文件 103.0); progress
  number + 5px track 330px @392 / 290px @352; Cancel 取消同步 106px and
  Cancel Pull 取消拉取 106px.
- Scratch-ungated full suite (KNOWN_RED emptied then restored):
  **79 passed / 4 failed (34.5s)** — the only failures are
  history-dark-392, history-dark-352, history-light-392, and
  history-light-352, offender signature `flex items-center h-10 px-4 …`
  rows + `min-w-[80px] shrink-0` fixed columns (Phase-27-owned), confirming
  the 17 promoted rows pass strictly (zero out-of-bounds, zero page errors).
- Post-promotion gated run: **79 passed / 4 skipped (30.8s)**, exit 0.
- Determinism: consecutive runs across the phase (26-02 scratch 17 passed,
  26-03 scratch 8 passed git-running, this ungated run 79/4) produced
  identical red sets — zero flaky rows.

### Stays red (4 ids — re-triaged, Phase-27-owned)

| Report rows | ids | Current offender signature | Owning phase |
|---|---|---|---|
| 25, 34, 61, 70 | history @ 392/352 both themes | `flex items-center h-10 px-4 …` history rows + `min-w-[80px] shrink-0` fixed columns | Phase 27 |

All 21 previously-gated ids are accounted for: 17 flipped + 4 re-triaged.

---

## Phase 27 flip/triage ledger (Plan 27-04, 2026-09-10)

The full matrix re-run ungated after the Phase 27 HistoryTab scan table
landed (27-01 Virtuoso + min-w-0 truncate-by-data-role, 27-02 health,
27-03 rollback chrome) plus a Plan 27-04 Rule-1 width repair: the
LogViewer-copied `flex` (row) wrapper around Virtuoso collapsed the
scroller to width 0 at 392/352 (`overflow: auto` + default `flex-shrink`
on the scroller). The wrapper is now a block `min-w-0 flex-1
overflow-hidden` box and Virtuoso is `h-full w-full`. Gate locally
neutralized (scratch-empty KNOWN_RED, file restored byte-identical),
full-suite run over all 83 tests. **The four Phase-27-owned history
rows flipped green; KNOWN_RED and FOCUSED_KNOWN_RED are empty.** Tally
after the flip: 72/72 matrix green (was 68), 11/11 focused green.
Gated suite after promotion: 83 passed / 0 skipped, exit 0.

The non-shrinking column flags (`min-w-[80px] shrink-0`, `w-[120px]`
CL Badge) left the DOM in Plan 27-01; they are not present on the
promoted HistoryTab. Wrap-at-620px / drop-`h-10` was not required —
one-line `h-10` rows stay in bounds once Virtuoso has a real width.

### Flipped green (4 ids — unfixme'd, removed from KNOWN_RED)

| Report row | id | Pre-migration offenders | Post-flip evidence |
|---|---|---|---|
| 25 | history-dark-392 | `flex items-center h-10 px-4 …` rows + `min-w-[80px] shrink-0` / `w-[120px]` CL column | oracle green, width-0 probe green |
| 34 | history-dark-352 | history row cells + fixed columns | oracle green, width-0 probe green |
| 61 | history-light-392 | health trigger + history rows/columns | oracle green, width-0 probe green |
| 70 | history-light-352 | health trigger + history rows/columns | oracle green, width-0 probe green |

**Width-0 laundering guard (same Pitfall-5 protocol as Phase 24/26):**
before the unfixme, an ephemeral probe (not committed) asserted at 392
and 352, both themes, on the history surface and the health tab: (a)
every `[role=tab]` renders with width > 0 and inside the viewport; (b)
zero visible non-SVG elements with height > 0 but width 0; (c) Rollback
button width > 0 and labelled; (d) each populated history row cell
width > 0; (e) Health Audit labelled and width > 0. **8/8 probes green:
no row flips via width-0 collapse.**

### Ungated run evidence

- Pre-flight gates green on the tree under test (this session, 2026-09-10):
  `npm run check:harness` (7/7 checks), `npm test` (419 passed / 33 files),
  `npm run build` (vite production), `npm run typecheck:visual`.
- Width-0 probe (ephemeral `tests/visual/specs/_probe-width0.spec.ts`, not
  committed): **8/8 passed (8.6s)** at 392/352 × dark/light ×
  history/health. Tabs 同步/历史/健康 all w>0 and in-viewport; Rollback
  `回滚历史` 106px labelled; Audit `检查` labelled w>0; populated history
  cells 87px @392 (right edge 370 / viewport 392) and 77px @352 (right
  edge 330 / viewport 352); zero non-SVG visible width-0 elements.
- Scratch-ungated full suite (KNOWN_RED emptied then restored):
  **83 passed / 0 failed (34.6s)** — including history-dark-392,
  history-dark-352, history-light-392, and history-light-352, confirming
  the four promoted rows pass strictly (zero out-of-bounds, zero page
  errors).
- Post-promotion gated run: **83 passed / 0 skipped (34.5s)**, exit 0.
- Determinism: consecutive runs this session (width-0 8/8, ungated 83/0)
  produced identical green sets — zero flaky rows.

### Stays red (0 ids)

No matrix or focused combination remains gated. The non-shrinking
column flags have left the DOM.
