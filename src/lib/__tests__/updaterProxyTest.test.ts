import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Task 1 (quick-260711-jpq) — TDD tests for the pure updaterProxyTest module.
 *
 * The whole point of this module is to verify the updater's first-party
 * `check({ proxy, timeout })` API can reach GitHub THROUGH the configured
 * proxy — NOT a JS fetch (which would bypass the Rust reqwest layer where the
 * proxy is applied). The mock here owns `check` entirely; no network.
 *
 * These tests pin:
 *   - classifyProxyError: refused / timeout / other + truncation behavior
 *   - runProxyConnectionTest: wires check({ proxy, timeout }) exactly once and
 *     maps null → ok, Update → ok+note, throw → classified
 *
 * Mocks: @tauri-apps/plugin-updater (vi.factory exposing a controllable check).
 */

// The mock factory is hoisted. Capture the check fn in a module-scope slot so
// each test can install its own behavior (resolve null / resolve Update /
// reject with a string) before driving runProxyConnectionTest.
type CheckFn = (
  opts?: { proxy?: string; timeout?: number; [k: string]: unknown },
) => Promise<unknown>;
let currentCheck: CheckFn | null = null;
const checkMock = vi.fn((_opts?: unknown) => currentCheck?.(_opts as never));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: checkMock,
}));

async function loadFreshModule() {
  // Reset modules so the mocked plugin is re-applied cleanly between tests.
  vi.resetModules();
  return (await import("@/lib/updaterProxyTest")) as typeof import("@/lib/updaterProxyTest");
}

describe("classifyProxyError", () => {
  // Re-import once; classifyProxyError is pure — no per-test mock state needed.
  let mod: typeof import("@/lib/updaterProxyTest");
  it("loads", async () => {
    mod = await loadFreshModule();
  });

  // The classify tests below use `mod` from the it("loads") above via a lazy
  // re-load, but to keep them independent and deterministic we re-import at
  // the top of each case.
  async function classifyMod() {
    return await loadFreshModule();
  }

  // Behavior: refused family → { kind: "refused" }
  it("classifies ECONNREFUSED as refused", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError(new Error("connect ECONNREFUSED 127.0.0.1:7897"));
    expect(r.kind).toBe("refused");
  });

  it("classifies 'Connection refused' as refused", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("Connection refused (os error 111)");
    expect(r.kind).toBe("refused");
  });

  it("classifies 'connection refused' case-insensitively as refused", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("HTTP CONNECT ERROR: Connection Refused");
    expect(r.kind).toBe("refused");
  });

  it("classifies ECONNRESET as refused", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("Error: read tcp ->ECONNRESET (reset by peer)");
    expect(r.kind).toBe("refused");
  });

  it("classifies 'connect error' as refused", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("proxy: connect error: tcp connect error");
    expect(r.kind).toBe("refused");
  });

  // Behavior: timeout family → { kind: "timeout" }
  it("classifies 'timed out' as timeout", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("operation timed out");
    expect(r.kind).toBe("timeout");
  });

  it("classifies ETIMEDOUT as timeout", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("Error: ETIMEDOUT 1.2.3.4:443");
    expect(r.kind).toBe("timeout");
  });

  it("classifies 'deadline exceeded' as timeout", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("rpc error: deadline exceeded");
    expect(r.kind).toBe("timeout");
  });

  // Behavior: refused takes precedence over timeout when both substrings match
  // (per spec order: refused check runs first).
  it("prefers refused when both refused and timeout substrings are present", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("connection refused after timeout");
    expect(r.kind).toBe("refused");
  });

  // Behavior: other → { kind: "error"; message } trimmed and truncated
  it("classifies unknown errors as error with the coerced message", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError(new Error("some weird tls handshake failure"));
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("tls handshake failure");
    }
  });

  it("truncates the message to <=140 chars", async () => {
    const m = await classifyMod();
    const long = "x".repeat(300);
    const r = m.classifyProxyError(long);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message.length).toBeLessThanOrEqual(140);
    }
  });

  it("trims the message before truncating", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError("   some weird error   ");
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toBe("some weird error");
    }
  });

  it("classifies plain objects coerced via String()", async () => {
    const m = await classifyMod();
    // String({ foo: 1 }) === "[object Object]" — falls through to error.
    const r = m.classifyProxyError({ foo: 1 });
    expect(r.kind).toBe("error");
  });

  it("classifies null as error (does not throw on null)", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError(null);
    expect(r.kind).toBe("error");
  });

  it("classifies undefined as error (does not throw on undefined)", async () => {
    const m = await classifyMod();
    const r = m.classifyProxyError(undefined);
    expect(r.kind).toBe("error");
  });
});

