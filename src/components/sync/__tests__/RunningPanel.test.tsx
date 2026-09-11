import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { RunningPanel } from "@/components/sync/RunningPanel";
import { STEP_ORDER } from "@/lib/types";
import type { StepStatus, SyncStep } from "@/lib/types";
import { makeT, renderWithI18n } from "@/lib/i18n";

// Phase 26 (26-02 Task 2): the canonical running composition — ordered
// five-step rail, one-semantic-cancel contract, typed header target, and
// unchanged progress-mode passthrough. Follows the ProgressSection.test.tsx
// conventions: renderWithI18n + the @tauri-apps/api/core and
// @/lib/localeSettings mocks, plus a no-op plugin-log info (RunningPanel
// imports it for its three diagnostic effects) and the jsdom Virtuoso mock.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(() => Promise.resolve()),
}));
// react-virtuoso cannot measure in jsdom — render itemContent directly.
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

const STATUSES_ALL_PENDING: Record<SyncStep, StepStatus> = {
  closeUe: "pending",
  closeExcel: "pending",
  cleanDevDir: "pending",
  p4Sync: "pending",
  genProject: "pending",
};

const BASE_PROPS = {
  stepStatuses: STATUSES_ALL_PENDING,
  progress: { current: 0, total: 0, currentFile: "" },
  logLines: [] as string[],
  currentStep: null as SyncStep | null,
  onCancel: () => {},
};

// Test 1 (ordered steps): every STEP_ORDER member renders, in order, with
// its live status and render-time localized label — including the ACTIVE
// step's resolved machine sub-step.
describe("RunningPanel ordered five-step rail", () => {
  it("renders all five steps in STEP_ORDER order with their labels", () => {
    const t = makeT("en");
    renderWithI18n(<RunningPanel {...BASE_PROPS} currentStep="p4Sync" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
    const expected = [
      t("steps.closeUe.check"),
      t("steps.closeExcel.check"),
      t("steps.cleanDevDir.clean"),
      // Empty targetCl -> p4Sync renders the static `all` variant.
      t("steps.p4Sync.all"),
      t("steps.genProject.gen"),
    ];
    expect(STEP_ORDER).toHaveLength(5);
    items.forEach((item, i) => {
      expect(item.textContent).toContain(expected[i]);
    });
  });

  it("the ACTIVE step resolves its real machine sub-step label", () => {
    const t = makeT("en");
    renderWithI18n(
      <RunningPanel
        {...BASE_PROPS}
        currentStep="p4Sync"
        currentSubStep="toCl"
        targetCl="12345"
        stepStatuses={{
          closeUe: "completed",
          closeExcel: "completed",
          cleanDevDir: "completed",
          p4Sync: "active",
          genProject: "pending",
        }}
      />,
    );
    // The active rail item carries the live toCl composition...
    const items = screen.getAllByRole("listitem");
    expect(items[3].textContent).toContain(
      t("steps.p4Sync.toCl", { cl: "12345" }),
    );
    // ...rendered exactly twice in the panel: rail item + header target line
    // (the single-occurrence rule keeps every other step static).
    expect(
      screen.getAllByText(t("steps.p4Sync.toCl", { cl: "12345" })),
    ).toHaveLength(2);
  });

  it("statuses drive the index treatment: pending index, active index, completed check", () => {
    renderWithI18n(
      <RunningPanel
        {...BASE_PROPS}
        currentStep="p4Sync"
        stepStatuses={{
          closeUe: "completed",
          closeExcel: "completed",
          cleanDevDir: "completed",
          p4Sync: "active",
          genProject: "pending",
        }}
      />,
    );
    const items = screen.getAllByRole("listitem");
    // Completed steps carry the success check affordance (svg), no index digit.
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[0].textContent).not.toContain("1");
    // The active step shows its real 1-5 index.
    expect(items[3].textContent).toContain("4");
    // The pending step shows its index too.
    expect(items[4].textContent).toContain("5");
  });
});

