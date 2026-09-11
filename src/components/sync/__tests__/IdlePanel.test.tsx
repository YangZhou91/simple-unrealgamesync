import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { screen, fireEvent } from "@testing-library/react";
import { IdlePanel } from "@/components/sync/IdlePanel";
import { makeT, renderWithI18n, useT, formatTimestamp } from "@/lib/i18n";
import type {
  GitBranchInfo,
  LastSyncResult,
  P4BehindInfo,
  WarningEntry,
} from "@/lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

const baseProps = {
  lastSyncResult: null as LastSyncResult | null,
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

const gitBranch: GitBranchInfo = {
  branch: "UE5.7_CBT2_Dev",
  ahead: 0,
  behind: 0,
  remote: "origin/UE5.7_CBT2_Dev",
  short_hash: "a1b2c3d",
  is_detached: false,
};

function CancelledLocaleHarness({ result }: { result: LastSyncResult }) {
  const { setLocale } = useT();
  return (
    <div>
      <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
        zh
      </button>
      <IdlePanel {...baseProps} lastSyncResult={result} />
    </div>
  );
}

// Stateful harness: holds targetCl in React state so fireEvent.change on the
// panel's input actually updates the prop (baseProps.onTargetClChange is a
// no-op). Also carries the zh switch button for lookup-at-render asserts.
function TypingLocaleHarness({ initialCl = "" }: { initialCl?: string }) {
  const { setLocale } = useT();
  const [cl, setCl] = useState(initialCl);
  return (
    <div>
      <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
        zh
      </button>
      <IdlePanel {...baseProps} targetCl={cl} onTargetClChange={setCl} />
    </div>
  );
}

describe("IdlePanel CL input", () => {
  it("shows CL input with Target CL label", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    expect(screen.getByText(t("sync.targetCl"))).toBeDefined();
    expect(
      screen.getByPlaceholderText(t("sync.targetCl.placeholder")),
    ).toBeDefined();
  });

  it("shows validation error for non-numeric CL input", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText(t("sync.targetCl.placeholder"));
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText(t("sync.targetCl.error"))).toBeDefined();
  });

  it("disables Start Sync button when CL validation fails", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText(t("sync.targetCl.placeholder"));
    fireEvent.change(input, { target: { value: "abc" } });
    expect(
      (screen.getByRole("button", { name: t("sync.start") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("accepts numeric CL input without error", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText(t("sync.targetCl.placeholder"));
    fireEvent.change(input, { target: { value: "12345" } });
    expect(screen.queryByText(t("sync.targetCl.error"))).toBeNull();
    expect(
      (screen.getByRole("button", { name: t("sync.start") }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("clears error when input becomes valid", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    const input = screen.getByPlaceholderText(t("sync.targetCl.placeholder"));
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText(t("sync.targetCl.error"))).toBeDefined();
    fireEvent.change(input, { target: { value: "12345" } });
    expect(screen.queryByText(t("sync.targetCl.error"))).toBeNull();
  });

  it("hides engine checkbox when CL is invalid and shows it for valid CL", () => {
    const t = makeT("en");
    renderWithI18n(<TypingLocaleHarness />);
    const input = screen.getByPlaceholderText(t("sync.targetCl.placeholder"));
    // invalid CL → error present, engine row hidden
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText(t("sync.targetCl.error"))).toBeDefined();
    expect(screen.queryByText(t("sync.engine.checkbox"))).toBeNull();
    // valid non-empty CL → engine checkbox visible
    fireEvent.change(input, { target: { value: "12345" } });
    expect(screen.getByText(t("sync.engine.checkbox"))).toBeDefined();
  });

  it("re-renders CL error in zh after locale switch without re-typing", () => {
    renderWithI18n(<TypingLocaleHarness initialCl="" />);
    const t = makeT("en");
    const input = screen.getByPlaceholderText(t("sync.targetCl.placeholder"));
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText(t("sync.targetCl.error"))).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    const tZh = makeT("zh");
    expect(screen.getByText(tZh("sync.targetCl.error"))).toBeDefined();
    expect(screen.queryByText(t("sync.targetCl.error"))).toBeNull();
  });

  // Phase 26 (26-01) — SYNC-01 blank-target guidance: blank means HEAD; the
  // typed headHint renders and no numeric CL is fabricated.
  it("shows typed HEAD guidance for a blank target (SYNC-01)", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} targetCl="" />);
    expect(screen.getByText(t("sync.targetCl.headHint"))).toBeDefined();
  });

  it("flips target guidance to the toCl template for a valid numeric CL", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} targetCl="12345" />);
    expect(
      screen.getByText(t("steps.p4Sync.toCl", { cl: "12345" })),
    ).toBeDefined();
    expect(screen.queryByText(t("sync.targetCl.headHint"))).toBeNull();
  });

  it("hides all target guidance for an invalid target — alert only", () => {
    const t = makeT("en");
    renderWithI18n(<TypingLocaleHarness initialCl="" />);
    const input = screen.getByPlaceholderText(t("sync.targetCl.placeholder"));
    fireEvent.change(input, { target: { value: "wrong" } });
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.queryByText(t("sync.targetCl.headHint"))).toBeNull();
    expect(
      screen.queryByText(t("steps.p4Sync.toCl", { cl: "wrong" })),
    ).toBeNull();
  });

  it("exposes numeric inputMode on the target input", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    expect(
      screen
        .getByPlaceholderText(t("sync.targetCl.placeholder"))
        .getAttribute("inputmode"),
    ).toBe("numeric");
  });
});

