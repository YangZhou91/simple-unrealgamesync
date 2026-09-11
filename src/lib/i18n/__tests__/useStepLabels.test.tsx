import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeT,
  renderWithI18n,
  useT,
  useStepLabels,
  resolveSubStep,
  type Locale,
} from "@/lib/i18n";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { StepIndicator } from "@/components/sync/StepIndicator";
import type { StepStatus, SyncStep } from "@/lib/types";

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
const saveLocaleMock = vi.fn<(locale: string) => Promise<void>>(async () => {});
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: (locale: string) => saveLocaleMock(locale),
  loadLocale: async () => null,
}));

const ALL_PENDING: Record<SyncStep, StepStatus> = {
  closeUe: "pending",
  closeExcel: "pending",
  cleanDevDir: "pending",
  p4Sync: "pending",
  genProject: "pending",
};

function LabelProbe({
  step,
  subStep,
  params,
}: {
  step: string;
  subStep?: string | null;
  params?: { cl?: string };
}) {
  const label = useStepLabels();
  return <span data-testid="label">{label(step, subStep, params)}</span>;
}

function GitPullFourWay() {
  const label = useStepLabels();
  return (
    <div>
      <span data-testid="run">{label("gitPull", "run")}</span>
      <span data-testid="stash">{label("gitPull", "stash")}</span>
      <span data-testid="preNetwork">{label("gitPull", "preNetwork")}</span>
      <span data-testid="restoreStash">{label("gitPull", "restoreStash")}</span>
    </div>
  );
}

function ChipLocaleHarness({
  statuses,
  targetCl = "",
}: {
  statuses: Record<SyncStep, StepStatus>;
  targetCl?: string;
}) {
  const { setLocale } = useT();
  return (
    <div>
      <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
        zh
      </button>
      <StepIndicator stepStatuses={statuses} targetCl={targetCl} />
    </div>
  );
}

function TypeProbe() {
  const labels = useStepLabels();
  return <span data-testid="type">{typeof labels}</span>;
}

function readLabel(
  step: string,
  subStep?: string | null,
  params?: { cl?: string },
  locale: Locale = "en",
): string {
  cleanup();
  const view = renderWithI18n(
    <LabelProbe step={step} subStep={subStep} params={params} />,
    { locale },
  );
  return view.getByTestId("label").textContent ?? "";
}

describe("useStepLabels lookup", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveLocaleMock.mockClear();
  });

  it("returns a callback, not a Record", () => {
    renderWithI18n(<TypeProbe />);
    expect(screen.getByTestId("type").textContent).toBe("function");
  });

  it('("closeUe","check") equals makeT("en")("steps.closeUe.check") and zh counterpart', () => {
    expect(readLabel("closeUe", "check")).toBe(makeT("en")("steps.closeUe.check"));
    expect(readLabel("closeUe", "check", undefined, "zh")).toBe(
      makeT("zh")("steps.closeUe.check"),
    );
  });

  it("gitPull 4-way inequality in both locales (WIRE-01)", () => {
    for (const locale of ["en", "zh"] as const) {
      cleanup();
      const t = makeT(locale);
      const view = renderWithI18n(<GitPullFourWay />, { locale });
      const run = view.getByTestId("run").textContent;
      const stash = view.getByTestId("stash").textContent;
      const preNetwork = view.getByTestId("preNetwork").textContent;
      const restoreStash = view.getByTestId("restoreStash").textContent;
      expect(stash).not.toBe(run);
      expect(preNetwork).not.toBe(run);
      expect(preNetwork).not.toBe(stash);
      expect(restoreStash).not.toBe(run);
      expect(restoreStash).not.toBe(stash);
      expect(restoreStash).not.toBe(preNetwork);
      expect(run).toBe(t("steps.gitPull.run"));
      expect(stash).toBe(t("steps.gitPull.stash"));
      expect(preNetwork).toBe(t("steps.gitPull.preNetwork"));
      expect(restoreStash).toBe(t("steps.gitPull.restoreStash"));
    }
  });

  it('unknown pair ("nope","nah") equals steps.unknown and does not throw', () => {
    expect(() => readLabel("nope", "nah")).not.toThrow();
    expect(readLabel("nope", "nah")).toBe(makeT("en")("steps.unknown"));
    expect(readLabel("nope", "nah", undefined, "zh")).toBe(makeT("zh")("steps.unknown"));
  });

  it("missing/null subStep on closeUe uses D-03 canonical check", () => {
    expect(resolveSubStep("closeUe", null, "")).toBe("check");
    expect(readLabel("closeUe", resolveSubStep("closeUe", null, ""))).toBe(
      makeT("en")("steps.closeUe.check"),
    );
  });

  it("resolveSubStep p4Sync branches on targetCl (D-03)", () => {
    expect(resolveSubStep("p4Sync", null, "")).toBe("all");
    expect(resolveSubStep("p4Sync", null, "310771")).toBe("toCl");
  });

  it("p4Sync toCl interpolates {cl}; empty cl falls back to all", () => {
    expect(readLabel("p4Sync", "toCl", { cl: "310771" })).toBe(
      makeT("en")("steps.p4Sync.toCl", { cl: "310771" }),
    );
    expect(readLabel("p4Sync", "toCl", {})).toBe(makeT("en")("steps.p4Sync.all"));
    expect(readLabel("p4Sync", "toCl", {})).not.toMatch(/\{cl\}/);
  });

  it("gitPull missing subStep is unknown, not a guessed run", () => {
    expect(resolveSubStep("gitPull", null, "")).toBeUndefined();
    expect(readLabel("gitPull", resolveSubStep("gitPull", null, ""))).toBe(
      makeT("en")("steps.unknown"),
    );
    expect(readLabel("gitPull", resolveSubStep("gitPull", null, ""))).not.toBe(
      makeT("en")("steps.gitPull.run"),
    );
  });
});

