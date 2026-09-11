import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ProgressSection } from "@/components/sync/ProgressSection";
import { makeT, renderWithI18n } from "@/lib/i18n";

// Phase 20 Plan 03 (SWEEP-01/SWEEP-04, Pitfall 3): ProgressSection is a
// locale-agnostic STRING SINK for prepLabel / indeterminateLabel /
// rawPercentLabel — omitted props render "" (never a hardcoded locale
// fallback). The one legitimate useT() is file-count chrome
// (sync.files.overrun / count / noTotal — counts are computed here).
// renderWithI18n + the two vi.mock blocks are required once the component
// calls useT (its setLocale persist-then-push imports invoke/localeSettings).
//
// Phase 26 (26-02 Task 1): the transform-string assertions are replaced by
// CONTAINED-FILL proof — the determinate indicator is a width-based fill
// (0–100% clamped, width-only transition) whose element box can never cross
// its track. The geometry ledger recorded the old full-width indicator
// repositioned by a negative transform as the root cause of every
// running/git-running known-red; these tests pin the repaired primitive.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

/** The determinate/indeterminate Indicator element. */
function indicatorEl(): HTMLElement {
  return document.querySelector(
    '[data-slot="progress-indicator"]',
  ) as HTMLElement;
}

/** The progress Root (Radix value semantics live here). */
function trackEl(): HTMLElement {
  return document.querySelector('[data-slot="progress"]') as HTMLElement;
}

/** The 25px tabular percentage number — present only with a real denominator. */
function numberEl(): HTMLElement | null {
  return document.querySelector('[data-slot="progress-number"]');
}

describe("ProgressSection contained determinate fill (26-02 Task 1)", () => {
  it("rawPercent 67 fills width 67% with zero transform", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={67}
        rawPercentLabel="Receiving objects 67%"
      />,
    );
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    // Contained fill: the width carries the value, nothing is translated.
    expect(indicator.style.width).toBe("67%");
    expect(indicator.style.transform).toBe("");
    // Width-only transition — never transition-all (mid-transition frames
    // of other properties are what the geometry ledger red-flagged).
    expect(indicator.className).toContain("transition");
    expect(indicator.className).not.toContain("transition-all");
    expect(indicator.className).not.toContain("progress-indeterminate-indicator");
  });

  it("count bar 5/10 fills width 50%", () => {
    renderWithI18n(<ProgressSection current={5} total={10} currentFile="" />);
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    expect(indicator.style.width).toBe("50%");
    expect(indicator.style.transform).toBe("");
  });

  it("value 0 mounts as a contained zero-width fill, not a translated full-width element", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={0}
        rawPercentLabel="Compressing objects 0%"
      />,
    );
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    // The old geometry offender: a w-full indicator fully repositioned left
    // of the track by a negative transform. Both halves of that signature
    // are gone.
    expect(indicator.style.width).toBe("0%");
    expect(indicator.style.transform).toBe("");
    expect(indicator.className).not.toContain("w-full");
  });

  it("value 100 fills exactly 100% without crossing the track", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={100}
        rawPercentLabel="Resolving deltas 100%"
      />,
    );
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    expect(indicator.style.width).toBe("100%");
  });

  it("out-of-range values are clamped into [0,100]", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={150}
        rawPercentLabel="overflow 150%"
      />,
    );
    expect(indicatorEl().style.width).toBe("100%");
  });

  it("Radix value semantics survive: determinate exposes aria-valuenow, indeterminate/prep fabricate none", () => {
    const { unmount } = renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={67}
        rawPercentLabel="Receiving objects 67%"
      />,
    );
    expect(trackEl().getAttribute("aria-valuenow")).toBe("67");
    expect(trackEl().getAttribute("aria-valuemax")).toBe("100");
    unmount();

    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        indeterminate={true}
        indeterminateLabel="Saving local changes…"
      />,
    );
    expect(trackEl().getAttribute("aria-valuenow")).toBeNull();
    unmount();

    renderWithI18n(
      <ProgressSection current={0} total={0} currentFile="" prep={true} />,
    );
    expect(trackEl().getAttribute("aria-valuenow")).toBeNull();
  });
});

