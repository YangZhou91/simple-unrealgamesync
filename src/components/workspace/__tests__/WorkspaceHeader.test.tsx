import type { ComponentProps } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "../WorkspaceHeader";
import { makeT, renderWithI18n } from "@/lib/i18n";
import type { GitBranchInfo, WorkspaceConfig } from "@/lib/types";

vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

const workspace: WorkspaceConfig = {
  id: "workspace-1",
  name: "DemoGame Development Workspace",
  rootPath: "D:\\DemoDepot\\DemoGame",
  projectDir: "DemoGame",
  p4Client: "fy_dev_client",
  p4User: "developer",
  lastSyncCl: "381699",
  lastSyncTime: null,
  lastSyncFileCount: null,
  parallelThreads: 4,
  exclusions: [],
  intervalMinutes: 60,
};

const gitBranchInfo: GitBranchInfo = {
  branch: "UE5.7.1",
  ahead: 0,
  behind: 18,
  remote: "origin",
  short_hash: "99ba6d897051",
  is_detached: false,
};

function renderHeader(
  props: Partial<ComponentProps<typeof WorkspaceHeader>> = {},
  locale: "zh" | "en" = "en",
) {
  return renderWithI18n(
    <WorkspaceHeader
      selectedWorkspace={workspace}
      stream="//DemoDepot/DemoStream"
      p4Client={workspace.p4Client}
      gitBranchInfo={gitBranchInfo}
      gitBranchLoading={false}
      {...props}
    />,
    { locale },
  );
}

describe("WorkspaceHeader", () => {
  it("renders raw workspace identity and exposes metadata through its closed disclosure", () => {
    const t = makeT("en");
    renderHeader();

    expect(screen.getByRole("heading", { name: workspace.name })).toBeTruthy();
    expect(screen.getByText(workspace.rootPath)).toBeTruthy();

    const summary = screen.getByText(t("workspace.header.showMetadata"));
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);

    fireEvent.keyDown(summary, { key: "Enter" });
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText("//DemoDepot/DemoStream")).toBeTruthy();
    expect(screen.getByText(workspace.p4Client)).toBeTruthy();
    expect(screen.getByText("UE5.7.1 · 99ba6d897051")).toBeTruthy();
  });

  it("uses supplied fallbacks without fabricating metadata", () => {
    const t = makeT("en");
    renderHeader({ stream: null, p4Client: null, gitBranchInfo: null });

    const summary = screen.getByText(t("workspace.header.showMetadata"));
    fireEvent.click(summary);

    expect(screen.getByText(t("sync.dash.classicClient"))).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText(t("sync.dash.gitUnavailable"))).toBeTruthy();
    expect(screen.getByText(t("workspace.header.gitUnavailableHelp"))).toBeTruthy();
  });

  it("renders loading and detached Git states from props", () => {
    const t = makeT("en");
    const { rerender } = renderHeader({ gitBranchLoading: true });
    const summary = screen.getByText(t("workspace.header.showMetadata"));
    fireEvent.click(summary);
    expect(screen.getByText(t("sync.dash.gitChecking"))).toBeTruthy();

    rerender(
      <WorkspaceHeader
        selectedWorkspace={workspace}
        stream="//DemoDepot/DemoStream"
        p4Client={workspace.p4Client}
        gitBranchLoading={false}
        gitBranchInfo={{ ...gitBranchInfo, branch: "HEAD", is_detached: true }}
      />,
    );
    expect(screen.getByText(`${t("sync.dash.gitDetached")} · 99ba6d897051`)).toBeTruthy();
  });

  it("changes chrome but retains raw values across locales", () => {
    const tZh = makeT("zh");
    renderHeader({}, "zh");

    expect(screen.getByText(tZh("workspace.header.current"))).toBeTruthy();
    expect(screen.getByText(workspace.rootPath)).toBeTruthy();
    expect(screen.getByRole("heading", { name: workspace.name })).toBeTruthy();
  });

  it("renders nothing without a selected workspace", () => {
    const { container } = renderWithI18n(
      <WorkspaceHeader selectedWorkspace={null} stream={null} p4Client={null} gitBranchInfo={null} gitBranchLoading={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