describe("StepIndicator dictionary chips", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveLocaleMock.mockClear();
  });

  it("all-pending targetCl empty shows five canonical en chips; setLocale zh flips all five without remounting statuses", () => {
    const tEn = makeT("en");
    const tZh = makeT("zh");
    renderWithI18n(
      <ChipLocaleHarness statuses={ALL_PENDING} targetCl="" />,
    );
    expect(screen.getByText(tEn("steps.closeUe.check"))).toBeDefined();
    expect(screen.getByText(tEn("steps.closeExcel.check"))).toBeDefined();
    expect(screen.getByText(tEn("steps.cleanDevDir.clean"))).toBeDefined();
    expect(screen.getByText(tEn("steps.p4Sync.all"))).toBeDefined();
    expect(screen.getByText(tEn("steps.genProject.gen"))).toBeDefined();

    fireEvent.click(screen.getByTestId("switch-zh"));

    expect(screen.getByText(tZh("steps.closeUe.check"))).toBeDefined();
    expect(screen.getByText(tZh("steps.closeExcel.check"))).toBeDefined();
    expect(screen.getByText(tZh("steps.cleanDevDir.clean"))).toBeDefined();
    expect(screen.getByText(tZh("steps.p4Sync.all"))).toBeDefined();
    expect(screen.getByText(tZh("steps.genProject.gen"))).toBeDefined();
    expect(screen.queryByText(tEn("steps.closeUe.check"))).toBeNull();
  });

  it("active p4Sync chip with targetCl=310771 interpolates D-04 {cl}", () => {
    // Phase 26 (26-02): the LIVE toCl composition renders exactly once per
    // surface — in RunningPanel the header owns it, so the rail's non-active
    // steps carry their static canonical labels. The {cl} interpolation
    // machinery is unchanged; this pins it through the production shape:
    // the ACTIVE p4Sync step resolving its real machine sub-step "toCl".
    renderWithI18n(
      <StepIndicator
        stepStatuses={{ ...ALL_PENDING, p4Sync: "active" }}
        currentStep="p4Sync"
        currentSubStep="toCl"
        targetCl="310771"
      />,
    );
    expect(
      screen.getByText(makeT("en")("steps.p4Sync.toCl", { cl: "310771" })),
    ).toBeDefined();
  });

  it("active closeUe chip has no 10px diagnostics subtitle", () => {
    renderWithI18n(
      <StepIndicator
        stepStatuses={{ ...ALL_PENDING, closeUe: "active" }}
        currentStep="closeUe"
        currentSubStep="check"
        targetCl=""
      />,
    );
    expect(screen.queryByText("Checking for UE Editor")).toBeNull();
  });
});