describe("IdlePanel behind banner (two keys, no plural API)", () => {
  it("renders behind=1 via sync.behind.one", () => {
    const t = makeT("en");
    const behindInfo: P4BehindInfo = { behind: 1 };
    renderWithI18n(<IdlePanel {...baseProps} behindInfo={behindInfo} />);
    expect(
      screen.getByText(t("sync.behind.one", { n: 1 })),
    ).toBeDefined();
    expect(
      screen.queryByText(t("sync.behind.other", { n: 1 })),
    ).toBeNull();
  });

  it("renders behind=3 via sync.behind.other", () => {
    const t = makeT("en");
    const behindInfo: P4BehindInfo = { behind: 3 };
    renderWithI18n(<IdlePanel {...baseProps} behindInfo={behindInfo} />);
    expect(
      screen.getByText(t("sync.behind.other", { n: 3 })),
    ).toBeDefined();
    expect(
      screen.queryByText(t("sync.behind.one", { n: 3 })),
    ).toBeNull();
  });

  it("renders behind=0 with uptodate + badgeUpToDate", () => {
    const t = makeT("en");
    const behindInfo: P4BehindInfo = { behind: 0 };
    renderWithI18n(<IdlePanel {...baseProps} behindInfo={behindInfo} />);
    expect(screen.getByText(t("sync.behind.uptodate"))).toBeDefined();
    expect(screen.getByText(t("sync.behind.badgeUpToDate"))).toBeDefined();
  });

  it("renders badge Behind {n} when behind >= 1", () => {
    const t = makeT("en");
    const behindInfo: P4BehindInfo = { behind: 2 };
    renderWithI18n(<IdlePanel {...baseProps} behindInfo={behindInfo} />);
    expect(screen.getByText(t("sync.behind.badge", { n: 2 }))).toBeDefined();
  });

  it("renders checking state and hides badge while loading", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        behindInfo={{ behind: 5 }}
        behindLoading={true}
      />,
    );
    expect(screen.getByText(t("sync.behind.checking"))).toBeDefined();
    expect(screen.queryByText(t("sync.behind.badge", { n: 5 }))).toBeNull();
  });

  it("renders choose hint and hides badge when behindInfo is null", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} behindInfo={null} />);
    expect(screen.getByText(t("sync.behind.choose"))).toBeDefined();
    expect(screen.queryByText(t("sync.behind.badgeUpToDate"))).toBeNull();
  });

  // Phase 26 (26-01): the standalone Ready-to-sync strip is gone — the
  // canonical P4 card h2 heading is the idle marker (same key the interaction
  // script now asserts).
  it("renders canonical P4 card heading from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    expect(
      screen.getByRole("heading", { name: t("sync.p4.cardTitle") }),
    ).toBeDefined();
    expect(screen.queryByText(t("sync.idle.ready"))).toBeNull();
  });
});

describe("IdlePanel P4 card chrome", () => {
  it("renders card title, hint, and P4 badge from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    expect(screen.getByText(t("sync.p4.cardTitle"))).toBeDefined();
    expect(screen.getByText(t("sync.p4.cardHint"))).toBeDefined();
    expect(screen.getByText(t("sync.badge.p4"))).toBeDefined();
  });

  it("renders engine hints from dictionary for a valid CL", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel {...baseProps} targetCl="12345" syncEngine={false} />,
    );
    expect(screen.getByText(t("sync.engine.checkbox"))).toBeDefined();
    expect(screen.getByText(t("sync.engine.hintOff"))).toBeDefined();
  });

  it("renders engine hintOn when syncEngine enabled", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel {...baseProps} targetCl="12345" syncEngine={true} />,
    );
    expect(screen.getByText(t("sync.engine.hintOn"))).toBeDefined();
  });

  it("renders Start Sync button from dictionary (zh smoke)", () => {
    const tZh = makeT("zh");
    renderWithI18n(<IdlePanel {...baseProps} />, { locale: "zh" });
    expect(
      screen.getByRole("button", { name: tZh("sync.start") }),
    ).toBeDefined();
  });
});

