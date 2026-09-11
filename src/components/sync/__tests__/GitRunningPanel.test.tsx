import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { GitRunningPanel } from "@/components/sync/GitRunningPanel";
import type { GitProgressState } from "@/lib/gitProgress";
import { makeT, renderWithI18n, useT } from "@/lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
// react-virtuoso cannot measure in jsdom (documented Phase 14 blind spot —
// same mock as LogViewer.test.tsx): render itemContent rows directly so the
// raw git line asserts are meaningful at the itemContent level.
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
  gitState: "running" as const,
  logLines: [] as string[],
  errorInfo: null,
  onCancel: () => {},
  onBack: () => {},
};

// Phase 15 (WR-01 fix): the git progress bar label must reflect the ACTUAL
// git phase carried on the wire (Compressing/Receiving/Resolving), not a
// hardcoded "Receiving objects". The backend now sends phase as a canonical
// label string; this test pins the end-to-end render through GitRunningPanel.
// Wrapped in renderWithI18n because the panel calls useStepLabels even in
// determinate mode (WIRE-01 / Pitfall 3).

describe("GitRunningPanel phase label (WR-01 fix)", () => {
  it("renders the Resolving deltas label when phase is Resolving deltas", () => {
    const gitProgress: GitProgressState = {
      percent: 30,
      phase: "Resolving deltas",
      ts: 0,
    };
    renderWithI18n(<GitRunningPanel {...baseProps} gitProgress={gitProgress} />);
    expect(screen.getByText("Resolving deltas 30%")).toBeDefined();
    // NOT the stale default.
    expect(screen.queryByText(/Receiving objects/)).toBeNull();
  });

  it("renders the Compressing objects label when phase is Compressing objects", () => {
    const gitProgress: GitProgressState = {
      percent: 45,
      phase: "Compressing objects",
      ts: 0,
    };
    renderWithI18n(<GitRunningPanel {...baseProps} gitProgress={gitProgress} />);
    expect(screen.getByText("Compressing objects 45%")).toBeDefined();
  });

  it("falls back to Receiving objects when phase is null (p4Sync-style event)", () => {
    // Defensive: a Progress event with no phase (e.g. p4Sync bleed-through)
    // still renders a sensible default rather than empty/undefined.
    const gitProgress: GitProgressState = {
      percent: 67,
      phase: null,
      ts: 0,
    };
    renderWithI18n(<GitRunningPanel {...baseProps} gitProgress={gitProgress} />);
    expect(screen.getByText("Receiving objects 67%")).toBeDefined();
  });
});

describe("GitRunningPanel gitPull dictionary labels (WIRE-01)", () => {
  it("renders steps.gitPull.stash on the indeterminate line", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitCurrentStep="gitPull"
        gitCurrentSubStep="stash"
        gitProgress={null}
      />,
    );
    expect(screen.getByText(t("steps.gitPull.stash"))).toBeDefined();
  });

  it("renders steps.gitPull.run and not the stash string", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitCurrentStep="gitPull"
        gitCurrentSubStep="run"
        gitProgress={null}
      />,
    );
    expect(screen.getByText(t("steps.gitPull.run"))).toBeDefined();
    expect(screen.queryByText(t("steps.gitPull.stash"))).toBeNull();
  });

  it("preNetwork and restoreStash match dictionary; all four gitPull labels are pairwise unequal", () => {
    const t = makeT("en");
    const labels = {
      stash: t("steps.gitPull.stash"),
      run: t("steps.gitPull.run"),
      preNetwork: t("steps.gitPull.preNetwork"),
      restoreStash: t("steps.gitPull.restoreStash"),
    };
    const values = Object.values(labels);
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(values[i]).not.toBe(values[j]);
      }
    }

    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitCurrentStep="gitPull"
        gitCurrentSubStep="preNetwork"
        gitProgress={null}
      />,
    );
    expect(screen.getByText(labels.preNetwork)).toBeDefined();

    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitCurrentStep="gitPull"
        gitCurrentSubStep="restoreStash"
        gitProgress={null}
      />,
    );
    expect(screen.getByText(labels.restoreStash)).toBeDefined();
  });

  it("gitPull with missing/null subStep shows steps.unknown", () => {
    const tEn = makeT("en");
    const tZh = makeT("zh");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitCurrentStep="gitPull"
        gitCurrentSubStep={null}
        gitProgress={null}
      />,
      { locale: "zh" },
    );
    // zh pins the lookup (en "Working…" collides with the leftover dual-source fallback)
    expect(screen.getByText(tZh("steps.unknown"))).toBeDefined();
    expect(screen.queryByText(tEn("steps.gitPull.run"))).toBeNull();
    expect(screen.queryByText(tZh("steps.gitPull.run"))).toBeNull();
  });

  it("genProject/gen uses the shared steps.genProject.gen key", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitCurrentStep="genProject"
        gitCurrentSubStep="gen"
        gitProgress={null}
      />,
    );
    expect(screen.getByText(t("steps.genProject.gen"))).toBeDefined();
  });

  it("setLocale zh re-labels stash without remounting gitProgress", () => {
    const gitProgress: GitProgressState | null = null;
    function Harness() {
      const { setLocale } = useT();
      return (
        <div>
          <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
            zh
          </button>
          <GitRunningPanel
            {...baseProps}
            gitCurrentStep="gitPull"
            gitCurrentSubStep="stash"
            gitProgress={gitProgress}
          />
        </div>
      );
    }
    const tEn = makeT("en");
    renderWithI18n(<Harness />);
    expect(screen.getByText(tEn("steps.gitPull.stash"))).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    const tZh = makeT("zh");
    expect(screen.getByText(tZh("steps.gitPull.stash"))).toBeDefined();
    expect(screen.queryByText(tEn("steps.gitPull.stash"))).toBeNull();
  });
});

