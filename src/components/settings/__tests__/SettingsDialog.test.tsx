import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * quick-260711-jpq — proxy Test-button interaction tests.
 *
 * Mocks the two Tauri modules the Network/代理 section reaches into:
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
  const stableStore = {
    get: async <T,>(key: string): Promise<T | undefined> =>
      storeEntries[key] as T | undefined,
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
  return {
    stableStore,
    storeEntries,
    storeSaveCallsRef: { get value() { return storeSaveCalls; }, set value(v: number) { storeSaveCalls = v; } },
    currentStoreRef: { get value() { return currentStore; }, set value(v: unknown) { currentStore = v; } },
    currentCheckRef: { get value() { return currentCheck; }, set value(v: ((opts?: unknown) => Promise<unknown>) | null) { currentCheck = v; } },
    checkMock,
  };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => hoisted.currentStoreRef.value),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: hoisted.checkMock,
}));

import { SettingsDialog } from "@/components/settings/SettingsDialog";

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

describe("SettingsDialog", () => {
  it("renders workspace settings title", () => {
    render(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    expect(screen.getByText("Workspace Settings")).toBeDefined();
    expect(
      screen.getByText("Configure sync options for Test Workspace"),
    ).toBeDefined();
  });

  it("renders exclusion chips from workspace config", () => {
    render(
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
    render(
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
    render(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    const input = screen.getByPlaceholderText(
      "Add path...",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ".." } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(screen.getByText("Invalid path")).toBeDefined();
  });

  it("shows error when adding duplicate exclusion", () => {
    render(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    const input = screen.getByPlaceholderText(
      "Add path...",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Binaries" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(screen.getByText("Path already exists")).toBeDefined();
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
    const utils = render(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    // Wait for the open-effect loadUpdaterSettings to resolve + flip
    // proxyLoaded, which enables the Test button.
    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: "测试连接" });
      expect(btn).toBeTruthy();
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    return utils;
  }

  it("Test button is disabled when proxyEnabled is false", async () => {
    // proxy defaults to OFF in beforeEach; loadUpdaterSettings resolves with
    // proxyEnabled=false → Test button disabled (proxyLoaded true but
    // !proxyEnabled fails the disabled predicate).
    render(
      <SettingsDialog
        open={true}
        onOpenChange={() => {}}
        workspace={mockWorkspace}
        onSave={async () => {}}
      />,
    );
    // The button exists (the section is always rendered) but is disabled.
    const btn = await screen.findByRole("button", { name: "测试连接" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls check once with { proxy, timeout: 8000 } on Test click", async () => {
    setCheck(async () => null);
    await renderWithProxyEnabled("http://localhost:7897");

    const btn = screen.getByRole("button", { name: "测试连接" }) as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1);
    });
    expect(checkMock).toHaveBeenCalledWith({
      proxy: "http://localhost:7897",
      timeout: 8000,
    });
  });

  it("shows ✓ 可达 inline status when check resolves null", async () => {
    setCheck(async () => null);
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText(/可达/)).toBeDefined();
  });

  it("shows 可达 + 有新版本 note when check resolves an Update", async () => {
    setCheck(async () => ({ version: "1.5.0" }));
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText(/有新版本/)).toBeDefined();
  });

  it("shows 代理不可达 when check rejects with Connection refused", async () => {
    setCheck(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7897");
    });
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText(/不可达/)).toBeDefined();
  });

  it("shows GitHub-通不过 message when check rejects with timed out", async () => {
    setCheck(async () => {
      throw "operation timed out";
    });
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    // The timeout branch mentions GitHub (检查 Clash 规则是否放行 github.com).
    expect(await screen.findByText(/GitHub/)).toBeDefined();
  });

  it("flips the Test button label to 测试中… while in-flight", async () => {
    // A never-resolving promise keeps the handler in-flight so the 测试中…
    // label is rendered long enough to assert.
    setCheck(() => new Promise(() => {}));
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("测试中…")).toBeDefined();
    // And the button is now disabled while in-flight.
    const inFlight = screen.getByText("测试中…").closest("button");
    expect(inFlight).toBeTruthy();
    expect((inFlight as HTMLButtonElement).disabled).toBe(true);
  });

  it("does NOT invoke any install path — check is the only updater call", async () => {
    setCheck(async () => ({ version: "9.9.9" }));
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() => {
      expect(checkMock).toHaveBeenCalledTimes(1);
    });
    // The mocked updater module exposes ONLY check. If the Test button tried
    // to call downloadAndInstall, it would be undefined and throw. The single
    // check call + no thrown install error proves connectivity-only.
    expect(await screen.findByText(/有新版本/)).toBeDefined();
  });

  it("clears the test status when the URL is edited after a test", async () => {
    setCheck(async () => null);
    await renderWithProxyEnabled("http://localhost:7897");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/可达/)).toBeDefined();

    // Edit the URL — the inline test status should clear.
    const urlInput = screen.getByRole("textbox", { name: "Proxy URL" }) as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: "http://localhost:8888" } });

    await waitFor(() => {
      expect(screen.queryByText(/可达/)).toBeNull();
    });
  });
});
