import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";
import { makeT, renderWithI18n } from "@/lib/i18n";
import type { UpdaterInfo } from "@/hooks/useUpdater";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => "0.0.0",
}));

const changelogState = vi.hoisted(() => ({
  changelog: [] as Array<{
    hash: string;
    date: string;
    type?: string;
    subject: string;
  }>,
}));

vi.mock("virtual:changelog", () => ({
  get changelog() {
    return changelogState.changelog;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const idleUpdater: UpdaterInfo = {
  state: "idle",
  version: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

const baseProps = {
  workspaces: [],
  selectedId: null,
  currentCl: null,
  isBusy: false,
  onSelect: () => {},
  onDelete: () => {},
  onAdd: async () => {},
  onOpenSettings: () => {},
  isSettingsDisabled: false,
  updaterInfo: idleUpdater,
  onCheckUpdate: () => {},
  isFormOpen: false,
  onFormOpenChange: () => {},
};

describe("Sidebar workspace-section dictionary chrome", () => {
  it("renders title, add, perforce ready, and tagline from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(<Sidebar {...baseProps} />);

    expect(screen.getByText(t("workspace.sidebar.title"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("workspace.sidebar.add") }),
    ).toBeDefined();
    expect(screen.getByText(t("workspace.sidebar.perforceReady"))).toBeDefined();
    expect(screen.getByText(t("workspace.sidebar.tagline"))).toBeDefined();
  });

  it("sets settings and connected aria-labels from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(<Sidebar {...baseProps} />);

    expect(
      screen.getAllByRole("button", {
        name: t("workspace.sidebar.settingsAria"),
      }),
    ).toHaveLength(2);
    expect(
      screen.getByLabelText(t("workspace.sidebar.connectedAria")),
    ).toBeDefined();
  });

  it("keeps brand Simple UGS untranslated", () => {
    renderWithI18n(<Sidebar {...baseProps} />);

    expect(screen.getByText("Simple UGS")).toBeDefined();
  });

  it("zh smoke: title and add equal workspace.sidebar.title / add", () => {
    const tZh = makeT("zh");
    renderWithI18n(<Sidebar {...baseProps} />, { locale: "zh" });

    expect(screen.getByText(tZh("workspace.sidebar.title"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: tZh("workspace.sidebar.add") }),
    ).toBeDefined();
  });
});

async function openChangelog() {
  fireEvent.click(await screen.findByText("v0.0.0"));
}

describe("Sidebar changelog and updater dictionary chrome", () => {
  beforeEach(() => {
    changelogState.changelog = [];
  });

  it("paints empty changelog from layout.changelog.empty", async () => {
    const t = makeT("en");
    renderWithI18n(<Sidebar {...baseProps} />);
    await openChangelog();

    expect(screen.getByText(t("layout.changelog.empty"))).toBeDefined();
  });

  it("DialogTitle equals layout.changelog.title with version", async () => {
    const t = makeT("en");
    renderWithI18n(<Sidebar {...baseProps} />);
    await openChangelog();

    expect(
      screen.getByRole("heading", {
        name: t("layout.changelog.title", { version: "0.0.0" }),
      }),
    ).toBeDefined();
  });

  it("idle updater control aria-label equals layout.updater.checkAria", () => {
    const t = makeT("en");
    renderWithI18n(<Sidebar {...baseProps} />);

    expect(
      screen.getByRole("button", { name: t("layout.updater.checkAria") }),
    ).toBeDefined();
  });

  it("keeps brand Simple UGS present", () => {
    renderWithI18n(<Sidebar {...baseProps} />);

    expect(screen.getByText("Simple UGS")).toBeDefined();
  });

  it("renders changelog hash, date, and subject verbatim", async () => {
    changelogState.changelog = [
      {
        hash: "a1b2c3d",
        date: "2026-09-01",
        type: "feat",
        subject: "wire layout chrome",
      },
    ];
    renderWithI18n(<Sidebar {...baseProps} />);
    await openChangelog();

    expect(screen.getByText("a1b2c3d")).toBeDefined();
    expect(screen.getByText("2026-09-01")).toBeDefined();
    expect(screen.getByText("wire layout chrome")).toBeDefined();
  });

  it("zh smoke: empty changelog equals layout.changelog.empty", async () => {
    const tZh = makeT("zh");
    renderWithI18n(<Sidebar {...baseProps} />, { locale: "zh" });
    await openChangelog();

    expect(screen.getByText(tZh("layout.changelog.empty"))).toBeDefined();
  });
});