describe("IdlePanel canonical idle surface (Phase 26)", () => {
  it("renders the P4 footer current-CL label with the live raw CL", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} currentCl="381515" />);
    expect(screen.getByText(t("sync.p4.currentCl"))).toBeDefined();
    expect(screen.getByText("381515")).toBeDefined();
  });

  it("hides the footer CL value when currentCl is null (no fabricated CL)", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} currentCl={null} />);
    expect(screen.getByText(t("sync.p4.currentCl"))).toBeDefined();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("renders the closed five-step disclosure with render-time labels in STEP_ORDER", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    const summary = screen.getByText(t("sync.pipeline.details"));
    expect(summary.tagName).toBe("SUMMARY");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    // The five real labels derive from STEP_ORDER at render (blank target →
    // the p4Sync step renders its canonical `all` variant here; the live
    // toCl guidance belongs to the target hint alone).
    expect(screen.getByText(t("steps.closeUe.check"))).toBeDefined();
    expect(screen.getByText(t("steps.closeExcel.check"))).toBeDefined();
    expect(screen.getByText(t("steps.cleanDevDir.clean"))).toBeDefined();
    expect(screen.getByText(t("steps.p4Sync.all"))).toBeDefined();
    expect(screen.getByText(t("steps.genProject.gen"))).toBeDefined();
  });

  // Canonical vertical order (UI-SPEC §6): P4 card heading, then Git row
  // heading, then the pipeline disclosure — DOM order proves the sequence.
  it("renders the canonical vertical order: P4 card, Git row, pipeline disclosure", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    const p4Heading = screen.getByRole("heading", { name: t("sync.p4.cardTitle") });
    const gitHeading = screen.getByRole("heading", { name: t("sync.git.cardTitle") });
    const pipeline = screen.getByText(t("sync.pipeline.details"));
    expect(
      p4Heading.compareDocumentPosition(gitHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      gitHeading.compareDocumentPosition(pipeline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the result card after the pipeline disclosure when lastSyncResult exists", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={{
          status: "completed",
          cl: "12345",
          fileCount: 42,
          epochMs: 0,
        }}
      />,
    );
    const pipeline = screen.getByText(t("sync.pipeline.details"));
    const resultTitle = screen.getByText(t("sync.last.title"));
    expect(
      pipeline.compareDocumentPosition(resultTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the pipeline p4Sync label static even with a typed target CL", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} targetCl="12345" />);
    expect(screen.getByText(t("steps.p4Sync.all"))).toBeDefined();
  });
});

