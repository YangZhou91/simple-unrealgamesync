import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, act, within } from "@testing-library/react";

/**
 * quick-260711-jpq — proxy Test-button interaction tests.
 *
 * Mocks the two Tauri modules the Network/proxy section reaches into:
 *   - @tauri-apps/plugin-updater   → check (the first-party API the Test
 *     button exercises; NOT a JS fetch)
 *   - @tauri-apps/plugin-store     → load (so loadUpdaterSettings resolves
 *     without a real Tauri runtime and proxyLoaded flips true, enabling the
 *     Test button)
 *
 * `commands` (getLogPath etc.) is intentionally NOT mocked — its rejections
 * are swallowed by the dialog's open-effect .catch(), exactly like the
 * pre-existing tests in this file.
 *
 * The fake store defaults the proxy OFF; tests that need the button enabled
 * flip the in-memory `updater.proxy_enabled` entry to true before rendering.
 */

// --- plugin-store mock (in-memory, mirrors updaterSettings.test.ts shape) ---
// vi.hoisted runs BEFORE the vi.mock factories (which are themselves hoisted
// above all other top-level code), so symbols declared here are initialized
// in time for the factories to close over them. The store object's methods
// read the LIVE `storeEntries` map at call time, so the updaterSettings
// module's module-cached store handle still reflects per-test entry
// mutations (we never swap the store object; we mutate its backing map
// in-place between tests).
type EntryMap = Record<string, unknown>;
const hoisted = vi.hoisted(() => {
  const storeEntries: EntryMap = {};
  let storeSaveCalls = 0;
  let storeGetCalls = 0;
  const stableStore = {
    get: async <T,>(key: string): Promise<T | undefined> => {
      storeGetCalls += 1;
      return storeEntries[key] as T | undefined;
    },
    set: async (key: string, value: unknown) => {
      storeEntries[key] = value;
    },
    save: async () => {
      storeSaveCalls += 1;
    },
  };
  let currentStore: unknown = stableStore;
  // currentCheck is a `let` slot the updater factory reads at call time.
  let currentCheck: ((opts?: unknown) => Promise<unknown>) | null = null;
  const checkMock = vi.fn((opts?: unknown) =>
    currentCheck ? currentCheck(opts) : Promise.resolve(null),
  );
  const isEnabled = vi.fn(async () => false);
  const enable = vi.fn(async () => {});
  const disable = vi.fn(async () => {});
  const validateExclusions = vi.fn(async () => [] as string[]);
  const getLogPath = vi.fn(async () => null as string | null);
  const openLogsFolder = vi.fn(async () => {});
  const exportLog = vi.fn(async () => "D:\\out.log");
  return {
    stableStore,
    storeEntries,
    storeSaveCallsRef: { get value() { return storeSaveCalls; }, set value(v: number) { storeSaveCalls = v; } },
    storeGetCallsRef: { get value() { return storeGetCalls; }, set value(v: number) { storeGetCalls = v; } },
    currentStoreRef: { get value() { return currentStore; }, set value(v: unknown) { currentStore = v; } },
    currentCheckRef: { get value() { return currentCheck; }, set value(v: ((opts?: unknown) => Promise<unknown>) | null) { currentCheck = v; } },
    checkMock,
    isEnabled,
    enable,
    disable,
    validateExclusions,
    getLogPath,
    openLogsFolder,
    exportLog,
  };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => hoisted.currentStoreRef.value),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: hoisted.checkMock,
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: hoisted.isEnabled,
  enable: hoisted.enable,
  disable: hoisted.disable,
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
vi.mock("@/lib/commands", () => ({
  getLogPath: hoisted.getLogPath,
  validateExclusions: hoisted.validateExclusions,
  openLogsFolder: hoisted.openLogsFolder,
  exportLog: hoisted.exportLog,
}));
import { makeT, renderWithI18n, useT } from "@/lib/i18n";
import { SettingsDialog, extractPort } from "@/components/settings/SettingsDialog";

const mockWorkspace = {
  id: "ws-1",
  name: "Test Workspace",
  projectDir: "MyGame",
  rootPath: "E:\\UnrealProject",
  p4Client: "test_client",
  p4User: "testuser",
  lastSyncCl: null,
  lastSyncTime: null,
  lastSyncFileCount: null,
  parallelThreads: 8,
  exclusions: ["Binaries", "Content/Developers"],
  intervalMinutes: 60,
};

const tEn = makeT("en");

function activateAppTab(t: ReturnType<typeof makeT> = tEn) {
  fireEvent.click(screen.getByRole("button", { name: t("settings.tab.app"), pressed: false }));
  expect(screen.getByRole("button", { name: t("settings.tab.app") })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

beforeEach(() => {
  hoisted.isEnabled.mockReset();
  hoisted.enable.mockReset();
  hoisted.disable.mockReset();
  hoisted.isEnabled.mockImplementation(async () => false);
  hoisted.enable.mockImplementation(async () => {});
  hoisted.disable.mockImplementation(async () => {});
  hoisted.validateExclusions.mockReset();
  hoisted.validateExclusions.mockImplementation(async () => []);
  hoisted.getLogPath.mockReset();
  hoisted.getLogPath.mockImplementation(async () => null);
});

describe("SettingsDialog", () => {
  it("renders workspace settings title", () => {
    const t = makeT("en");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    expect(
      screen.getByRole("heading", { name: t("settings.title.workspace") }),
    ).toBeDefined();
    expect(
      screen.getByText(t("settings.description.workspace", { name: mockWorkspace.name })),
    ).toBeDefined();
  });

  it("renders exclusion chips from workspace config", () => {
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    expect(screen.getByText("Binaries")).toBeDefined();
    expect(screen.getByText("Content/Developers")).toBeDefined();
  });

  it("renders thread count from workspace config", () => {
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    const input = screen.getAllByRole("spinbutton")[0] as HTMLInputElement;
    expect(input.value).toBe("8");
  });

  it("shows error when adding exclusion with dot-dot path", () => {
    const t = makeT("en");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    const input = screen.getByPlaceholderText(
      t("settings.exclusions.placeholder"),
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ".." } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(screen.getByText(t("settings.exclusions.error.invalid"))).toBeDefined();
    expect(screen.getByText("Binaries")).toBeDefined();
    expect(screen.getByText("Content/Developers")).toBeDefined();
  });

  it("shows error when adding duplicate exclusion", () => {
    const t = makeT("en");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    const input = screen.getByPlaceholderText(
      t("settings.exclusions.placeholder"),
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Binaries" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(screen.getByText(t("settings.exclusions.error.duplicate"))).toBeDefined();
  });

  it("language option labels equal settings.language.zh and settings.language.en", () => {
    const t = makeT("en");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    activateAppTab(t);
    expect(screen.getByRole("radio", { name: t("settings.language.zh") })).toBeDefined();
    expect(screen.getByRole("radio", { name: t("settings.language.en") })).toBeDefined();
  });

  it("zh smoke: language option labels equal settings.language.zh identical to en", () => {
    const tZh = makeT("zh");
    const tEnLocal = makeT("en");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
      { locale: "zh" },
    );
    activateAppTab(tZh);
    expect(tZh("settings.language.zh")).toBe(tEnLocal("settings.language.zh"));
    expect(screen.getByRole("radio", { name: tZh("settings.language.zh") })).toBeDefined();
    expect(screen.getByRole("radio", { name: tZh("settings.language.en") })).toBeDefined();
  });
});

describe("SettingsDialog — workspace/app scopes", () => {
  function renderOpen() {
    return renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
  }

  it("opens on the workspace scope with Save present and App controls hidden", () => {
    const t = makeT("en");
    renderOpen();
    expect(screen.getByRole("button", { name: t("settings.tab.workspace") })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: t("settings.save") })).toBeDefined();
    expect(
      screen.queryByRole("checkbox", { name: t("settings.network.enable") }),
    ).toBeNull();
    const enableHidden = screen.getByRole("checkbox", {
      name: t("settings.network.enable"),
      hidden: true,
    });
    expect(enableHidden.closest("[hidden]")).not.toBeNull();
  });

  it("App tab reveals locale, startup, and proxy enable and hides workspace Save", () => {
    const t = makeT("en");
    renderOpen();
    activateAppTab(t);
    expect(screen.getByRole("radio", { name: t("settings.language.zh") })).toBeDefined();
    expect(
      screen.getByRole("checkbox", { name: t("settings.startup.launch") }),
    ).toBeDefined();
    expect(
      screen.getByRole("checkbox", { name: t("settings.network.enable") }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: t("settings.save") })).toBeNull();
  });

  it("App tab has no workspace Save; Save URL remains the App persist control", () => {
    const t = makeT("en");
    renderOpen();
    activateAppTab(t);
    expect(screen.queryByRole("button", { name: t("settings.save") })).toBeNull();
    expect(
      screen.getByRole("button", { name: t("settings.network.saveUrl") }),
    ).toBeDefined();
  });

  it("proxy URL is disabled until the enable checkbox is on and proxyLoaded", async () => {
    const t = makeT("en");
    renderOpen();
    activateAppTab(t);
    await waitFor(() => {
      const cb = screen.getByRole("checkbox", { name: t("settings.network.enable") });
      expect((cb as HTMLInputElement).disabled).toBe(false);
    });
    expect(
      screen.getByRole("textbox", { name: t("settings.network.urlAria") }),
    ).toBeDisabled();
  });

  it("tab switch leaves thread and exclusion drafts in place and does not restart loaders", async () => {
    const t = makeT("en");
    renderOpen();
    await waitFor(() => {
      expect(hoisted.getLogPath).toHaveBeenCalled();
      expect(hoisted.isEnabled).toHaveBeenCalled();
    });
    const threadInput = screen.getAllByRole("spinbutton")[0] as HTMLInputElement;
    fireEvent.change(threadInput, { target: { value: "12" } });
    const exclusionInput = screen.getByPlaceholderText(
      t("settings.exclusions.placeholder"),
    ) as HTMLInputElement;
    fireEvent.change(exclusionInput, { target: { value: "ArtOffline" } });
    fireEvent.keyDown(exclusionInput, { key: "Enter", code: "Enter" });
    expect(screen.getByText("ArtOffline")).toBeDefined();

    const logCalls = hoisted.getLogPath.mock.calls.length;
    const enabledCalls = hoisted.isEnabled.mock.calls.length;
    const storeGets = hoisted.storeGetCallsRef.value;

    activateAppTab(t);
    fireEvent.click(
      screen.getByRole("button", { name: t("settings.tab.workspace"), pressed: false }),
    );

    expect((screen.getAllByRole("spinbutton")[0] as HTMLInputElement).value).toBe("12");
    expect(screen.getByText("Binaries")).toBeDefined();
    expect(screen.getByText("ArtOffline")).toBeDefined();
    expect(hoisted.getLogPath.mock.calls.length).toBe(logCalls);
    expect(hoisted.isEnabled.mock.calls.length).toBe(enabledCalls);
    expect(hoisted.storeGetCallsRef.value).toBe(storeGets);
  });

  it("shows three immediate-persist chips on App; none on logs or URL persist/test", () => {
    const t = makeT("en");
    renderOpen();
    activateAppTab(t);
    expect(screen.getAllByText(t("settings.persist.immediate"))).toHaveLength(3);
    const logsHeading = screen.getByRole("heading", { name: t("settings.logs.title") });
    expect(
      within(logsHeading.parentElement as HTMLElement).queryByText(
        t("settings.persist.immediate"),
      ),
    ).toBeNull();
    const saveUrl = screen.getByRole("button", { name: t("settings.network.saveUrl") });
    expect(
      within(saveUrl.parentElement as HTMLElement).queryByText(
        t("settings.persist.immediate"),
      ),
    ).toBeNull();
    const testBtn = screen.getByRole("button", { name: t("settings.network.test") });
    expect(
      within(testBtn.parentElement as HTMLElement).queryByText(
        t("settings.persist.immediate"),
      ),
    ).toBeNull();
  });

  it("workspace Save stays enabled after load with unchanged drafts", () => {
    const t = makeT("en");
    renderOpen();
    expect(screen.getByRole("button", { name: t("settings.save") })).not.toBeDisabled();
  });

  it("no-workspace hides the workspace tab and shows App chrome without a tab click", () => {
    const t = makeT("en");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={null}
        onSave={async () => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: t("settings.tab.workspace") }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: t("settings.title") })).toBeDefined();
    expect(screen.getByRole("radio", { name: t("settings.language.zh") })).toBeDefined();
    expect(
      screen.getByRole("checkbox", { name: t("settings.startup.launch") }),
    ).toBeDefined();
    expect(
      screen.getByRole("checkbox", { name: t("settings.network.enable") }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: t("settings.save") })).toBeNull();
  });

  it("workspace removed mid-session forces App scope — no blank body (WR-01)", async () => {
    const t = makeT("en");
    const view = renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    // Opens on workspace scope with Save visible.
    expect(screen.getByRole("button", { name: t("settings.save") })).toBeDefined();

    // The delete IPC resolves: workspace prop flips to null while open.
    view.rerender(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={null}
        onSave={async () => {}}
      />,
    );

    // UI-SPEC: !workspace forces scope "app" — the tab strip disappears and
    // the App controls become reachable without close/reopen.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: t("settings.tab.workspace") }),
      ).toBeNull();
    });
    expect(screen.getByRole("radio", { name: t("settings.language.zh") })).toBeDefined();
    expect(
      screen.getByRole("checkbox", { name: t("settings.network.enable") }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: t("settings.save") })).toBeNull();
  });

  it("re-adopting the same workspace id after removal re-initializes drafts", async () => {
    const t = makeT("en");
    const view = renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    const threadInput = screen.getAllByRole("spinbutton")[0] as HTMLInputElement;
    fireEvent.change(threadInput, { target: { value: "12" } });

    // Workspace removed, then the same id comes back (sentinel was reset).
    view.rerender(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={null}
        onSave={async () => {}}
      />,
    );
    view.rerender(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );

    // Drafts re-initialized from the workspace config (back to 8, not 12) and
    // the dialog lands on the workspace default scope again.
    await waitFor(() => {
      expect((screen.getAllByRole("spinbutton")[0] as HTMLInputElement).value).toBe("8");
    });
    expect(screen.getByRole("button", { name: t("settings.save") })).toBeDefined();
  });
});

