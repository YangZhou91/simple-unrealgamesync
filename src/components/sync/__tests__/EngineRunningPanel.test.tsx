import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { EngineRunningPanel } from "@/components/sync/EngineRunningPanel";
import { makeT, renderWithI18n } from "@/lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
// react-virtuoso cannot measure in jsdom — render rows directly (same mock as
// GitRunningPanel.test.tsx) so the raw log-line asserts are meaningful.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: string[];
    itemContent: (index: number, line: string) => React.ReactNode;
  }) => (
    <div>
      {data.map((line, i) => (
        <div key={i}>{itemContent(i, line)}</div>
      ))}
    </div>
  ),
}));

const baseProps = {
  engineState: "running" as const,
  logLines: [] as string[],
  errorInfo: null,
  onCancel: () => {},
  onBack: () => {},
  onRetry: () => {},
};

function progressNumberText(): string | null {
  const el = document.querySelector('[data-slot="progress-number"]');
  return el ? el.textContent : null;
}

describe("EngineRunningPanel running surface", () => {
  it("renders the running title, muted P4 chip, and the single Cancel Update", () => {
    const t = makeT("en");
    renderWithI18n(<EngineRunningPanel {...baseProps} />);
    expect(screen.getByText(t("sync.engineP4.runningTitle"))).toBeDefined();
    expect(screen.getByText(t("sync.badge.p4"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("sync.engineP4.cancel") }),
    ).toBeDefined();
    // No synthetic context line / no Git identity chrome.
    expect(screen.queryByText(t("sync.git.checking"))).toBeNull();
  });

  it("renders the count-driven determinate bar for a real denominator", () => {
    const t = makeT("en");
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        progress={{ current: 50, total: 100, currentFile: "Engine/Source/Foo.cpp" }}
      />,
    );
    expect(progressNumberText()).toBe("50%");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("Engine/Source/Foo.cpp")).toBeDefined();
    expect(screen.getByText(t("sync.files.count", { current: 50, total: 100 }))).toBeDefined();
  });

  it("renders the bounded log card with the P4 output title and the raw lines", () => {
    const t = makeT("en");
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        progress={{ current: 3, total: 9, currentFile: "f.cpp" }}
        logLines={["raw engine line 1", "raw engine line 2"]}
      />,
    );
    expect(screen.getByText(t("sync.engineP4.logTitle"))).toBeDefined();
    expect(screen.getByText("raw engine line 1")).toBeDefined();
    expect(screen.getByText("raw engine line 2")).toBeDefined();
  });
});

describe("EngineRunningPanel progress boundary + precision", () => {
  it("total === 0 renders the indeterminate bar labelled with the step label and the latest raw log line", () => {
    const t = makeT("en");
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        progress={{ current: 5, total: 0, currentFile: "" }}
        currentStep="engineUpdate"
        currentSubStep="count"
        logLines={["one", "latest raw line"]}
      />,
    );
    // The machine-key label resolves through useStepLabels.
    expect(screen.getByText(t("steps.engineUpdate.count"))).toBeDefined();
    // No fabricated percentage number.
    expect(progressNumberText()).toBeNull();
    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    // Latest raw log line rides the detail line AND the log body.
    expect(screen.getAllByText("latest raw line")).toHaveLength(2);
  });

  it("current === total renders exactly 100 with the honest overrun count", () => {
    const t = makeT("en");
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        progress={{ current: 250, total: 250, currentFile: "f.cpp" }}
      />,
    );
    expect(progressNumberText()).toBe("100%");
    expect(screen.getByText(t("sync.files.overrun", { n: 250 }))).toBeDefined();
  });

  it("a large equal pair (4000000/4000000) renders exactly 100", () => {
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        progress={{ current: 4000000, total: 4000000, currentFile: "f.cpp" }}
      />,
    );
    expect(progressNumberText()).toBe("100%");
  });

  it("current > total (the estimate was outrun) never renders above 100", () => {
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        progress={{ current: 1500, total: 1000, currentFile: "f.cpp" }}
      />,
    );
    expect(progressNumberText()).toBe("100%");
  });
});

