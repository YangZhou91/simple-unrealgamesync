import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for localeSettings — plugin-store CRUD for app.locale.
 *
 * Clone of the updaterSettings.test.ts mock infrastructure.
 */

type EntryMap = Record<string, unknown>;
interface FakeStore {
  get: <T>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown) => Promise<void>;
  save: () => Promise<void>;
}

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
  vi.resetModules();
  return (await import("@/lib/localeSettings")) as typeof import("@/lib/localeSettings");
}

describe("localeSettings", () => {
  beforeEach(() => {
    currentStore = null;
    loadMock.mockClear();
  });

  it("returns null when the store has no app.locale key", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { loadLocale } = await loadFreshModule();

    const result = await loadLocale();
    expect(result).toBeNull();
  });

  it("returns the stored locale when it is 'zh'", async () => {
    const fake = makeFakeStore({ "app.locale": "zh" });
    currentStore = fake;
    const { loadLocale } = await loadFreshModule();

    const result = await loadLocale();
    expect(result).toBe("zh");
  });

  it("returns the stored locale when it is 'en'", async () => {
    const fake = makeFakeStore({ "app.locale": "en" });
    currentStore = fake;
    const { loadLocale } = await loadFreshModule();

    const result = await loadLocale();
    expect(result).toBe("en");
  });

  it("returns null for invalid stored values", async () => {
    const { loadLocale } = await loadFreshModule();

    // Test with "fr"
    let fake = makeFakeStore({ "app.locale": "fr" });
    currentStore = fake;
    expect(await loadLocale()).toBeNull();

    // Test with a number
    fake = makeFakeStore({ "app.locale": 42 });
    currentStore = fake;
    expect(await loadLocale()).toBeNull();

    // Test with undefined (key missing)
    fake = makeFakeStore({});
    currentStore = fake;
    expect(await loadLocale()).toBeNull();
  });

  it("saveLocale + loadLocale round-trips correctly", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { loadLocale, saveLocale } = await loadFreshModule();

    await saveLocale("zh");
    expect(fake.entries["app.locale"]).toBe("zh");
    expect(fake.getSaveCalls()).toBe(1);

    // load via same store (module-level cache = same fake)
    const result = await loadLocale();
    expect(result).toBe("zh");
  });

  it("saveLocale calls store.save() exactly once per call", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { saveLocale } = await loadFreshModule();

    await saveLocale("en");
    expect(fake.getSaveCalls()).toBe(1);

    await saveLocale("zh");
    expect(fake.getSaveCalls()).toBe(2);
  });

  it("the module-level store cache calls plugin-store load at most once across multiple operations", async () => {
    const fake = makeFakeStore({});
    currentStore = fake;
    const { loadLocale, saveLocale } = await loadFreshModule();

    await loadLocale();
    await loadLocale();
    await saveLocale("en");
    await loadLocale();

    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});