describe("SettingsDialog — launch at Windows login", () => {
  function renderDialog() {
    const utils = renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    activateAppTab();
    return utils;
  }

  async function waitForStartupLoaded() {
    await waitFor(() => {
      const t = makeT("en");
      const cb = screen.getByRole("checkbox", {
        name: t("settings.startup.launch"),
      }) as HTMLInputElement;
      expect(cb.disabled).toBe(false);
    });
    const t = makeT("en");
    return screen.getByRole("checkbox", {
      name: t("settings.startup.launch"),
    }) as HTMLInputElement;
  }

  it("renders the Startup heading after load", async () => {
    renderDialog();
    const t = makeT("en");
    expect(await screen.findByText(t("settings.startup.title"))).toBeDefined();
  });

  it("shows an unchecked Launch at Windows login checkbox when isEnabled is false", async () => {
    renderDialog();
    const cb = await waitForStartupLoaded();
    expect(cb.checked).toBe(false);
  });

  it("calls enable once and not disable when toggling on from off", async () => {
    renderDialog();
    const cb = await waitForStartupLoaded();
    fireEvent.click(cb);
    await waitFor(() => {
      expect(hoisted.enable).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.disable).not.toHaveBeenCalled();
  });

  it("calls disable once when toggling off from on", async () => {
    hoisted.isEnabled.mockImplementation(async () => true);
    renderDialog();
    const cb = await waitForStartupLoaded();
    await waitFor(() => {
      expect(cb.checked).toBe(true);
    });
    fireEvent.click(cb);
    await waitFor(() => {
      expect(hoisted.disable).toHaveBeenCalledTimes(1);
    });
    expect(hoisted.enable).not.toHaveBeenCalled();
  });

  it("reverts the checkbox and shows an err status when enable rejects", async () => {
    hoisted.enable.mockImplementation(async () => {
      throw new Error("autostart failed");
    });
    renderDialog();
    const cb = await waitForStartupLoaded();
    fireEvent.click(cb);
    await waitFor(() => {
      expect(screen.getByText(/autostart failed/)).toBeDefined();
    });
    await waitFor(() => {
      expect(cb.checked).toBe(false);
    });
  });
});

describe("SettingsDialog — proxy Test button", () => {
  // Local aliases into the hoisted mock state for readability.
  const storeEntries = hoisted.storeEntries;
  const checkMock = hoisted.checkMock;
  const setCheck = (fn: ((opts?: unknown) => Promise<unknown>) | null) => {
    hoisted.currentCheckRef.value = fn;
  };

  beforeEach(() => {
    // Reset the live in-memory store entries (the stableStore reads these at
    // call time, so the cached updaterSettings handle sees the reset too).
    for (const k of Object.keys(storeEntries)) delete storeEntries[k];
    storeEntries["updater.proxy_enabled"] = false;
    storeEntries["updater.proxy_url"] = "http://localhost:7897";
    hoisted.storeSaveCallsRef.value = 0;
    hoisted.currentCheckRef.value = null;
    checkMock.mockClear();
  });

  /**
   * Helper: render the dialog with proxy ENABLED and a set proxyUrl, then
   * await the open-effect load so proxyLoaded flips and the Test button is
   * interactive. Returns the rendered helpers.
   */
  async function renderWithProxyEnabled(proxyUrl = "http://localhost:7897") {
    storeEntries["updater.proxy_enabled"] = true;
    storeEntries["updater.proxy_url"] = proxyUrl;
    const utils = renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    activateAppTab();
    // Wait for the open-effect loadUpdaterSettings to resolve + flip
    // proxyLoaded, which enables the Test button.
    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: tEn("settings.network.test") });
      expect(btn).toBeTruthy();
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    return utils;
  }

  it("Test button is disabled when proxyEnabled is false", async () => {
    // proxy defaults to OFF in beforeEach; loadUpdaterSettings resolves with
    // proxyEnabled=false → Test button disabled (proxyLoaded true but
    // !proxyEnabled fails the disabled predicate).
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    activateAppTab();
    // The button exists on the App tab but is disabled while proxy is off.
    const btn = await screen.findByRole("button", { name: tEn("settings.network.test") });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("masks entered credentials and refuses save and test with localized feedback", async () => {
    await renderWithProxyEnabled();
    const input = screen.getByDisplayValue("http://localhost:7897");
    fireEvent.change(input, { target: { value: ["http://alice:secret", "localhost:7897"].join("@") } });
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.saveUrl") }));
    await screen.findByText(tEn("settings.proxy.credentials"));
    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));
    await screen.findByText(tEn("settings.proxy.credentials"));
    expect(checkMock).not.toHaveBeenCalled();
    expect(hoisted.storeSaveCallsRef.value).toBe(0);
    expect(storeEntries["updater.proxy_url"]).toBe("http://localhost:7897");
  });

  it("calls check once with { proxy, timeout: 8000 } on Test click", async () => {
    setCheck(async () => null);
    await renderWithProxyEnabled("http://localhost:7897");

    const btn = screen.getByRole("button", { name: tEn("settings.network.test") }) as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1);
    });
    expect(checkMock).toHaveBeenCalledWith({
      proxy: "http://localhost:7897",
      timeout: 8000,
    });
  });

  it("shows the dictionary reachable status when check resolves null", async () => {
    setCheck(async () => null);
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    const t = makeT("en");
    expect(
      await screen.findByText(t("settings.proxy.reachable")),
    ).toBeDefined();
  });

  it("shows reachableWithNote with the dictionary note when check resolves an Update", async () => {
    setCheck(async () => ({ version: "1.5.0" }));
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    const t = makeT("en");
    expect(
      await screen.findByText(
        t("settings.proxy.reachableWithNote", {
          note: t("settings.proxy.updateAvailable"),
        }),
      ),
    ).toBeDefined();
  });

  it("shows the dictionary refused status with the port when check rejects with Connection refused", async () => {
    setCheck(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7897");
    });
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    const t = makeT("en");
    expect(
      await screen.findByText(t("settings.proxy.refused", { port: "7897" })),
    ).toBeDefined();
  });

  it("shows refused status with default http port when the URL has no explicit port", async () => {
    setCheck(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1");
    });
    await renderWithProxyEnabled("http://localhost");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    const t = makeT("en");
    expect(
      await screen.findByText(t("settings.proxy.refused", { port: "80" })),
    ).toBeDefined();
  });

  it("shows refused status with default https port when the URL has no explicit port", async () => {
    setCheck(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await renderWithProxyEnabled("https://example.com");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    const t = makeT("en");
    expect(
      await screen.findByText(t("settings.proxy.refused", { port: "443" })),
    ).toBeDefined();
  });

  it("shows the dictionary timeout status when check rejects with timed out", async () => {
    setCheck(async () => {
      throw "operation timed out";
    });
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    const t = makeT("en");
    expect(
      await screen.findByText(t("settings.proxy.timeout")),
    ).toBeDefined();
  });

  it("flips the Test button label to Testing… while in-flight", async () => {
    // A never-resolving promise keeps the handler in-flight so the Testing…
    // label is rendered long enough to assert.
    setCheck(() => new Promise(() => {}));
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    expect(await screen.findByText(tEn("settings.network.testing"))).toBeDefined();
    const inFlight = screen.getByText(tEn("settings.network.testing")).closest("button");
    expect(inFlight).toBeTruthy();
    expect((inFlight as HTMLButtonElement).disabled).toBe(true);
  });

  it("does NOT invoke any install path — check is the only updater call", async () => {
    setCheck(async () => ({ version: "9.9.9" }));
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));

    await waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1);
    });
    // The mocked updater module exposes ONLY check. If the Test button tried
    // to call downloadAndInstall, it would be undefined and throw. The single
    // check call + no thrown install error proves connectivity-only.
    const t = makeT("en");
    expect(
      await screen.findByText(
        t("settings.proxy.reachableWithNote", {
          note: t("settings.proxy.updateAvailable"),
        }),
      ),
    ).toBeDefined();
  });

  it("does not paint a late test result after close then reopen", async () => {
    let resolveCheck: (value: unknown) => void = () => {};
    setCheck(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    storeEntries["updater.proxy_enabled"] = true;
    storeEntries["updater.proxy_url"] = "http://localhost:7897";
    const view = renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    activateAppTab();
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: tEn("settings.network.test") });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));
    expect(await screen.findByText(tEn("settings.network.testing"))).toBeDefined();

    view.rerender(
      <SettingsDialog
        open={false}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );

    await act(async () => {
      resolveCheck(null);
    });

    view.rerender(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );

    // Same instance keeps App scope; do not re-click (pressed is already true).
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: tEn("settings.network.test") });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByText(tEn("settings.proxy.reachable"))).toBeNull();
  });

  it("clears the test status when the URL is edited after a test", async () => {
    setCheck(async () => null);
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));
    const t = makeT("en");
    expect(
      await screen.findByText(t("settings.proxy.reachable")),
    ).toBeDefined();

    // Edit the URL — the inline test status should clear.
    const urlInput = screen.getByRole("textbox", { name: tEn("settings.network.urlAria") }) as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: "http://localhost:8888" } });

    await waitFor(() => {
      expect(screen.queryByText(t("settings.proxy.reachable"))).toBeNull();
    });
  });

  it("zh smoke: ok+hasNote path shows reachableWithNote from the zh dictionary", async () => {
    setCheck(async () => ({ version: "1.5.0" }));

    storeEntries["updater.proxy_enabled"] = true;
    storeEntries["updater.proxy_url"] = "http://localhost:7897";
    const tZh = makeT("zh");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
      { locale: "zh" },
    );
    activateAppTab(tZh);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: tZh("settings.network.test") });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: tZh("settings.network.test") }));

    expect(
      await screen.findByText(
        tZh("settings.proxy.reachableWithNote", {
          note: tZh("settings.proxy.updateAvailable"),
        }),
      ),
    ).toBeDefined();
  });

  it("tab switch does not drop an in-flight proxy Test result", async () => {
    const t = makeT("en");
    let resolveCheck: (value: unknown) => void = () => {};
    setCheck(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    await renderWithProxyEnabled("http://localhost:7897");
    fireEvent.click(screen.getByRole("button", { name: tEn("settings.network.test") }));
    expect(await screen.findByText(tEn("settings.network.testing"))).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: t("settings.tab.workspace"), pressed: false }),
    );
    await act(async () => {
      resolveCheck(null);
    });
    activateAppTab(t);
    expect(await screen.findByText(t("settings.proxy.reachable"))).toBeDefined();
  });
});

