import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceList } from "../WorkspaceList";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithI18n } from "@/lib/i18n";
import type { WorkspaceConfig } from "@/lib/types";

vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

const workspaces: WorkspaceConfig[] = [
  { id: "one", name: "Alpha", rootPath: "D:\\Alpha", projectDir: "Game", p4Client: "alpha", p4User: "dev", lastSyncCl: "10001", lastSyncTime: null, lastSyncFileCount: null, parallelThreads: 4, exclusions: [], intervalMinutes: 60 },
  { id: "two", name: "Beta", rootPath: "D:\\Beta", projectDir: "Game", p4Client: "beta", p4User: "dev", lastSyncCl: "10002", lastSyncTime: null, lastSyncFileCount: null, parallelThreads: 4, exclusions: [], intervalMinutes: 60 },
];

function renderList(isBusy = false, onSelect = vi.fn(), onDelete = vi.fn()) {
  return renderWithI18n(
    <TooltipProvider>
      <WorkspaceList
        workspaces={workspaces}
        currentCls={{ one: "10001", two: "10002" }}
        selectedId="one"
        isBusy={isBusy}
        onSelect={onSelect}
        onDelete={onDelete}
      />
    </TooltipProvider>,
  );
}

describe("WorkspaceList", () => {
  it("returns no placeholder for zero workspaces", () => {
    const { container } = renderWithI18n(
      <WorkspaceList workspaces={[]} currentCls={{}} selectedId={null} isBusy={false} onSelect={() => {}} onDelete={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders source-order native selection buttons and dispatches IDs", () => {
    const onSelect = vi.fn();
    renderList(false, onSelect);
    const buttons = screen.getAllByRole("button", { name: /Alpha|Beta/ })
      .filter((button) => !button.getAttribute("aria-label")?.startsWith("Delete"));
    expect(buttons.map((button) => button.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Alpha"), expect.stringContaining("Beta")]));
    fireEvent.click(buttons.find((button) => button.textContent?.includes("Beta"))!);
    expect(onSelect).toHaveBeenCalledWith("two");
  });

  it("disables selection and removes delete controls while busy", () => {
    renderList(true);
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Beta/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });
});
