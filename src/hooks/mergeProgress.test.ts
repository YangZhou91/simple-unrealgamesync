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

  // Regression (quick-260707-s1y): p4 `--parallel=4` bursts writes; the
  // ~0.5Hz heartbeat samples disk_usage delta and roughly every other tick
  // observes delta=0 → rate_bytes_per_sec=0. The heartbeat emits `Some(0)`.
  // The OLD merge `bytesRate: event.bytesRate ?? prev.bytesRate` treats
  // `Some(0)` as a real value, so 0 clobbers the prior real rate.
  // Downstream ProgressSection renders `bytesRate ? "· X MB/s" : ""` — 0 is
  // falsy, so the rate suffix blinks off for one tick then back on. Fix:
  // mergeProgress rejects 0 (only strictly-positive values win). This test
  // models real heartbeats as a sequence of merges on a rolling prev.
  describe("rate=0 heartbeat does not clobber sticky rate (parallel-transfer flicker fix)", () => {
    it("rejects bytesRate=0 and keeps the previous non-zero rate sticky", () => {
      // Start with a real sampled rate (58 MB/s) from a prior heartbeat.
      let prev: ProgressState = {
        current: 1000,
        total: 5000,
        currentFile: "BigAsset.uasset",
        bytesDone: 300_000_000,
        bytesTotal: 4_000_000_000,
        bytesRate: 58_000_000,
      };

      // Tick 1: heartbeat samples delta=0 → emits Some(0). CORE ASSERTION:
      // the rate must STAY 58_000_000 (0 does NOT clobber the sticky rate).
      const tick1: ProgressEvent = {
        current: 1001,
        total: 5000,
        currentFile: "BigAsset.uasset",
        bytesDone: 305_000_000,
        bytesTotal: 4_000_000_000,
        bytesRate: 0,
      };
      let result = mergeProgress(prev, tick1);
      expect(result.bytesRate).toBe(58_000_000);
      // bytesDone/bytesTotal still carry the event value (NOT sticky-nonzero —
      // the 0-rejection is specific to bytesRate).
      expect(result.bytesDone).toBe(305_000_000);
      expect(result.bytesTotal).toBe(4_000_000_000);

      // Tick 2: a later positive sample (33 MB/s) still wins — proves the
      // sticky-rate is not "stuck forever on the first non-zero value".
      prev = result;
      const tick2: ProgressEvent = {
        current: 1002,
        total: 5000,
        currentFile: "BigAsset.uasset",
        bytesDone: 338_000_000,
        bytesTotal: 4_000_000_000,
        bytesRate: 33_000_000,
      };
      result = mergeProgress(prev, tick2);
      expect(result.bytesRate).toBe(33_000_000);

      // Tick 3: a drain event (bytesRate=null, bytesDone/bytesTotal null too)
      // — null still sticky from prev (existing drain behavior preserved).
      prev = result;
      const tick3: ProgressEvent = {
        current: 1003,
        total: 5000,
        currentFile: "OtherAsset.uasset",
        bytesDone: null,
        bytesTotal: null,
        bytesRate: null,
      };
      result = mergeProgress(prev, tick3);
      expect(result.bytesRate).toBe(33_000_000);
    });

    it("first-tick rate=0 stays null when prev.bytesRate is null (no invented signal)", () => {
      // Edge case: prev has no rate yet (first heartbeat was null/0). A 0
      // must NOT invent a signal — stays null (matches the existing "first
      // event with null bytes stays null" contract).
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
        total: 5000,
        currentFile: "FirstAsset.uasset",
        bytesRate: 0,
      };
      const result = mergeProgress(prev, eventData);
      expect(result.bytesRate).toBeNull();
    });
  });
});
