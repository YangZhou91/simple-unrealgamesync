import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "../AppLayout";
import { SIDEBAR_WIDTH_STORAGE_KEY } from "@/lib/sidebarWidth";
import { makeT, renderWithI18n } from "@/lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

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

describe("AppLayout sidebar resize", () => {
  beforeEach(() => {
    stubLocalStorage();
    stubInnerWidth(1200);
    if (typeof HTMLElement.prototype.setPointerCapture !== "function") {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }
    if (typeof HTMLElement.prototype.releasePointerCapture !== "function") {
      HTMLElement.prototype.releasePointerCapture = vi.fn();
    }
  });

  it("paints 228px and exposes layout.resizeAria when storage is empty", () => {
    const t = makeT("en");
    const { container } = renderWithI18n(
      <AppLayout sidebar={<div>nav</div>}>
        <div>main</div>
      </AppLayout>,
    );

    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.style.width).toBe("228px");
    expect(
      screen.getByRole("separator", { name: t("layout.resizeAria") }),
    ).toBeTruthy();
  });

  it("updates aside width and persists on pointer drag", () => {
    const t = makeT("en");
    const { container } = renderWithI18n(
      <AppLayout sidebar={<div>nav</div>}>
        <div>main</div>
      </AppLayout>,
    );

    const handle = screen.getByRole("separator", { name: t("layout.resizeAria") });
    fireEvent.pointerDown(handle, { clientX: 228 });
    fireEvent.pointerMove(window, { clientX: 308 });
    fireEvent.pointerUp(window);

    expect(container.querySelector("aside")!.style.width).toBe("308px");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("308");
  });

  it("hydrates aside width from localStorage", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "300");
    const { container } = renderWithI18n(
      <AppLayout sidebar={<div>nav</div>}>
        <div>main</div>
      </AppLayout>,
    );

    expect(container.querySelector("aside")!.style.width).toBe("300px");
  });

  it("zh smoke: separator name equals layout.resizeAria", () => {
    const tZh = makeT("zh");
    renderWithI18n(
      <AppLayout sidebar={<div>nav</div>}>
        <div>main</div>
      </AppLayout>,
      { locale: "zh" },
    );

    expect(
      screen.getByRole("separator", { name: tZh("layout.resizeAria") }),
    ).toBeTruthy();
  });
});