// SWEEP-01 (Plan 05 Task 2): banner / Back / Cancel chrome dictionary-driven.
// labelForPhase output (Receiving/Compressing/Resolving) stays English in both
// locales (BND-01) — the WR-01 describe above pins that and stays unchanged.
describe("GitRunningPanel chrome (SWEEP-01)", () => {
  it("success banner shows sync.git.success + sync.git.back", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel {...baseProps} gitState="success" />,
    );
    expect(screen.getByText(t("sync.git.success"))).toBeDefined();
    expect(screen.getByRole("button", { name: t("sync.git.back") })).toBeDefined();
  });

  it("error banner shows sync.git.failed chrome + raw error as separate sibling node", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="error"
        errorInfo={{ error: "fatal: not a git repository" }}
      />,
    );
    expect(screen.getByText(t("sync.git.failed"))).toBeDefined();
    // Raw payload is a SIBLING node (Pitfall 10) — visible, never glued into
    // the translated chrome span.
    expect(screen.getByText("fatal: not a git repository")).toBeDefined();
    // The old glued form must not reappear.
    expect(
      screen.queryByText("Git pull failed: fatal: not a git repository"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: t("sync.git.back") })).toBeDefined();
  });

  it("error banner with null errorInfo shows sync.git.unknownError sibling", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel {...baseProps} gitState="error" errorInfo={null} />,
    );
    expect(screen.getByText(t("sync.git.failed"))).toBeDefined();
    expect(screen.getByText(t("sync.git.unknownError"))).toBeDefined();
  });

  it("running state shows sync.git.cancel button", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel {...baseProps} gitState="running" gitProgress={null} />,
    );
    expect(screen.getByRole("button", { name: t("sync.git.cancel") })).toBeDefined();
  });

  it("zh smoke: success banner equals sync.git.success", () => {
    const tZh = makeT("zh");
    renderWithI18n(
      <GitRunningPanel {...baseProps} gitState="success" />,
      { locale: "zh" },
    );
    expect(screen.getByText(tZh("sync.git.success"))).toBeDefined();
    // English chrome must not render under the zh pin.
    expect(screen.queryByText(makeT("en")("sync.git.success"))).toBeNull();
  });
});

