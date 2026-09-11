import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceItem } from "../WorkspaceItem";
import { makeT, renderWithI18n } from "@/lib/i18n";
import type { WorkspaceConfig } from "@/lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

const workspace: WorkspaceConfig = {
  id: "workspace-1",
  name: "Main Workspace",
  projectDir: "Game",
  rootPath: "E:\\Game",
  p4Client: "main_client",
  p4User: "developer",
  lastSyncCl: null,
  lastSyncTime: null,
  lastSyncFileCount: null,
  parallelThreads: 4,
  exclusions: [],
  intervalMinutes: 60,
};

function renderItem(
  onSelect = vi.fn(),
  isBusy = false,
  overrides: {
    currentCl?: string | null;
    workspace?: WorkspaceConfig;
    isSelected?: boolean;
    onDelete?: () => void;
    locale?: "en" | "zh";
  } = {},
) {
  renderWithI18n(
    <TooltipProvider>
      <WorkspaceItem
        workspace={overrides.workspace ?? workspace}
        currentCl={overrides.currentCl ?? null}
        isSelected={overrides.isSelected ?? false}
        isBusy={isBusy}
        onSelect={onSelect}
        onDelete={overrides.onDelete ?? vi.fn()}
      />
    </TooltipProvider>,
    { locale: overrides.locale ?? "en" },
  );
  return { onSelect };
}

describe("WorkspaceItem selection semantics", () => {
  it("uses a native button for keyboard activation", () => {
    const { onSelect } = renderItem();
    const selection = screen.getByRole("button", { name: /^Main Workspace/ });

    expect(selection.tagName).toBe("BUTTON");
    fireEvent.click(selection);

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("disables selection while the workspace is busy", () => {
    renderItem(vi.fn(), true);

    expect(screen.getByRole("button", { name: /^Main Workspace/ })).toBeDisabled();
  });

  it("hides delete while the workspace is busy", () => {
    const t = makeT("en");
    renderItem(vi.fn(), true);

    expect(
      screen.queryByRole("button", {
        name: t("workspace.item.deleteAria", { name: workspace.name }),
      }),
    ).toBeNull();
  });
});

describe("WorkspaceItem dictionary chrome", () => {
  it("renders CL badge from workspace.item.clBadge when currentCl is set", () => {
    const t = makeT("en");
    renderItem(vi.fn(), false, { currentCl: "12345" });

    expect(
      screen.getByText(t("workspace.item.clBadge", { cl: "12345" })),
    ).toBeDefined();
  });

  it("paints -- glyph when currentCl is null", () => {
    renderItem();

    expect(screen.getByText("--")).toBeDefined();
  });

  it("sets delete aria-label from workspace.item.deleteAria", () => {
    const t = makeT("en");
    renderItem();

    expect(
      screen.getByRole("button", {
        name: t("workspace.item.deleteAria", { name: workspace.name }),
      }),
    ).toBeDefined();
  });

  it("keeps rootPath E:\\Game visible verbatim", () => {
    renderItem();

    expect(screen.getByText("E:\\Game")).toBeDefined();
  });

  it("keeps a 5+ digit last-synced CL fully visible", () => {
    const t = makeT("en");
    renderItem(vi.fn(), false, {
      currentCl: "38012",
      workspace: {
        ...workspace,
        name: "Very Long Workspace Name That Should Ellipsize In The Sidebar",
      },
    });

    const clBadge = screen.getByText(t("workspace.item.clBadge", { cl: "38012" }));
    expect(clBadge).toBeDefined();
    expect(clBadge.className).toContain("shrink-0");
  });

  it("zh smoke: delete aria-label equals workspace.item.deleteAria", () => {
    const tZh = makeT("zh");
    renderItem(vi.fn(), false, { locale: "zh" });

    expect(
      screen.getByRole("button", {
        name: tZh("workspace.item.deleteAria", { name: workspace.name }),
      }),
    ).toBeDefined();
  });
});