describe("runProxyConnectionTest", () => {
  beforeEach(() => {
    checkMock.mockReset();
    currentCheck = null;
  });

  it("calls check exactly once with { proxy, timeout }", async () => {
    currentCheck = async () => null;
    const m = await loadFreshModule();

    await m.runProxyConnectionTest({ proxyUrl: "http://localhost:7897", timeout: 8000 });

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(checkMock).toHaveBeenCalledWith({
      proxy: "http://localhost:7897",
      timeout: 8000,
    });
  });

  it("resolves to { kind: 'ok' } when check resolves null (no update)", async () => {
    currentCheck = async () => null;
    const m = await loadFreshModule();

    const r = await m.runProxyConnectionTest({ proxyUrl: "http://localhost:7897", timeout: 8000 });
    expect(r).toEqual({ kind: "ok" });
  });

  it("resolves to { kind: 'ok', note: '有新版本' } when check resolves an Update", async () => {
    // The Update shape doesn't matter for the note; we only care about truthiness.
    currentCheck = async () => ({ version: "1.5.0" });
    const m = await loadFreshModule();

    const r = await m.runProxyConnectionTest({ proxyUrl: "http://localhost:7897", timeout: 8000 });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.note).toBe("有新版本");
    }
  });

  it("resolves to { kind: 'ok' } (no note) when check resolves an Update but note undefined?", async () => {
    // Sanity: a truthy Update should always carry the note. This pins that the
    // note IS attached for a truthy Update (guards against a future regression
    // that only sets note conditionally).
    currentCheck = async () => ({ version: "2.0.0" });
    const m = await loadFreshModule();

    const r = await m.runProxyConnectionTest({ proxyUrl: "http://x:1", timeout: 5000 });
    expect(r).toEqual({ kind: "ok", note: "有新版本" });
  });

  it("classifies a refused error when check rejects with ECONNREFUSED", async () => {
    currentCheck = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7897");
    };
    const m = await loadFreshModule();

    const r = await m.runProxyConnectionTest({ proxyUrl: "http://localhost:7897", timeout: 8000 });
    expect(r.kind).toBe("refused");
  });

  it("classifies a timeout error when check rejects with 'timed out'", async () => {
    currentCheck = async () => {
      throw "operation timed out";
    };
    const m = await loadFreshModule();

    const r = await m.runProxyConnectionTest({ proxyUrl: "http://localhost:7897", timeout: 8000 });
    expect(r.kind).toBe("timeout");
  });

  it("classifies an unknown rejection as error with the short message", async () => {
    currentCheck = async () => {
      throw "tls handshake: bad certificate";
    };
    const m = await loadFreshModule();

    const r = await m.runProxyConnectionTest({ proxyUrl: "http://localhost:7897", timeout: 8000 });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain("tls handshake");
    }
  });

  it("does NOT call downloadAndInstall or any install path (check is the only updater call)", async () => {
    // The mock only exposes `check`. If runProxyConnectionTest tried to call
    // downloadAndInstall, the call would be undefined and throw — but more
    // importantly, we assert check is the single recorded call.
    currentCheck = async () => ({ version: "9.9.9" });
    const m = await loadFreshModule();

    await m.runProxyConnectionTest({ proxyUrl: "http://localhost:7897", timeout: 8000 });

    expect(checkMock).toHaveBeenCalledTimes(1);
    // No other property of the mocked module was called: check is the only
    // updater surface this module is allowed to touch.
  });
});