// The 25px tabular progress number — UI-SPEC §7: show the real percentage
// when a denominator exists (count pct, byte pct with bytesTotal, rawPercent);
// render NO number for a rate-only byte signal or any denominator-less mode.
describe("ProgressSection percentage number (26-02 Task 1)", () => {
  it("count bar renders the rounded count percentage", () => {
    renderWithI18n(<ProgressSection current={5} total={10} currentFile="" />);
    const number = numberEl();
    expect(number).not.toBeNull();
    expect(number?.textContent).toBe("50%");
    expect(number?.className).toContain("tabular-nums");
  });

  it("byte-driven bar with a total renders the byte percentage", () => {
    renderWithI18n(
      <ProgressSection
        current={5}
        total={10}
        currentFile=""
        bytesDone={2_000_000_000}
        bytesTotal={8_000_000_000}
        bytesRate={45_000_000}
      />,
    );
    expect(numberEl()?.textContent).toBe("25%");
  });

  it("rawPercent renders its own number", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={67}
        rawPercentLabel="Receiving objects 67%"
      />,
    );
    expect(numberEl()?.textContent).toBe("67%");
  });

  it("rate-only byte signal (bytesTotal null) renders the byte line but NO percentage number", () => {
    renderWithI18n(
      <ProgressSection
        current={3}
        total={10}
        currentFile=""
        bytesDone={2_000_000_000}
        bytesTotal={null}
        bytesRate={45_000_000}
      />,
    );
    // The rate-only liveness line is present...
    expect(screen.getByText(/2\.0 GB/)).toBeDefined();
    // ...and no fabricated percentage number mounts.
    expect(numberEl()).toBeNull();
  });

  it("count bar without a total renders no number", () => {
    renderWithI18n(<ProgressSection current={7} total={0} currentFile="" />);
    const t = makeT("en");
    expect(screen.getByText(t("sync.files.noTotal", { current: 7 }))).toBeDefined();
    expect(numberEl()).toBeNull();
  });

  it("prep and indeterminate render no number", () => {
    const t = makeT("en");
    const { unmount } = renderWithI18n(
      <ProgressSection
        current={5}
        total={10}
        currentFile=""
        prep={true}
        prepLabel={t("sync.prep", { n: 10 })}
      />,
    );
    expect(numberEl()).toBeNull();
    unmount();

    renderWithI18n(
      <ProgressSection
        current={5}
        total={10}
        currentFile=""
        indeterminate={true}
        indeterminateLabel="Generating Project Files"
      />,
    );
    expect(numberEl()).toBeNull();
  });
});

// Phase 15 (GPULL-24 frontend / SC#5 non-regression): the rawPercent render
// branch. The determinate git bar (value=N, label="Receiving objects 67%") and
// the null-fallback (existing count bar unchanged) are both covered.
// rawPercentLabel stays an English string sink (BND-01).
describe("ProgressSection rawPercent branch (Phase 15 GPULL-24 frontend)", () => {
  // GPULL-24 gate: rawPercent present -> determinate bar labeled rawPercentLabel.
  it("renders the determinate bar + label when rawPercent is present", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={67}
        rawPercentLabel="Receiving objects 67%"
      />,
    );
    // The label text appears in the primary detail line.
    expect(screen.getByText("Receiving objects 67%")).toBeDefined();
    // The determinate fill carries the 67% width (not indeterminate).
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    expect(indicator.style.width).toBe("67%");
    expect(indicator.className).not.toContain("progress-indeterminate-indicator");
  });

  // SC#5 non-regression: rawPercent null/undefined -> the EXISTING count bar
  // renders unchanged (p4Sync path unaffected by the additive props).
  it("renders the existing count bar when rawPercent is null (SC#5 non-regression)", () => {
    const t = makeT("en");
    renderWithI18n(
      <ProgressSection
        current={5}
        total={10}
        currentFile=""
        rawPercent={null}
      />,
    );
    // Count-based fileText is the primary detail line (dictionary key since Plan 03).
    expect(
      screen.getByText(t("sync.files.count", { current: 5, total: 10 })),
    ).toBeDefined();
    // The determinate fill carries count pct = (5/10)*100 = 50%.
    expect(indicatorEl().style.width).toBe("50%");
    // rawPercentLabel absent -> not rendered.
    expect(screen.queryByText("Receiving objects 67%")).toBeNull();
  });

  // Priority gate: indeterminate wins over rawPercent (prep/indeterminate
  // priority holds — rawPercent is ignored when indeterminate).
  it("renders indeterminate when both indeterminate and rawPercent are set", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        indeterminate={true}
        indeterminateLabel="Saving local changes…"
        rawPercent={67}
        rawPercentLabel="Receiving objects 67%"
      />,
    );
    // The parent-passed indeterminate label wins as the primary line.
    expect(screen.getByText("Saving local changes…")).toBeDefined();
    // rawPercentLabel is NOT rendered (indeterminate priority).
    expect(screen.queryByText("Receiving objects 67%")).toBeNull();
    // The indeterminate Indicator class is present.
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    expect(indicator.className).toContain("progress-indeterminate-indicator");
  });

  // Priority gate: prep wins over rawPercent (prep is highest priority).
  // prepLabel is a parent-passed translated string (string sink).
  it("renders prep when both prep and rawPercent are set", () => {
    const t = makeT("en");
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        prep={true}
        prepLabel={t("sync.prep", { n: 0 })}
        rawPercent={67}
        rawPercentLabel="Receiving objects 67%"
      />,
    );
    expect(screen.getByText(t("sync.prep", { n: 0 }))).toBeDefined();
    expect(screen.queryByText("Receiving objects 67%")).toBeNull();
  });

  // rawPercent=0 is a valid determinate value (0% — git just started a phase).
  it("renders the determinate bar when rawPercent is 0 (0% is a valid percent)", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        rawPercent={0}
        rawPercentLabel="Compressing objects 0%"
      />,
    );
    expect(screen.getByText("Compressing objects 0%")).toBeDefined();
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    expect(indicator.style.width).toBe("0%");
    expect(indicator.className).not.toContain("progress-indeterminate-indicator");
  });
});