// Phase 26 (26-03 Task 2): canonical Git running/success/error surfaces
// (UI-SPEC §9) — typed running header with Git chip and live raw
// branch/remote/hash context, phase-aware contained progress, typed Git
// output log card, terminal header cards with Back-to-Idle-only semantics.
describe("GitRunningPanel canonical surfaces (26-03)", () => {
  it("percent=62 renders the determinate bar with the raw phase label composition and the real percent", () => {
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitProgress={{ percent: 62, phase: "Receiving objects", ts: 0 }}
      />,
    );
    expect(screen.getByText("Receiving objects 62%")).toBeDefined();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
  });

  it("missing percent renders indeterminate with the machine-key label and the latest raw log line as detail", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitProgress={null}
        gitCurrentStep="gitPull"
        gitCurrentSubStep="stash"
        logLines={["Counting objects: 5, done.", "Enumerating objects: 12, done."]}
      />,
    );
    expect(screen.getByText(t("steps.gitPull.stash"))).toBeDefined();
    // The latest raw log line rides BOTH the indeterminate detail line and
    // the log body below — one machine value, two presentation sites.
    expect(screen.getAllByText("Enumerating objects: 12, done.")).toHaveLength(2);
    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("terminal states expose exactly one Back-to-Idle each; Cancel renders only while running; no Start/Retry/Restart action exists", () => {
    const t = makeT("en");
    const onBack = vi.fn();
    const { unmount } = renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="success"
        onBack={onBack}
        logLines={["raw git output line"]}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t("sync.git.back") }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: t("sync.git.cancel") }),
    ).toBeNull();
    unmount();

    const errorRender = renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="error"
        onBack={onBack}
        errorInfo={{ error: "fatal: boom" }}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t("sync.git.back") }));
    expect(onBack).toHaveBeenCalledTimes(2);
    errorRender.unmount();

    renderWithI18n(
      <GitRunningPanel {...baseProps} gitState="running" gitProgress={null} />,
    );
    expect(
      screen.getByRole("button", { name: t("sync.git.cancel") }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: t("sync.git.back") }),
    ).toBeNull();
    // GIT-01: no P4 recovery action or label ever renders on a Git surface.
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/start sync|retry step|restart sync/i);
    expect(text).not.toContain(t("sync.error.retry"));
    expect(text).not.toContain(t("sync.error.restart"));
    expect(text).not.toContain(t("sync.start"));
  });

  it("raw git error renders as a sibling mono wrap-anywhere block; the typed unknown-error key covers a null payload", () => {
    const t = makeT("en");
    const { unmount } = renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="error"
        errorInfo={{ error: "fatal: not a git repository" }}
      />,
    );
    const raw = screen.getByText("fatal: not a git repository");
    expect(raw.className).toContain("font-mono");
    expect(raw.className).toContain("[overflow-wrap:anywhere]");
    unmount();

    renderWithI18n(
      <GitRunningPanel {...baseProps} gitState="error" errorInfo={null} />,
    );
    expect(screen.getByText(t("sync.git.unknownError"))).toBeDefined();
  });

  it("relabeling the locale re-renders terminal chrome from the dictionary with raw values unchanged", () => {
    function Harness() {
      const { setLocale } = useT();
      return (
        <div>
          <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
            zh
          </button>
          <GitRunningPanel
            {...baseProps}
            gitState="success"
            logLines={["raw git line stays raw"]}
          />
        </div>
      );
    }
    const tEn = makeT("en");
    const tZh = makeT("zh");
    renderWithI18n(<Harness />);
    expect(screen.getByText(tEn("sync.git.success"))).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    expect(screen.getByText(tZh("sync.git.success"))).toBeDefined();
    expect(screen.queryByText(tEn("sync.git.success"))).toBeNull();
    expect(screen.getByText("raw git line stays raw")).toBeDefined();
  });
});

describe("GitRunningPanel canonical running header and log card (26-03)", () => {
  it("running renders the typed running title, Git chip, and the semantic Cancel Pull", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel {...baseProps} gitState="running" gitProgress={null} />,
    );
    expect(screen.getByText(t("sync.git.runningTitle"))).toBeDefined();
    expect(screen.getByText(t("sync.badge.git"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("sync.git.cancel") }),
    ).toBeDefined();
  });

  it("running threads the live raw branch/remote/short-hash context from gitBranchInfo", () => {
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="running"
        gitProgress={null}
        gitBranchInfo={{
          branch: "UE5.7.1",
          ahead: 0,
          behind: 3,
          remote: "origin",
          short_hash: "99ba6d897051",
          is_detached: false,
        }}
      />,
    );
    expect(screen.getByText("UE5.7.1")).toBeDefined();
    expect(screen.getByText("origin")).toBeDefined();
    expect(screen.getByText("99ba6d897051")).toBeDefined();
  });

  it("running shows typed checking chrome while loading and typed unavailable chrome when null", () => {
    const t = makeT("en");
    const { unmount } = renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="running"
        gitProgress={null}
        gitBranchLoading={true}
      />,
    );
    expect(screen.getByText(t("sync.git.checking"))).toBeDefined();
    unmount();

    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="running"
        gitProgress={null}
        gitBranchInfo={null}
      />,
    );
    expect(screen.getByText(t("sync.git.empty"))).toBeDefined();
  });

  it("renders the raw output in the canonical log card with the typed Git output title", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="running"
        gitProgress={null}
        logLines={["Saving local changes…"]}
      />,
    );
    expect(screen.getByText(t("sync.git.logTitle"))).toBeDefined();
    // The only log line also rides the indeterminate detail — two sites.
    expect(screen.getAllByText("Saving local changes…")).toHaveLength(2);
  });

  it("terminal states preserve the raw output in the log card", () => {
    const t = makeT("en");
    renderWithI18n(
      <GitRunningPanel
        {...baseProps}
        gitState="success"
        logLines={["terminal raw line"]}
      />,
    );
    expect(screen.getByText(t("sync.git.logTitle"))).toBeDefined();
    expect(screen.getByText("terminal raw line")).toBeDefined();
  });
});