describe("EngineRunningPanel terminal states", () => {
  it("success renders the success heading + the CL line and one Back to Idle", () => {
    const t = makeT("en");
    const onBack = vi.fn();
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        engineState="success"
        resultCl="381234"
        onBack={onBack}
        logLines={["raw"]}
      />,
    );
    expect(screen.getByText(t("sync.engineP4.success"))).toBeDefined();
    expect(
      screen.getByText(t("sync.engineP4.successLine", { cl: "381234" })),
    ).toBeDefined();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t("sync.engineP4.back") }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t("sync.engineP4.logTitle"))).toBeDefined();
  });

  it("error is a destructive card with the raw error as a sibling mono node and one Back", () => {
    const t = makeT("en");
    renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        engineState="error"
        errorInfo={{ error: "GenerateProjectFiles.bat not found" }}
      />,
    );
    expect(screen.getByText(t("sync.engineP4.failed"))).toBeDefined();
    const raw = screen.getByText("GenerateProjectFiles.bat not found");
    expect(raw.className).toContain("font-mono");
    expect(raw.className).toContain("[overflow-wrap:anywhere]");
    // never glued into a translated sentence
    expect(
      screen.queryByText(`Engine update failed: GenerateProjectFiles.bat not found`),
    ).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(t("sync.engineP4.logTitle"))).toBeDefined();
  });

  it("error with a null payload falls back to the unknown-error key", () => {
    const t = makeT("en");
    renderWithI18n(
      <EngineRunningPanel {...baseProps} engineState="error" errorInfo={null} />,
    );
    expect(screen.getByText(t("sync.engineP4.unknownError"))).toBeDefined();
  });

  it("partial renders both regions, the 1px divider, and Retry then Back in one action row", () => {
    const t = makeT("en");
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const { container } = renderWithI18n(
      <EngineRunningPanel
        {...baseProps}
        engineState="partial"
        resultCl="381234"
        errorInfo={{ error: "GenerateProjectFiles.bat not found" }}
        onRetry={onRetry}
        onBack={onBack}
      />,
    );
    // Region A — the engine's real success survives.
    expect(screen.getByText(t("sync.engineP4.success"))).toBeDefined();
    expect(
      screen.getByText(t("sync.engineP4.successLine", { cl: "381234" })),
    ).toBeDefined();
    // Region B — the genProject failure.
    expect(screen.getByText(t("sync.engineP4.partial"))).toBeDefined();
    expect(screen.getByText("GenerateProjectFiles.bat not found")).toBeDefined();
    // The full-bleed 1px divider between the regions.
    expect(container.querySelector('div[class="border-t border-border"]')).not.toBeNull();
    // Both actions, Retry first.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain(t("sync.engineP4.retry"));
    expect(buttons[1].textContent).toContain(t("sync.engineP4.back"));
    fireEvent.click(buttons[0]);
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(buttons[1]);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t("sync.engineP4.logTitle"))).toBeDefined();
  });

  it("renders every terminal's log card (all four states)", () => {
    const t = makeT("en");
    for (const engineState of ["running", "success", "error", "partial"] as const) {
      const { unmount } = renderWithI18n(
        <EngineRunningPanel {...baseProps} engineState={engineState} />,
      );
      expect(screen.getByText(t("sync.engineP4.logTitle"))).toBeDefined();
      unmount();
    }
  });

  it("zh smoke: success chrome resolves from the zh dictionary", () => {
    const tZh = makeT("zh");
    renderWithI18n(
      <EngineRunningPanel {...baseProps} engineState="success" resultCl="42" />,
      { locale: "zh" },
    );
    expect(screen.getByText(tZh("sync.engineP4.success"))).toBeDefined();
    expect(
      screen.getByText(tZh("sync.engineP4.successLine", { cl: "42" })),
    ).toBeDefined();
  });
});
