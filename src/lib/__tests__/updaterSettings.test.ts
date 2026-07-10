import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Task 1 (quick-260710-gfp) — RED phase tests for updaterSettings.
 *
 * These exercise the load/save round-trip over tauri-plugin-store WITHOUT a
 * real Tauri runtime: the plugin's `load` factory is mocked to return an
 * in-memory fake store, and we assert on the calls made to it. This pins the
 * public contract:
 *   - defaults: proxyEnabled=false, proxyUrl=http://localhost:7897
 *   - empty/whitespace stored proxyUrl falls back to the default on read
 *   - save never persists an empty URL
 *   - round-trip save→load returns the saved values
 *
 * The module-level cached store promise means we must reset modules between
 * tests so each one re-mocks @tauri-apps/plugin-store from a clean slate.
 */

// In-memory fake Store. Implements just the surface the settings module uses:
// get<T>(key) -> T | undefined, set(key, value), save().
type EntryMap = Record<string, unknown>;
interface FakeStore {
  get: <T>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown) => Promise<void>;
  save: () => Promise<void>;
}

// vi.mock is hoisted to the top of the file by vitest, so the factory must
// reference symbols that exist at hoist time. The `__setStore` escape hatch
// lets each test install its own in-memory store implementation.
let currentStore: FakeStore | null = null;
const loadMock = vi.fn(async () => {
  return currentStore;
});

vi.mock("@tauri-apps/plugin-store", () => ({
  load: loadMock,
}));

function makeFakeStore(initial: EntryMap = {}): FakeStore & {
  entries: EntryMap;
  getSaveCalls: () => number;
} {
  const entries: EntryMap = { ...initial };
  // Closed-over counter — the returned store's save() increments this. Read
  // via the getSaveCalls() accessor so callers see the live value (a plain
  // property on the returned object would be a stale snapshot at return time
  // and never update as save() runs).
  let saveCalls = 0;
  return {
    entries,
    getSaveCalls: () => saveCalls,
    get: async <T>(key: string) => entries[key] as T | undefined,
    set: async (key: string, value: unknown) => {
      entries[key] = value;
    },
    save: async () => {
      saveCalls += 1;
    },
  };
}

async function loadFreshModule() {
  // Re-import so the module-level cached store promise is fresh per test.
  vi.resetModules();
  // Re-establish the mock on the freshly-loaded module registry. The
  // vi.mock factory is re-applied automatically; only the `currentStore`
  // pointer (captured by closure at factory-eval time) needs resetting
  // via the same loadMock fallback path.
  return (await import("@/lib/updaterSettings")) as typeof import("@/lib/updaterSettings");
}

describe("updaterSettings", () => {
  beforeEach(() => {
    currentStore = null;
    loadMock.mockClear();
  });

  // Behavior: defaults when nothing is stored.
  it("returns defaults when store is empty", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { loadUpdaterSettings, DEFAULT_UPDATER_PROXY_URL } = await loadFreshModule();

    const settings = await loadUpdaterSettings();
    expect(settings.proxyEnabled).toBe(false);
    expect(settings.proxyUrl).toBe(DEFAULT_UPDATER_PROXY_URL);
    expect(settings.proxyUrl).toBe("http://localhost:7897");
  });

  // Behavior: empty/whitespace stored proxyUrl falls back to default on read.
  it("falls back to default when stored proxyUrl is empty string", async () => {
    const fake = makeFakeStore({
      "updater.proxy_enabled": true,
      "updater.proxy_url": "",
    });
    currentStore = fake;
    const { loadUpdaterSettings, DEFAULT_UPDATER_PROXY_URL } = await loadFreshModule();

    const settings = await loadUpdaterSettings();
    // Read does NOT mutate the store; it just returns the normalized value.
    expect(settings.proxyUrl).toBe(DEFAULT_UPDATER_PROXY_URL);
    expect(fake.entries["updater.proxy_url"]).toBe("");
  });

  it("falls back to default when stored proxyUrl is whitespace", async () => {
    const fake = makeFakeStore({
      "updater.proxy_enabled": false,
      "updater.proxy_url": "   ",
    });
    currentStore = fake;
    const { loadUpdaterSettings, DEFAULT_UPDATER_PROXY_URL } = await loadFreshModule();

    const settings = await loadUpdaterSettings();
    expect(settings.proxyUrl).toBe(DEFAULT_UPDATER_PROXY_URL);
  });

  // Behavior: round-trip save→load returns the saved values, and save flushes.
  it("persists both keys and flushes the store on save, then round-trips", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { saveUpdaterSettings, loadUpdaterSettings } = await loadFreshModule();

    await saveUpdaterSettings({
      proxyEnabled: true,
      proxyUrl: "http://127.0.0.1:8888",
    });

    // Both keys written.
    expect(fake.entries["updater.proxy_enabled"]).toBe(true);
    expect(fake.entries["updater.proxy_url"]).toBe("http://127.0.0.1:8888");
    // save() called exactly once per saveUpdaterSettings.
    expect(fake.getSaveCalls()).toBe(1);

    // Re-read returns the persisted values (no re-load of plugin-store: the
    // module-level cache returns the same fake handle).
    const loaded = await loadUpdaterSettings();
    expect(loaded).toEqual({
      proxyEnabled: true,
      proxyUrl: "http://127.0.0.1:8888",
    });
  });

  // Behavior: save never persists an empty URL (prevents broken proxy string
  // surviving a restart).
  it("save substitutes the default URL when given an empty proxyUrl", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { saveUpdaterSettings, DEFAULT_UPDATER_PROXY_URL } = await loadFreshModule();

    await saveUpdaterSettings({ proxyEnabled: false, proxyUrl: "" });

    expect(fake.entries["updater.proxy_url"]).toBe(DEFAULT_UPDATER_PROXY_URL);
  });

  it("save substitutes the default URL when given a whitespace-only proxyUrl", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { saveUpdaterSettings, DEFAULT_UPDATER_PROXY_URL } = await loadFreshModule();

    await saveUpdaterSettings({ proxyEnabled: true, proxyUrl: "  \t " });

    expect(fake.entries["updater.proxy_url"]).toBe(DEFAULT_UPDATER_PROXY_URL);
    expect(fake.entries["updater.proxy_enabled"]).toBe(true);
  });

  // Behavior: module-level cache — the plugin-store `load` is called at most
  // once no matter how many load/save calls happen (single shared handle).
  it("calls plugin-store load at most once across multiple operations", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { loadUpdaterSettings, saveUpdaterSettings } = await loadFreshModule();

    await loadUpdaterSettings();
    await loadUpdaterSettings();
    await saveUpdaterSettings({ proxyEnabled: true, proxyUrl: "http://x:1" });
    await loadUpdaterSettings();

    // One module-level load across all of the above.
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  // Behavior: proxyUrl is never empty on return, even when only one key was
  // set by an older client (forward-compat: store with only the boolean).
  it("returns default URL when only the boolean key is present", async () => {
    const fake = makeFakeStore({ "updater.proxy_enabled": true });
    currentStore = fake;
    const { loadUpdaterSettings, DEFAULT_UPDATER_PROXY_URL } = await loadFreshModule();

    const settings = await loadUpdaterSettings();
    expect(settings.proxyEnabled).toBe(true);
    expect(settings.proxyUrl).toBe(DEFAULT_UPDATER_PROXY_URL);
  });
});
