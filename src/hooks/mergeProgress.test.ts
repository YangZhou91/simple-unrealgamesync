import { describe, it, expect } from "vitest";
import { mergeProgress, type ProgressState, type ProgressEvent } from "@/hooks/mergeProgress";

describe("mergeProgress", () => {
  // Behavior 1: drain-null does NOT overwrite known byte values (sticky merge).
  it("drain null does not overwrite known bytes", () => {
    const prev: ProgressState = {
      current: 100,
      total: 200,
      currentFile: "a.uasset",
      bytesDone: 300_000_000,
      bytesTotal: 4_000_000_000,
      bytesRate: 45_000_000,
    };
    // Build event via a plain object literal typed as ProgressEvent to avoid
    // TS excess-property complaints on the optional byte fields (mirrors the
    // pattern in SyncDashboard.test.tsx where spread-from-variable dodges
    // narrow-type checks).
    const eventData: ProgressEvent = {
      current: 101,
      total: 200,
      currentFile: "b.uasset",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    const result = mergeProgress(prev, eventData);

    // Byte fields are sticky — preserved from prev because event carries null.
    expect(result.bytesDone).toBe(300_000_000);
    expect(result.bytesTotal).toBe(4_000_000_000);
    expect(result.bytesRate).toBe(45_000_000);

    // Count/file fields are NOT sticky — always taken from event.
    expect(result.current).toBe(101);
    expect(result.total).toBe(200);
    expect(result.currentFile).toBe("b.uasset");
  });

  // Behavior 2: Some byte value updates bytes (Some wins over prev).
  it("Some updates bytes", () => {
    const prev: ProgressState = {
      current: 100,
      total: 200,
      currentFile: "a.uasset",
      bytesDone: 300_000_000,
      bytesTotal: 4_000_000_000,
      bytesRate: 45_000_000,
    };
    const eventData: ProgressEvent = {
      current: 150,
      total: 200,
      currentFile: "c.uasset",
      bytesDone: 350_000_000,
      bytesTotal: 4_000_000_000,
      bytesRate: 50_000_000,
    };
    const result = mergeProgress(prev, eventData);

    // Byte fields carry real numbers — they win over prev.
    expect(result.bytesDone).toBe(350_000_000);
    expect(result.bytesTotal).toBe(4_000_000_000);
    expect(result.bytesRate).toBe(50_000_000);

    // Count/file always track the event.
    expect(result.current).toBe(150);
    expect(result.total).toBe(200);
    expect(result.currentFile).toBe("c.uasset");
  });

  // Behavior 3: first event with null bytes stays null (no false signal invented).
  it("first event with null bytes stays null", () => {
    const prev: ProgressState = {
      current: 0,
      total: 0,
      currentFile: "",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    const eventData: ProgressEvent = {
      current: 1,
      total: 200,
      currentFile: "x",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    const result = mergeProgress(prev, eventData);

    // No prev byte value to sticky from — stays null, no invented signal.
    expect(result.bytesDone).toBeNull();
    expect(result.bytesTotal).toBeNull();
    expect(result.bytesRate).toBeNull();

    // Count/file still track the event.
    expect(result.current).toBe(1);
    expect(result.total).toBe(200);
    expect(result.currentFile).toBe("x");
  });

  // Behavior 4: cross-check current/total/currentFile ALWAYS track event across
  // all three scenarios above (explicit assertion that count fields never stick).
  it("current/total/currentFile always track event, never prev", () => {
    const prev: ProgressState = {
      current: 999,
      total: 999,
      currentFile: "prev-file.uasset",
      bytesDone: 1,
      bytesTotal: 2,
      bytesRate: 3,
    };
    const eventData: ProgressEvent = {
      current: 7,
      total: 42,
      currentFile: "event-file.uasset",
      bytesDone: null,
      bytesTotal: null,
      bytesRate: null,
    };
    const result = mergeProgress(prev, eventData);

    expect(result.current).toBe(7);
    expect(result.total).toBe(42);
    expect(result.currentFile).toBe("event-file.uasset");
  });

  // Extra robustness: undefined byte fields (omitted, as the type allows) also
  // fall back to prev — same sticky semantics as null. Defends against backend
  // paths that may omit the field rather than sending explicit null.
  it("undefined byte fields fall back to prev (sticky)", () => {
    const prev: ProgressState = {
      current: 10,
      total: 20,
      currentFile: "a.uasset",
      bytesDone: 100,
      bytesTotal: 200,
      bytesRate: 5,
    };
    const eventData: ProgressEvent = {
      current: 11,
      total: 20,
      currentFile: "b.uasset",
      // byte fields omitted entirely
    };
    const result = mergeProgress(prev, eventData);

    expect(result.bytesDone).toBe(100);
    expect(result.bytesTotal).toBe(200);
    expect(result.bytesRate).toBe(5);
    expect(result.current).toBe(11);
    expect(result.currentFile).toBe("b.uasset");
  });
});