// Phase 20 Plan 03: Pitfall 3 — omitted-label defaults. prep/indeterminate
// branches must render the EMPTY STRING when the parent omits the label,
// never the deleted CJK prep fallback nor the deleted English "Working…"
// fallback. This is the negative gate that keeps the string sink honest.
describe("ProgressSection omitted-label defaults (Pitfall 3)", () => {
  it("renders empty primary line when prep is on but prepLabel is omitted (no locale fallback)", () => {
    renderWithI18n(
      <ProgressSection current={0} total={0} currentFile="" prep={true} />,
    );
    // The old CJK prep fallback must NOT appear.
    expect(screen.queryByText(makeT("zh")("sync.prep", { n: 0 }))).toBeNull();
    // The old English working fallback must NOT appear.
    expect(screen.queryByText("Working…")).toBeNull();
    // The bar itself is indeterminate (prep still drives the animation).
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    expect(indicator.className).toContain("progress-indeterminate-indicator");
  });

  it("renders empty primary line when indeterminate is on but indeterminateLabel is omitted", () => {
    renderWithI18n(
      <ProgressSection current={0} total={0} currentFile="" indeterminate={true} />,
    );
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.queryByText(makeT("zh")("sync.prep", { n: 0 }))).toBeNull();
    const indicator = indicatorEl();
    expect(indicator).not.toBeNull();
    expect(indicator.className).toContain("progress-indeterminate-indicator");
  });

  it("shows the passed-in prepLabel string when prep is on (string sink)", () => {
    const t = makeT("en");
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        prep={true}
        prepLabel={t("sync.prep", { n: 0 })}
      />,
    );
    expect(screen.getByText(t("sync.prep", { n: 0 }))).toBeDefined();
  });
});