describe("IdlePanel Git card chrome", () => {
  it("renders card title, hint, and Git badge from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    expect(screen.getByText(t("sync.git.cardTitle"))).toBeDefined();
    expect(screen.getByText(t("sync.git.cardHint"))).toBeDefined();
    expect(screen.getByText(t("sync.badge.git"))).toBeDefined();
  });

  it("renders checking state from dictionary", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} gitBranchLoading={true} />);
    expect(screen.getByText(t("sync.git.checking"))).toBeDefined();
  });

  it("renders empty state from dictionary when no branch", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel {...baseProps} gitBranchInfo={{ ...gitBranch, branch: "" }} />,
    );
    expect(screen.getByText(t("sync.git.empty"))).toBeDefined();
  });

  // Phase 26 (26-01): branch/hash/status render inline as the canonical Git
  // metadata line; the Remote dt label lives inside the repository-details
  // disclosure (dt.branch/dt.status are no longer rendered labels — the raw
  // branch and status values themselves are asserted below and above).
  it("renders Remote dt plus raw branch/hash/status from live metadata", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} gitBranchInfo={gitBranch} />);
    expect(screen.getByText(t("sync.git.dt.remote"))).toBeDefined();
    // raw values BND-01 (hash renders with its muted separator glyph)
    expect(screen.getByText(gitBranch.branch)).toBeDefined();
    expect(screen.getByText(gitBranch.remote)).toBeDefined();
    expect(screen.getByText(`· ${gitBranch.short_hash}`)).toBeDefined();
    // repository-details disclosure exposes the remote metadata
    expect(screen.getByText(t("sync.git.details"))).toBeDefined();
  });

  it("hides the repository-details disclosure when no branch exists", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} gitBranchInfo={null} />);
    expect(screen.queryByText(t("sync.git.details"))).toBeNull();
  });

  it("renders empty remote as em-dash, not a key", () => {
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        gitBranchInfo={{ ...gitBranch, remote: "" }}
      />,
    );
    expect(screen.getByText("—")).toBeDefined();
  });

  it("renders status behind via sync.git.status.behind", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel {...baseProps} gitBranchInfo={{ ...gitBranch, behind: 4 }} />,
    );
    expect(
      screen.getByText(t("sync.git.status.behind", { n: 4 })),
    ).toBeDefined();
  });

  it("renders detached chrome with detachedParen and Detached HEAD status", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        gitBranchInfo={{ ...gitBranch, is_detached: true }}
      />,
    );
    expect(screen.getByText(t("sync.git.detachedParen"))).toBeDefined();
    expect(screen.getByText(t("sync.git.status.detached"))).toBeDefined();
    // raw branch text (HEAD) is not shown when detached
    expect(screen.queryByText(gitBranch.branch)).toBeNull();
  });

  it("renders uptodate status when ahead of nothing", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} gitBranchInfo={gitBranch} />);
    expect(screen.getByText(t("sync.git.status.uptodate"))).toBeDefined();
  });

  it("zh smoke: Git Pull button equals sync.git.pull", () => {
    const tZh = makeT("zh");
    renderWithI18n(<IdlePanel {...baseProps} />, { locale: "zh" });
    expect(
      screen.getByRole("button", { name: tZh("sync.git.pull") }),
    ).toBeDefined();
  });

  it("Git Pull button equals sync.git.pull in en", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} />);
    expect(
      screen.getByRole("button", { name: t("sync.git.pull") }),
    ).toBeDefined();
  });
});

describe("IdlePanel lastSyncResult <time>", () => {
  it("renders completed <time> from epochMs via formatTimestamp", () => {
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={{
          status: "completed",
          cl: "12345",
          fileCount: 42,
          epochMs: 0,
        }}
      />,
    );
    const timeEl = screen.getByText(formatTimestamp(0, "en"));
    expect(timeEl.tagName).toBe("TIME");
  });

  it("zh smoke: completed TIME equals formatTimestamp(0, zh)", () => {
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={{
          status: "completed",
          cl: "12345",
          fileCount: 42,
          epochMs: 0,
        }}
      />,
      { locale: "zh" },
    );
    const timeEl = screen.getByText(formatTimestamp(0, "zh"));
    expect(timeEl.tagName).toBe("TIME");
  });

  it("hides last-sync TIME when lastSyncResult is omitted", () => {
    renderWithI18n(<IdlePanel {...baseProps} lastSyncResult={null} />);
    expect(document.querySelector("time")).toBeNull();
  });

  it("renders cancelled p4Sync/all as Cancelled at Syncing Files", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={{
          status: "cancelled",
          cl: null,
          fileCount: 0,
          epochMs: 0,
          step: "p4Sync",
          subStep: "all",
        }}
      />,
    );
    expect(
      screen.getByText(
        t("steps.status.cancelledAt", { step: t("steps.p4Sync.all") }),
      ),
    ).toBeDefined();
  });

  it("renders cancelled p4Sync/toCl with snapshotted cl as Cancelled at Syncing to CL 310771", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={{
          status: "cancelled",
          cl: "310771",
          fileCount: 0,
          epochMs: 0,
          step: "p4Sync",
          subStep: "toCl",
        }}
      />,
    );
    expect(
      screen.getByText(
        t("steps.status.cancelledAt", {
          step: t("steps.p4Sync.toCl", { cl: "310771" }),
        }),
      ),
    ).toBeDefined();
  });

  it("re-translates cancelled <time> on setLocale zh without remounting the result object", () => {
    const result: LastSyncResult = {
      status: "cancelled",
      cl: null,
      fileCount: 0,
      epochMs: 0,
      step: "p4Sync",
      subStep: "all",
    };
    renderWithI18n(<CancelledLocaleHarness result={result} />);
    const tEn = makeT("en");
    expect(
      screen.getByText(
        tEn("steps.status.cancelledAt", { step: tEn("steps.p4Sync.all") }),
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    const tZh = makeT("zh");
    expect(
      screen.getByText(
        tZh("steps.status.cancelledAt", { step: tZh("steps.p4Sync.all") }),
      ),
    ).toBeDefined();
  });

  it("re-translates cancelled toCl line on setLocale zh without remounting the result object", () => {
    const result: LastSyncResult = {
      status: "cancelled",
      cl: "310771",
      fileCount: 0,
      epochMs: 0,
      step: "p4Sync",
      subStep: "toCl",
    };
    renderWithI18n(<CancelledLocaleHarness result={result} />);
    const tEn = makeT("en");
    expect(
      screen.getByText(
        tEn("steps.status.cancelledAt", {
          step: tEn("steps.p4Sync.toCl", { cl: "310771" }),
        }),
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    const tZh = makeT("zh");
    expect(
      screen.getByText(
        tZh("steps.status.cancelledAt", {
          step: tZh("steps.p4Sync.toCl", { cl: "310771" }),
        }),
      ),
    ).toBeDefined();
  });

  it("renders last-sync card chrome from dictionary (title + interpolated line)", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={{
          status: "completed",
          cl: "12345",
          fileCount: 42,
          epochMs: 0,
        }}
      />,
    );
    expect(screen.getByText(t("sync.last.title"))).toBeDefined();
    expect(
      screen.getByText(t("sync.last.line", { cl: "12345", n: 42 })),
    ).toBeDefined();
  });

  it("interpolates ? for a missing CL in the last-sync line", () => {
    const t = makeT("en");
    renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={{
          status: "completed",
          cl: null,
          fileCount: 7,
          epochMs: 0,
        }}
      />,
    );
    expect(
      screen.getByText(t("sync.last.line", { cl: "?", n: 7 })),
    ).toBeDefined();
  });
});

