import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { WorkspaceHealthPanel } from "@/components/sync/WorkspaceHealthPanel";
import { makeT, renderWithI18n } from "@/lib/i18n";
import type { WorkspaceHealthReport } from "@/lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

// react-virtuoso cannot measure in jsdom. Render itemContent so LogViewer
// paths stay assertable after native <details> grouping.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, entry: unknown) => ReactNode;
  }) => (
    <div>
      {data.map((entry, i) => (
        <div key={i}>{itemContent(i, entry)}</div>
      ))}
    </div>
  ),
}));

// Mutable hook mock — each test sets the state it needs before rendering.
const hoisted = vi.hoisted(() => ({
  mockHealth: {
    report: null as WorkspaceHealthReport | null,
    loading: false,
    error: null as string | null,
    runAudit: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock("@/hooks/useWorkspaceHealth", () => ({
  useWorkspaceHealth: (_workspaceId?: string | null) => hoisted.mockHealth,
}));

// Copied from src/lib/__tests__/useWorkspaceHealth.test.ts sampleReport.
const sampleReport: WorkspaceHealthReport = {
  categories: [
    { category: "unmapped", count: 1, paths: ["ExampleGame/ExampleGame.uproject"] },
    { category: "missing-on-disk", count: 0, paths: [] },
    { category: "not-in-depot", count: 2, paths: ["Config/X.ini", "Source/Y.cpp"] },
    { category: "differs", count: 0, paths: [] },
    { category: "needs-resolve", count: 0, paths: [] },
  ],
  stream: "//ExampleDepot/ExampleGame main",
};

function resetMockHealth() {
  hoisted.mockHealth.report = null;
  hoisted.mockHealth.loading = false;
  hoisted.mockHealth.error = null;
  hoisted.mockHealth.runAudit = vi.fn();
  hoisted.mockHealth.reset = vi.fn();
}

describe("WorkspaceHealthPanel dictionary chrome", () => {
  it("renders the five category labels from the dictionary (populated report)", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(screen.getByText(t("sync.health.unmapped"))).toBeDefined();
    expect(screen.getByText(t("sync.health.missingOnDisk"))).toBeDefined();
    expect(screen.getByText(t("sync.health.notInDepot"))).toBeDefined();
    expect(screen.getByText(t("sync.health.differs"))).toBeDefined();
    expect(screen.getByText(t("sync.health.needsResolve"))).toBeDefined();
  });

  it("renders no CJK-slash-Latin compound anywhere", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(screen.queryByText(/ \/ /)).toBeNull();
  });

  it("renders title, subtitle, and outlined Audit from the dictionary", () => {
    resetMockHealth();
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    const title = screen.getByText(t("sync.health.title"));
    expect(title.tagName).toBe("H2");
    expect(screen.getByText(t("sync.health.subtitle"))).toBeDefined();
    const audit = screen.getByRole("button", { name: t("sync.health.audit") });
    expect(audit).toBeDefined();
    expect(audit.getAttribute("data-variant")).toBe("outline");
  });

  it("idle (no report) shows emptyHint and does not show category labels", () => {
    resetMockHealth();
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(screen.getByText(t("sync.health.emptyHint"))).toBeDefined();
    expect(screen.queryByText(t("sync.health.unmapped"))).toBeNull();
    expect(screen.queryByText(t("sync.health.missingOnDisk"))).toBeNull();
    expect(screen.queryByText(t("sync.health.notInDepot"))).toBeNull();
    expect(screen.queryByText(t("sync.health.differs"))).toBeNull();
    expect(screen.queryByText(t("sync.health.needsResolve"))).toBeNull();
  });

  it("Audit is outlined, labelled, and disabled when workspaceId is null or loading", () => {
    resetMockHealth();
    const t = makeT("en");
    const { unmount } = renderWithI18n(<WorkspaceHealthPanel workspaceId={null} />);
    const idleAudit = screen.getByRole("button", { name: t("sync.health.audit") });
    expect(idleAudit.getAttribute("data-variant")).toBe("outline");
    expect((idleAudit as HTMLButtonElement).disabled).toBe(true);
    unmount();

    resetMockHealth();
    hoisted.mockHealth.loading = true;
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    const auditing = screen.getByRole("button", { name: t("sync.health.auditing") });
    expect(auditing.getAttribute("data-variant")).toBe("outline");
    expect((auditing as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t("sync.health.auditing"), { selector: "p" })).toBeDefined();
  });

  it("loading hides a previous report and shows auditing chrome", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    hoisted.mockHealth.loading = true;
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(screen.getByText(t("sync.health.auditing"), { selector: "p" })).toBeDefined();
    expect(screen.queryByText(t("sync.health.unmapped"))).toBeNull();
    expect(screen.queryByText(t("sync.health.emptyHint"))).toBeNull();
  });

  it("error state shows raw error string and retryHint with outlined Retry; no categories", () => {
    resetMockHealth();
    hoisted.mockHealth.error = "Connection refused by p4 server";
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(screen.getByText("Connection refused by p4 server")).toBeDefined();
    expect(screen.getByText(t("sync.health.retryHint"))).toBeDefined();
    const retry = screen.getByRole("button", { name: t("sync.health.retry") });
    expect(retry.getAttribute("data-variant")).toBe("outline");
    expect(screen.queryByText(t("sync.health.unmapped"))).toBeNull();
    expect(screen.queryByText(t("sync.health.needsResolve"))).toBeNull();
  });

  it("stream label interpolates the raw stream name", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(
      screen.getByText(
        t("sync.health.stream", { stream: sampleReport.stream as string }),
      ),
    ).toBeDefined();
    expect(screen.getByText(/\/\/ExampleDepot\/ExampleGame main/)).toBeDefined();
  });

  it("omits the stream line when report.stream is falsy", () => {
    resetMockHealth();
    hoisted.mockHealth.report = { ...sampleReport, stream: null };
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(screen.queryByText(/Stream/)).toBeNull();
  });

  it("zero-count groups are collapsed details; opening summary shows common.none", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    const missing = screen.getByText(t("sync.health.missingOnDisk"));
    const details = missing.closest("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    fireEvent.click(missing.closest("summary")!);
    expect(details!.open).toBe(true);
    expect(within(details!).getByText(t("common.none"))).toBeDefined();
  });

  it("non-zero groups default open and render LogViewer paths", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    const unmapped = screen.getByText(t("sync.health.unmapped"));
    const details = unmapped.closest("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(true);
    expect(screen.getByText("ExampleGame/ExampleGame.uproject")).toBeDefined();
    expect(screen.getByText("Config/X.ini")).toBeDefined();
    expect(screen.getByText("Source/Y.cpp")).toBeDefined();
  });

  it("needs-resolve label and count use text-destructive", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    const label = screen.getByText(t("sync.health.needsResolve"));
    expect(label.className.split(/\s+/)).toContain("text-destructive");
    const count = label.nextElementSibling;
    expect(count).not.toBeNull();
    expect(count!.textContent).toBe("0");
    expect(count!.className.split(/\s+/)).toContain("text-destructive");
  });

  it("renders readonly footer from dictionary", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    const t = makeT("en");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />);
    expect(screen.getByText(t("sync.health.readonlyFooter"))).toBeDefined();
  });

  it("zh smoke: title and unmapped equal sync.health.title / unmapped", () => {
    resetMockHealth();
    hoisted.mockHealth.report = sampleReport;
    const zh = makeT("zh");
    renderWithI18n(<WorkspaceHealthPanel workspaceId="w1" />, { locale: "zh" });
    expect(screen.getByText(zh("sync.health.title"))).toBeDefined();
    expect(screen.getByText(zh("sync.health.unmapped"))).toBeDefined();
  });
});