// Phase 20 Plan 03: file-count chrome via sync.files.* dictionary keys.
// overrun -> sync.files.overrun {n}; count -> sync.files.count
// {current}/{total}; no total -> sync.files.noTotal {current}. Always-plural,
// U+2026 (the old ASCII "files..." becomes "files…" through the key).
describe("ProgressSection file-count chrome (sync.files.*)", () => {
  it("renders the count line via sync.files.count", () => {
    const t = makeT("en");
    renderWithI18n(
      <ProgressSection current={5} total={10} currentFile="" />,
    );
    expect(
      screen.getByText(t("sync.files.count", { current: 5, total: 10 })),
    ).toBeDefined();
    // The muted secondary line under a byte bar reuses the same fileText;
    // without a byte signal there is exactly one count line.
    expect(
      screen.getAllByText(t("sync.files.count", { current: 5, total: 10 })),
    ).toHaveLength(1);
  });

  it("renders the overrun line via sync.files.overrun when current >= total", () => {
    const t = makeT("en");
    renderWithI18n(
      <ProgressSection current={12} total={10} currentFile="" />,
    );
    expect(screen.getByText(t("sync.files.overrun", { n: 10 }))).toBeDefined();
  });

  it("renders the no-total line via sync.files.noTotal when total is 0", () => {
    const t = makeT("en");
    renderWithI18n(
      <ProgressSection current={7} total={0} currentFile="" />,
    );
    expect(screen.getByText(t("sync.files.noTotal", { current: 7 }))).toBeDefined();
  });

  it("secondary fileText under a byte bar uses the same sync.files.count key", () => {
    const t = makeT("en");
    renderWithI18n(
      <ProgressSection
        current={5}
        total={10}
        currentFile=""
        bytesDone={3_000_000_000}
        bytesTotal={4_000_000_000}
        bytesRate={45_000_000}
      />,
    );
    // Primary line is the byte text; the muted secondary count line is the
    // dictionary count chrome (byte bar takes precedence over count).
    const primary = screen.getByText(/GB \/ .*GB/);
    expect(primary).toBeDefined();
    expect(primary.className).toContain("text-foreground");
    expect(primary.className).not.toContain("text-xs");
    expect(
      screen.getByText(t("sync.files.count", { current: 5, total: 10 })),
    ).toBeDefined();
  });

  // I18N-05: one zh smoke — the same component renders the zh dictionary
  // values under locale zh (prep label parent-passed from makeT("zh")).
  it("zh smoke: prep label under locale zh equals makeT(zh)(sync.prep)", () => {
    const zh = makeT("zh");
    renderWithI18n(
      <ProgressSection
        current={0}
        total={164038}
        currentFile=""
        prep={true}
        prepLabel={zh("sync.prep", { n: 164038 })}
      />,
      { locale: "zh" },
    );
    expect(
      screen.getByText(zh("sync.prep", { n: 164038 })),
    ).toBeDefined();
    // en value must NOT appear under the zh pin.
    const en = makeT("en");
    expect(screen.queryByText(en("sync.prep", { n: 164038 }))).toBeNull();
  });

  // zh smoke for the file-count chrome (component-owned useT).
  it("zh smoke: count chrome under locale zh equals makeT(zh)(sync.files.count)", () => {
    const zh = makeT("zh");
    renderWithI18n(
      <ProgressSection current={5} total={10} currentFile="" />,
      { locale: "zh" },
    );
    expect(
      screen.getByText(zh("sync.files.count", { current: 5, total: 10 })),
    ).toBeDefined();
  });
});

// 26-02 Task 1: raw current-file rendering wraps (UI-SPEC §7/§12) — the raw
// value renders verbatim beneath the 1px divider with a break-anywhere class
// replacing the old truncate, so long raw paths can never overflow the card
// at 352px.
describe("ProgressSection current raw file wrapping (26-02 Task 1)", () => {
  it("renders the raw path verbatim with wrap-anywhere classes, never truncation", () => {
    const rawPath =
      "//Example_Depot/ExampleGame/Content/Characters/VeryLong/Path/SomeReallyLongAssetName.uasset";
    renderWithI18n(
      <ProgressSection current={5} total={10} currentFile={rawPath} />,
    );
    const fileLine = screen.getByText(rawPath);
    expect(fileLine).toBeDefined();
    expect(fileLine.className).toContain("break-all");
    expect(fileLine.className).not.toContain("truncate");
  });
});

// quick-260630-v26 regression: the indeterminate liveness detail (latest raw
// log line) renders verbatim below the detail line.
describe("ProgressSection indeterminate detail (liveness line)", () => {
  it("renders the parent-passed raw detail line verbatim", () => {
    renderWithI18n(
      <ProgressSection
        current={0}
        total={0}
        currentFile=""
        indeterminate={true}
        indeterminateLabel="Generating Project Files"
        indeterminateDetail="//Example_Depot/ExampleGame/Intermediate/ProjectFiles.vcxproj"
      />,
    );
    expect(
      screen.getByText("//Example_Depot/ExampleGame/Intermediate/ProjectFiles.vcxproj"),
    ).toBeDefined();
  });
});