// Test 2 (cancel): exactly one semantic Cancel Sync; click invokes the
// callback once; cancel-pending replaces it in place with a natively
// disabled, typed, still-visible Cancelling button.
describe("RunningPanel cancel contract", () => {
  it("clicking Cancel Sync invokes onCancel exactly once", () => {
    const t = makeT("en");
    const onCancel = vi.fn();
    renderWithI18n(<RunningPanel {...BASE_PROPS} onCancel={onCancel} />);
    const cancel = screen.getByRole("button", { name: t("sync.cancel") });
    expect(screen.getAllByRole("button", { name: t("sync.cancel") })).toHaveLength(1);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("isCancelling renders one natively disabled typed Cancelling button and no cancel path", () => {
    const t = makeT("en");
    const onCancel = vi.fn();
    renderWithI18n(
      <RunningPanel {...BASE_PROPS} isCancelling={true} onCancel={onCancel} />,
    );
    const cancelling = screen.getByRole("button", { name: t("sync.cancelling") });
    expect(cancelling).toBeDefined();
    expect((cancelling as HTMLButtonElement).disabled).toBe(true);
    // The pending button carries the spinner affordance.
    expect(cancelling.querySelector("svg")).not.toBeNull();
    // No repeat-cancel control exists anywhere.
    expect(screen.queryByRole("button", { name: t("sync.cancel") })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: t("sync.cancelling") }),
    ).toHaveLength(1);
    // Clicking the disabled pending button calls nothing again.
    fireEvent.click(cancelling);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// Test 3 (header target): a set targetCl renders the existing toCl
// composition with the real CL; an empty targetCl renders the typed HEAD
// target line. Stream / P4 client stay raw supporting context.
describe("RunningPanel header target context", () => {
  it("empty targetCl renders the typed HEAD target line once", () => {
    const t = makeT("en");
    renderWithI18n(<RunningPanel {...BASE_PROPS} currentStep="p4Sync" />);
    expect(screen.getAllByText(t("sync.running.targetHead"))).toHaveLength(1);
    // The running title chrome is present.
    expect(screen.getByText(t("sync.running.title"))).toBeDefined();
    // With an empty target the toCl composition renders nowhere.
    expect(screen.queryByText(/Syncing to CL/)).toBeNull();
  });

  it("set targetCl renders the toCl composition with the real CL (header owns it)", () => {
    const t = makeT("en");
    renderWithI18n(
      <RunningPanel
        {...BASE_PROPS}
        currentStep="closeUe"
        targetCl="12345"
      />,
    );
    expect(
      screen.getAllByText(t("steps.p4Sync.toCl", { cl: "12345" })),
    ).toHaveLength(1);
    expect(screen.queryByText(t("sync.running.targetHead"))).toBeNull();
  });

  it("stream and client render as raw supporting context", () => {
    renderWithI18n(
      <RunningPanel
        {...BASE_PROPS}
        stream="//DemoDepot/Stream_Main"
        p4Client="my_client_name"
      />,
    );
    expect(screen.getByText(/\/\/DemoDepot\/Stream_Main/)).toBeDefined();
    expect(screen.getByText(/my_client_name/)).toBeDefined();
  });
});

// Test 4 (mode passthrough): the preserved RunningPanel mode derivation
// (prep timer, indeterminate, byte/overrun rules) drives ProgressSection's
// rendered output unchanged.
describe("RunningPanel progress mode passthrough", () => {
  it("p4Sync with a live byte signal renders the byte-driven bar", () => {
    renderWithI18n(
      <RunningPanel
        {...BASE_PROPS}
        currentStep="p4Sync"
        progress={{
          current: 5,
          total: 10,
          currentFile: "//depot/Foo.cpp",
          bytesDone: 2_000_000_000,
          bytesTotal: 8_000_000_000,
          bytesRate: 45_000_000,
        }}
      />,
    );
    // Byte text primary line + determinate contained fill at 25%.
    expect(screen.getByText(/2\.0 GB \/ 8\.0 GB/)).toBeDefined();
    const indicator = document.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;
    expect(indicator.style.width).toBe("25%");
    expect(indicator.className).not.toContain("progress-indeterminate-indicator");
  });

  it("genProject renders the indeterminate bar with its typed label", () => {
    const t = makeT("en");
    renderWithI18n(
      <RunningPanel {...BASE_PROPS} currentStep="genProject" />,
    );
    const indicator = document.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;
    expect(indicator.className).toContain("progress-indeterminate-indicator");
    // The genProject label renders on the rail AND as the indeterminate
    // mode's primary line (the WIRE-01 dual-occurrence contract).
    expect(screen.getAllByText(t("steps.genProject.gen"))).toHaveLength(2);
  });

  it("overrun without a byte signal renders the indeterminate overrun label", () => {
    const t = makeT("en");
    renderWithI18n(
      <RunningPanel
        {...BASE_PROPS}
        currentStep="p4Sync"
        progress={{
          current: 13660,
          total: 13657,
          currentFile: "",
          bytesDone: null,
          bytesTotal: null,
          bytesRate: null,
        }}
      />,
    );
    const indicator = document.querySelector(
      '[data-slot="progress-indicator"]',
    ) as HTMLElement;
    expect(indicator.className).toContain("progress-indeterminate-indicator");
    expect(
      screen.getByText(t("sync.files.overrun", { n: 13657 })),
    ).toBeDefined();
  });
});
