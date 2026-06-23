import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IdlePanel } from "@/components/sync/IdlePanel";

describe("IdlePanel CL input", () => {
  const baseProps = {
    lastSyncResult: null,
    hasWorkspace: true,
    targetCl: "",
    onTargetClChange: () => {},
    onStartSync: () => {},
    onGitPull: () => {},
    isBusy: false,
    gitBranchInfo: null,
    gitBranchLoading: false,
    behindInfo: null,
    behindLoading: false,
  };

  it("shows CL input with Target CL label", () => {
    render(<IdlePanel {...baseProps} />);
    expect(screen.getByText("Target CL (optional)")).toBeDefined();
    expect(
      screen.getByPlaceholderText("Leave empty for HEAD"),
    ).toBeDefined();
  });

  it("shows validation error for non-numeric CL input", () => {
    render(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText("Leave empty for HEAD");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText("CL must be a number")).toBeDefined();
  });

  it("disables Start Sync button when CL validation fails", () => {
    render(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText("Leave empty for HEAD");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(
      (screen.getByRole("button", { name: /start sync/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("accepts numeric CL input without error", () => {
    render(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText("Leave empty for HEAD");
    fireEvent.change(input, { target: { value: "12345" } });
    expect(screen.queryByText("CL must be a number")).toBeNull();
    expect(
      (screen.getByRole("button", { name: /start sync/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("clears error when input becomes valid", () => {
    render(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText("Leave empty for HEAD");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText("CL must be a number")).toBeDefined();
    fireEvent.change(input, { target: { value: "12345" } });
    expect(screen.queryByText("CL must be a number")).toBeNull();
  });
});
