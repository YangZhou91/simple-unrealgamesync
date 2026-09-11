/**
 * Pure git-pull progress reducer.
 *
 * Phase 15 (GPULL-25 / SC#2): decides whether the GitRunningPanel progress bar
 * renders DETERMINATE (git's own `%` is flowing — `Receiving/Resolving/Compressing
 * objects: N%`) or INDETERMINATE (a no-% sub-step is running — stash / restore /
 * genProject / pre-network Counting/Enumerating — surfaced via the D-03
 * `StepStarted{description}` label).
 *
 * The flip is driven by `StepStarted` sub-step BOUNDARIES, NOT a timeout
 * (RESEARCH Open Question 3): a timeout would flicker the bar during
 * legitimate `%` gaps in a large transfer. Instead `useGit` resets
 * `percent` to `null` when a no-% `StepStarted` arrives, and the next
 * `Progress{percent}` repopulates it — this reducer reads that state.
 *
 * Dependency-free: no React, no Tauri, no I/O — trivially unit-testable.
 * Mirrors the `groupWarnings.ts` pure-helper precedent.
 *
 * Phase 15 Plan 03 (D-02 / GPULL-25 / SC#2).
 */

/**
 * The git progress state `useGit` stores on each `Progress{percent}` event.
 *
 * - `percent`: the latest git `%` (0-100), or `null` when a no-% sub-step
 *   cleared it. `!= null` is the determinate signal.
 * - `phase`: the git phase string the backend carries alongside the percent
 *   (best-effort label source: "receiving" / "resolving" / "compressing").
 *   May be `null` / empty — the label is best-effort, the percent is
 *   load-bearing.
 * - `ts`: when the event arrived (Date.now()). Not consulted by the reducer;
 *   kept for future staleness/elapsed logic and to mirror useSync's ProgressState.
 */
export interface GitProgressState {
  percent: number | null;
  phase: string | null;
  ts: number;
}

/**
 * The bar render mode GitRunningPanel passes to ProgressSection.
 * - "determinate"   — `<Progress value={percent} />`, label "Receiving objects 67%".
 * - "indeterminate" — `<Progress indeterminate />`, label = the D-03 sub-step.
 */
export type GitBarMode = "determinate" | "indeterminate";

/**
 * Decide the git bar render mode from the latest progress state + sub-step label.
 *
 * Contract (SC#2 flip-back):
 *   - `progress != null && progress.percent != null`  -> "determinate"
 *     (a `Progress{percent}` arrived after the last no-% `StepStarted`; the
 *      bar climbs with git's `%`).
 *   - otherwise                                        -> "indeterminate"
 *     (either no progress yet, or a no-% `StepStarted` cleared `percent`;
 *      the bar shows the D-03 sub-step label + the latest log line).
 *
 * `lastStepStarted` is the latest `StepStarted.description` (e.g.
 * "Saving local changes…"). It is NOT directly consulted by the decision — the
 * determinate/indeterminate flip is encoded in whether `percent` is present
 * (`useGit` clears `percent` on a no-% `StepStarted`). The param is accepted so
 * the reducer signature documents the data flow and stays stable for a future
 * label-aware variant. The caller renders `lastStepStarted` as the indeterminate
 * label.
 *
 * Pure: no `Date.now()`, no side effects, no React, no Tauri.
 */
export function decideGitBarMode(
  progress: GitProgressState | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _lastStepStarted: string | null,
): GitBarMode {
  if (progress != null && progress.percent != null) {
    return "determinate";
  }
  return "indeterminate";
}
