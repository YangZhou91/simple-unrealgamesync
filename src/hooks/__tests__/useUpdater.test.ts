import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { I18nProvider, makeT } from "@/lib/i18n";
import type { Update } from "@tauri-apps/plugin-updater";

const hoisted = vi.hoisted(() => ({
  askMock: vi.fn(async () => false),
  checkMock: vi.fn(async () => null),
  loadUpdaterSettingsMock: vi.fn(async () => ({
    proxyEnabled: false,
    proxyUrl: "",
  })),
  invokeMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: hoisted.askMock,
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: hoisted.checkMock,
}));
vi.mock("@/lib/updaterSettings", () => ({
  loadUpdaterSettings: hoisted.loadUpdaterSettingsMock,
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: hoisted.invokeMock,
}));

import { useUpdater } from "@/hooks/useUpdater";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(I18nProvider, { initialLocale: "en", children });

const fakeUpdate = {
  version: "1.7.0",
  downloadAndInstall: vi.fn(async () => {}),
} as unknown as Update;

describe("useUpdater ask() locale chrome", () => {
  beforeEach(() => {
    hoisted.askMock.mockClear();
    hoisted.askMock.mockResolvedValue(false);
    hoisted.checkMock.mockClear();
    hoisted.checkMock.mockResolvedValue(null);
  });

  it("downloadAndInstall calls ask with dictionary body, title, and Yes/No labels", async () => {
    const t = makeT("en");
    const { result } = renderHook(() => useUpdater(), { wrapper });

    await act(async () => {
      await result.current.downloadAndInstall(fakeUpdate);
    });

    expect(hoisted.askMock).toHaveBeenCalledWith(
      t("layout.updater.askBody", { version: fakeUpdate.version }),
      expect.objectContaining({
        title: t("layout.updater.askTitle"),
        kind: "info",
        okLabel: t("layout.updater.askYes"),
        cancelLabel: t("layout.updater.askNo"),
      }),
    );
  });

  it("does not call ask on hook mount before downloadAndInstall", () => {
    renderHook(() => useUpdater(), { wrapper });
    expect(hoisted.askMock).not.toHaveBeenCalled();
  });
});
