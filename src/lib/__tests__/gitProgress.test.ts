import { describe, it, expect } from "vitest";
import { decideGitBarMode } from "@/lib/gitProgress";
import type { GitProgressState } from "@/lib/gitProgress";

// Factory for the GitProgressState shape useGit stores. Keeps the flip-back
// sequence test readable (rolling prev modeled as a series of reducer calls).
function state(percent: number | null, phase: string | null = null): GitProgressState {
  return { percent, phase, ts: 0 };
}

describe("decideGitBarMode", () => {
  // Behavior 1 (GPULL-24 determinate): a recent percent -> determinate bar.
  it("returns determinate when a recent percent exists", () => {
    expect(decideGitBarMode(state(67), null)).toBe("determinate");
    expect(decideGitBarMode(state(0), null)).toBe("determinate"); // 0% is still a %
    expect(decideGitBarMode(state(100), null)).toBe("determinate");
  });

  // Behavior 2 (GPULL-25 indeterminate): percent null -> indeterminate fallback.
  it("returns indeterminate when percent is null", () => {
    expect(decideGitBarMode(state(null), null)).toBe("indeterminate");
  });

  // Behavior 3 (GPULL-25 indeterminate): no progress yet, a no-% sub-step started.
  it("returns indeterminate when progress is null and a sub-step started", () => {
    expect(decideGitBarMode(null, "Saving local changes…")).toBe("indeterminate");
  });

  // Behavior 4: no progress AND no sub-step label -> indeterminate (the initial
  // "Working…" state before any event arrives).
  it("returns indeterminate when both progress and lastStepStarted are null", () => {
    expect(decideGitBarMode(null, null)).toBe("indeterminate");
  });

  // Behavior 5: a sub-step label is present BUT percent is also present ->
  // determinate wins (a fresh Progress{percent} arrived AFTER the StepStarted,
  // flipping the bar back to determinate — SC#2 flip-back tail).
  it("returns determinate when percent is present even if a sub-step label is also set", () => {
    // This models: StepStarted("Restoring…") -> indeterminate, THEN a stray
    // Progress{percent: 45} arrives -> flips back to determinate.
    expect(decideGitBarMode(state(45), "Restoring local changes…")).toBe("determinate");
  });

  // Behavior 6 (SC#2 flip-back SEQUENCE): the canonical GPULL-25 contract —
  // modeled as rolling reducer calls on evolving state. Mirrors the
  // mergeProgress.test.ts "rolling prev" sequence pattern (L164-220).
  describe("SC#2 flip-back sequence (determinate -> indeterminate -> determinate)", () => {
    it("flips determinate -> indeterminate on a no-% StepStarted, then back on the next Progress{percent}", () => {
      // Event 1: git emits "Receiving objects: 67%" -> useGit stores percent=67.
      // The reducer sees percent=67 -> determinate.
      let progress: GitProgressState | null = state(67, "receiving");
      let lastStep: string | null = null;
      expect(decideGitBarMode(progress, lastStep)).toBe("determinate");

      // Event 2: git finishes Receiving, backend emits StepStarted{description:
      // "Restoring local changes…"} (D-03 sub-step). useGit captures the label
      // AND resets percent to null (the no-% sub-step clears the determinate
      // signal). The reducer -> indeterminate.
      lastStep = "Restoring local changes…";
      progress = progress ? { ...progress, percent: null } : progress;
      expect(decideGitBarMode(progress, lastStep)).toBe("indeterminate");

      // Event 3: a new Progress{percent: 30} arrives (e.g. a resumed phase or
      // a second git transfer). useGit stores percent=30. The reducer -> determinate.
      progress = state(30, "resolving");
      expect(decideGitBarMode(progress, lastStep)).toBe("determinate");

      // Event 4: stash sub-step starts again (Saving local changes…) — percent
      // cleared, label set -> indeterminate (round-trip back to indeterminate).
      lastStep = "Saving local changes…";
      progress = progress ? { ...progress, percent: null } : progress;
      expect(decideGitBarMode(progress, lastStep)).toBe("indeterminate");
    });

    it("stays determinate across a burst of percent updates (no flicker)", () => {
      // git emits a burst of Receiving objects % updates as bytes stream in.
      // Each one keeps the bar determinate — no StepStarted interleaved.
      let progress: GitProgressState | null = state(1, "receiving");
      expect(decideGitBarMode(progress, null)).toBe("determinate");
      progress = state(45, "receiving");
      expect(decideGitBarMode(progress, null)).toBe("determinate");
      progress = state(99, "receiving");
      expect(decideGitBarMode(progress, null)).toBe("determinate");
      progress = state(100, "receiving");
      expect(decideGitBarMode(progress, null)).toBe("determinate");
    });
  });

  // Behavior 7: type-only — the GitProgressState shape is stable (a future
  // field rename breaks this test). Compile-time assertion; if tsc passes this
  // runs trivially.
  it("GitProgressState carries percent, phase, ts", () => {
    const s: GitProgressState = { percent: 50, phase: "compressing", ts: 1234 };
    expect(s.percent).toBe(50);
    expect(s.phase).toBe("compressing");
    expect(s.ts).toBe(1234);
  });
});
