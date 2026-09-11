import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { WorkspaceEmptyState } from "@/components/workspace/WorkspaceEmptyState";
import { makeT, renderWithI18n } from "@/lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

describe("WorkspaceEmptyState", () => {
  it("renders title, reused description, and accent add from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(<WorkspaceEmptyState onAdd={() => {}} />);
    expect(screen.getByText(t("workspace.empty.title"))).toBeDefined();
    expect(screen.getByText(t("workspace.form.description"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("workspace.empty.add") }),
    ).toBeDefined();
  });

  it("clicking the accent button calls onAdd", () => {
    const t = makeT("en");
    const onAdd = vi.fn();
    renderWithI18n(<WorkspaceEmptyState onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: t("workspace.empty.add") }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("zh smoke: heading equals workspace.empty.title", () => {
    const tZh = makeT("zh");
    renderWithI18n(<WorkspaceEmptyState onAdd={() => {}} />, { locale: "zh" });
    expect(screen.getByText(tZh("workspace.empty.title"))).toBeDefined();
  });
});
