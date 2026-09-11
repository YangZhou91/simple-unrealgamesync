import { describe, it, expect } from "vitest";
import { formatTimestamp, parseHistoryTimestamp } from "@/lib/i18n";

describe("parseHistoryTimestamp", () => {
  it("parses space-separated YYYY-MM-DD HH:MM:SS as local wall-clock", () => {
    expect(parseHistoryTimestamp("2024-01-15 10:30:00")).toBe(
      new Date(2024, 0, 15, 10, 30, 0).getTime(),
    );
  });

  it("parses T-no-Z as the same local ms", () => {
    expect(parseHistoryTimestamp("2024-01-15T10:30:00")).toBe(
      new Date(2024, 0, 15, 10, 30, 0).getTime(),
    );
  });

  it("returns null for unparseable and empty strings", () => {
    expect(parseHistoryTimestamp("nope")).toBeNull();
    expect(parseHistoryTimestamp("")).toBeNull();
  });
});

describe("formatTimestamp", () => {
  it("returns glyph — for non-finite ms", () => {
    expect(formatTimestamp(Number.NaN, "en")).toBe("—");
  });

  it("formats midday en differently from zh", () => {
    const ms = new Date(2024, 0, 15, 12, 0, 0).getTime();
    expect(formatTimestamp(ms, "en")).not.toBe(formatTimestamp(ms, "zh"));
  });
});
