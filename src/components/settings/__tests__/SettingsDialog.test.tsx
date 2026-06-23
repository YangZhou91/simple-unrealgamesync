import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