function LocaleSwitchHarness({
  workspace = mockWorkspace,
}: {
  workspace?: typeof mockWorkspace | null;
}) {
  const { setLocale } = useT();
  return (
    <div>
      <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
        zh
      </button>
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={workspace}
        onSave={async () => {}}
      />
    </div>
  );
}

describe("SettingsDialog dictionary chrome", () => {
  it("Test button idle name equals settings.network.test", async () => {
    hoisted.storeEntries["updater.proxy_enabled"] = true;
    hoisted.storeEntries["updater.proxy_url"] = "http://localhost:7897";
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    activateAppTab();
    const btn = await screen.findByRole("button", {
      name: tEn("settings.network.test"),
    });
    expect(btn).toBeDefined();
  });

  it("exclusion input aria-label equals settings.exclusions.inputAria", () => {
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: tEn("settings.exclusions.inputAria") }),
    ).toBeDefined();
  });

  it("footer buttons equal settings.cancel and settings.save", () => {
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: tEn("settings.cancel") }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: tEn("settings.save") }),
    ).toBeDefined();
  });

  it("zh smoke: heading equals settings.title.workspace", () => {
    const tZh = makeT("zh");
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
      { locale: "zh" },
    );
    expect(
      screen.getByRole("heading", { name: tZh("settings.title.workspace") }),
    ).toBeDefined();
  });

  it("re-translates Save-URL ok status on locale switch without retrying", async () => {
    hoisted.storeEntries["updater.proxy_enabled"] = true;
    hoisted.storeEntries["updater.proxy_url"] = "http://localhost:7897";
    renderWithI18n(<LocaleSwitchHarness />);
    activateAppTab();
    await waitFor(() => {
      const btn = screen.getByRole("button", {
        name: tEn("settings.network.saveUrl"),
      });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(
      screen.getByRole("button", { name: tEn("settings.network.saveUrl") }),
    );
    expect(await screen.findByText(tEn("settings.network.saved"))).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    const tZh = makeT("zh");
    expect(screen.getByText(tZh("settings.network.saved"))).toBeDefined();
    expect(screen.queryByText(tEn("settings.network.saved"))).toBeNull();
  });

  it("one missing path paints settings.exclusions.missing.one with raw paths", async () => {
    hoisted.validateExclusions.mockImplementation(async () => ["Binaries"]);
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    expect(
      await screen.findByText(
        tEn("settings.exclusions.missing.one", { paths: "Binaries" }),
      ),
    ).toBeDefined();
    expect(screen.getByText("Binaries")).toBeDefined();
    expect(screen.getByText("Content/Developers")).toBeDefined();
  });

  it("two-plus missing paths paint settings.exclusions.missing.other with raw paths", async () => {
    hoisted.validateExclusions.mockImplementation(async () => [
      "Binaries",
      "Content/Developers",
    ]);
    renderWithI18n(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    expect(
      await screen.findByText(
        tEn("settings.exclusions.missing.other", {
          paths: "Binaries, Content/Developers",
        }),
      ),
    ).toBeDefined();
    expect(screen.getByText("Binaries")).toBeDefined();
    expect(screen.getByText("Content/Developers")).toBeDefined();
  });
});

describe("extractPort", () => {
  it("returns the explicit port when present", () => {
    expect(extractPort("http://localhost:7897")).toBe("7897");
  });

  it("returns 80 for http URLs with no explicit port", () => {
    expect(extractPort("http://localhost")).toBe("80");
  });

  it("returns 443 for https URLs with no explicit port", () => {
    expect(extractPort("https://example.com")).toBe("443");
  });

  it("does not return the scheme-colon tail for a well-formed URL", () => {
    expect(extractPort("http://localhost")).not.toBe("//localhost");
    expect(extractPort("https://example.com")).not.toBe("//example.com");
  });

  it("falls back to digits after the last colon for malformed input", () => {
    expect(extractPort("host:7897")).toBe("7897");
  });
});
