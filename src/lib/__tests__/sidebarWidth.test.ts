import { beforeEach, describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "../sidebarWidth";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  };
}

function stubInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function stubLocalStorage() {
  const storage = memoryStorage();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

describe("clampSidebarWidth", () => {
  beforeEach(() => {
    stubInnerWidth(1200);
  });

  it("clamps below min to 180", () => {
    expect(clampSidebarWidth(100)).toBe(180);
  });

  it("passes through in-range values", () => {
    expect(clampSidebarWidth(300)).toBe(300);
  });

  it("caps at 420px even on a wide viewport", () => {
    expect(clampSidebarWidth(900, 2000)).toBe(420);
  });

  it("caps at 40% of a narrow viewport", () => {
    expect(clampSidebarWidth(400, 800)).toBe(320);
  });
});

describe("loadSidebarWidth / saveSidebarWidth", () => {
  beforeEach(() => {
    stubLocalStorage();
    stubInnerWidth(1200);
  });

  it("defaults to 228 when the key is missing", () => {
    expect(loadSidebarWidth()).toBe(228);
  });

  it("returns a stored in-range width", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "300");
    expect(loadSidebarWidth()).toBe(300);
  });

  it("defaults to 228 on non-numeric storage", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "nope");
    expect(loadSidebarWidth()).toBe(228);
  });

  it("clamps a stored value below min", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "50");
    expect(loadSidebarWidth()).toBe(180);
  });

  it("writes the clamped integer", () => {
    saveSidebarWidth(300);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("300");
  });

  it("writes the min when given a value below min", () => {
    saveSidebarWidth(50);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("180");
  });
});
