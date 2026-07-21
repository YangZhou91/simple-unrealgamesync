import { describe, it, expect } from "vitest";
import { groupWarnings } from "@/lib/groupWarnings";
import type { WarningEntry } from "@/lib/types";

// Plain-object factory typed as WarningEntry to avoid TS excess-property
// complaints on the `severity: "warning" | "error"` union literal.
function entry(
  severity: WarningEntry["severity"],
  path: string,
  message: string,
  count: number,
): WarningEntry {
  return { severity, path, message, count };
}

describe("groupWarnings", () => {
  // Behavior 1: severity split — errors and warnings land in their respective
  // arrays, preserving the per-row path as the render string.
  it("splits entries by severity into errors and warnings arrays", () => {
    const result = groupWarnings([
      entry("error", "//a", "m", 1),
      entry("warning", "//b", "m", 2),
    ]);

    expect(result.errors).toEqual(["//a"]);
    expect(result.warnings).toEqual(["//b"]);
  });

  // Behavior 2: path-only render rule — when path is non-empty and not the
  // sentinel, the row renders its PATH (message is NOT substituted).
  it("renders path when path is non-empty (message not substituted)", () => {
    const result = groupWarnings([
      entry("error", "//FY_Depot/x", "anything", 5),
    ]);

    expect(result.errors).toEqual(["//FY_Depot/x"]);
  });

  // Behavior 3 (D-13): empty path -> render message (pathless patterns like
  // `Library file missing.`).
  it("renders message when path is empty (D-13 pathless fallback)", () => {
    const result = groupWarnings([
      entry("warning", "", "Library file missing.", 1),
    ]);

    expect(result.warnings).toEqual(["Library file missing."]);
  });

  // Behavior 4 (D-12): `<truncated>` sentinel -> render message (NOT the
  // literal "<truncated>" string).
  it("renders message for the <truncated> sentinel row (D-12)", () => {
    const result = groupWarnings([
      entry(
        "warning",
        "<truncated>",
        "+N more paths suppressed (M total warnings from K distinct paths)",
        0,
      ),
    ]);

    expect(result.warnings).toEqual([
      "+N more paths suppressed (M total warnings from K distinct paths)",
    ]);
  });

  // Behavior 5: mixed input — error + warning + pathless + truncated all
  // split correctly with each row's render string chosen by the folded rule.
  it("handles a mixed batch with the folded rule applied per row", () => {
    const result = groupWarnings([
      entry("error", "//depot/missing", "no such file(s)", 3),
      entry("warning", "//depot/protected", "protected", 2),
      entry("warning", "", "Library file missing.", 1),
      entry("error", "<truncated>", "+2 more paths suppressed", 0),
    ]);

    expect(result.errors).toEqual(["//depot/missing", "+2 more paths suppressed"]);
    expect(result.warnings).toEqual([
      "//depot/protected",
      "Library file missing.",
    ]);
  });

  // Behavior 6: empty input -> both arrays empty.
  it("returns empty arrays for empty input", () => {
    const result = groupWarnings([]);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // Behavior 7: type-only — the WarningSeverity + WarningEntry types exist
  // and the widened syncCompleted variant type-checks. This is a compile-time
  // assertion; if tsc --noEmit passes, this test body runs trivially.
  it("WarningEntry type carries the 4 Rust-mirrored fields", () => {
    const e: WarningEntry = {
      severity: "warning",
      path: "//p",
      message: "m",
      count: 1,
    };

    // Touch every field so a future field rename breaks this test.
    expect(e.severity).toBe("warning");
    expect(e.path).toBe("//p");
    expect(e.message).toBe("m");
    expect(e.count).toBe(1);
  });
});