describe("IdlePanel result and warnings card (Phase 26)", () => {
  const completed: LastSyncResult = {
    status: "completed",
    cl: "381515",
    fileCount: 8520,
    epochMs: 0,
  };
  const cancelled: LastSyncResult = {
    status: "cancelled",
    cl: null,
    fileCount: 0,
    epochMs: 0,
    step: "p4Sync",
    subStep: "all",
  };

  // Behavior Test 1 (zero-one-many): empty warnings render no summary region
  // anywhere in the idle surface.
  it("renders no summary region when warnings are empty", () => {
    const { container } = renderWithI18n(
      <IdlePanel {...baseProps} lastSyncResult={completed} lastSyncWarnings={[]} />,
    );
    expect(container.querySelector("[data-summary-root]")).toBeNull();
  });

  // Behavior Test 3 (cancelled): the new typed cancellation title plus the
  // existing cancelledAt composition with the real resolved step label — never
  // the success title, never a fabricated completion time.
  it("renders cancelledTitle with the real-step cancelledAt composition", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} lastSyncResult={cancelled} />);
    expect(screen.getByText(t("sync.result.cancelledTitle"))).toBeDefined();
    expect(screen.queryByText(t("sync.last.title"))).toBeNull();
    expect(
      screen.getByText(
        t("steps.status.cancelledAt", { step: t("steps.p4Sync.all") }),
      ),
    ).toBeDefined();
  });

  // Behavior Test 2 (completed): the latest-sync title, raw CL/file-count line,
  // and locale timestamp — cancelled chrome absent.
  it("keeps the completed card on last.title/line chrome with no cancelled title", () => {
    const t = makeT("en");
    renderWithI18n(<IdlePanel {...baseProps} lastSyncResult={completed} />);
    expect(screen.getByText(t("sync.last.title"))).toBeDefined();
    expect(
      screen.getByText(t("sync.last.line", { cl: "381515", n: 8520 })),
    ).toBeDefined();
    expect(screen.queryByText(t("sync.result.cancelledTitle"))).toBeNull();
  });

  // Behavior Test 4 (warnings): non-empty warnings render grouped severity
  // sections whose toggles are semantic buttons exposing expanded state,
  // inside a region separated from the result header by a 1px border.
  it("renders warnings in a border-separated region with grouped expandable sections", () => {
    const t = makeT("en");
    const warnings: WarningEntry[] = [
      { severity: "error", path: "//depot/e1", message: "m", count: 1 },
      { severity: "warning", path: "//depot/w1", message: "m", count: 1 },
    ];
    const { container } = renderWithI18n(
      <IdlePanel
        {...baseProps}
        lastSyncResult={completed}
        lastSyncWarnings={warnings}
      />,
    );
    const root = container.querySelector("[data-summary-root]");
    expect(root).not.toBeNull();
    expect(root?.parentElement?.className).toContain("border-t");
    const errorsToggle = screen
      .getByText(t("sync.summary.errors"))
      .closest("button")!;
    expect(errorsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("//depot/e1")).toBeDefined();
    expect(screen.getByText("//depot/w1")).toBeDefined();
  });
});
