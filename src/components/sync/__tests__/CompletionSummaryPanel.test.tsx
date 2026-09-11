import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import type { WarningEntry } from "@/lib/types";

// renderWithI18n mounts I18nProvider, which imports @tauri-apps/api/core and
// @/lib/localeSettings. Mock both so no Tauri IPC happens under jsdom (same
// mock blocks as IdlePanel.test.tsx lines 7-13).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

// CompletionSummaryPanel renders its path list directly as whitespace-nowrap
// lines (no LogViewer) so the panel width can fit its content. Tests assert
// the rendered path/message text directly.
import { CompletionSummaryPanel } from "@/components/sync/CompletionSummaryPanel";
import { makeT, renderWithI18n } from "@/lib/i18n";

// Plain-object factory typed as WarningEntry to avoid TS excess-property
// complaints on the `severity: "warning" | "error"` union literal.
function entry(
  severity: WarningEntry["severity"],
  path: string,
  message: string,
  count: number,
): WarningEntry {
  return { severity, path, message, count };
}

describe("CompletionSummaryPanel", () => {
  // Test 1 (SUMM-22 / SC#2 silent gate — LOAD-BEARING): zero warnings → the
  // panel returns null; NO summary DOM is rendered. This is the test that
  // proves SC#2 byte-identical-to-today.
  it("renders zero summary DOM when warnings is empty (SC#2 silent gate)", () => {
    const { container } = renderWithI18n(
      <CompletionSummaryPanel warnings={[]} />,
    );

    // The panel must NOT render its root element when warnings.length === 0.
    expect(container.querySelector("[data-summary-root]")).toBeNull();
    // And the header text is absent (in both locales the header starts with
    // the synced/sync-complete chrome — assert via dictionary keys).
    expect(screen.queryByText(/Synced/)).toBeNull();
    expect(
      screen.queryByText(
        makeT("zh")("sync.summary.header.both", { warns: 0, errors: 0 }),
      ),
    ).toBeNull();
    expect(screen.queryByText(makeT("en")("sync.summary.errors"))).toBeNull();
    expect(screen.queryByText(makeT("en")("sync.summary.warnings"))).toBeNull();
    expect(screen.queryByText(makeT("zh")("sync.summary.errors"))).toBeNull();
    expect(screen.queryByText(makeT("zh")("sync.summary.warnings"))).toBeNull();
  });

  // Test 2 (SUMM-21 happy path — both severities): the header text equals the
  // sync.summary.header.both template with the per-severity counts
  // interpolated (D-02: three templates, never one stuffed string).
  it("renders header.both template with interpolated counts when both severities present", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[
          entry("error", "//depot/e1", "m", 2),
          entry("warning", "//depot/w1", "m", 3),
        ]}
      />,
    );

    expect(
      screen.getByText(
        makeT("en")("sync.summary.header.both", { warns: 1, errors: 1 }),
      ),
    ).toBeDefined();
    expect(
      screen.getByText(makeT("en")("sync.summary.errors")),
    ).toBeDefined();
    expect(
      screen.getByText(makeT("en")("sync.summary.warnings")),
    ).toBeDefined();
  });

  // Test 3 (D-07 warnings-only header): zero errors → the errors clause is
  // dropped; the header equals the header.warnings template and the
  // dropped-clause text from header.errors/header.both is absent.
  it("renders warnings-only header without the errors clause (D-07)", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[
          entry("warning", "//depot/w1", "m", 1),
          entry("warning", "//depot/w2", "m", 2),
        ]}
      />,
    );

    expect(
      screen.getByText(
        makeT("en")("sync.summary.header.warnings", { warns: 2 }),
      ),
    ).toBeDefined();
    // The dropped clause ("N errors") is absent. The "Errors" group LABEL
    // (capital E) may render with a zero Badge; the lowercase clause does not.
    expect(screen.queryByText(/errors/)).toBeNull();
  });

  // Test 4 (D-07 errors-only header): zero warnings → the warnings clause is
  // dropped; the header equals the header.errors template.
  it("renders errors-only header without the warnings clause (D-07)", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[entry("error", "//depot/e1", "m", 1)]}
      />,
    );

    expect(
      screen.getByText(
        makeT("en")("sync.summary.header.errors", { errors: 1 }),
      ),
    ).toBeDefined();
    expect(screen.queryByText(/warnings/)).toBeNull();
  });

  // Test 5 (SWEEP-04 slash split): group labels are single-language values
  // from the dictionary — a CJK-slash-Latin compound never renders.
  it("renders single-language group labels — no bilingual slash compound (SWEEP-04)", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[
          entry("error", "//depot/e1", "m", 1),
          entry("warning", "//depot/w1", "m", 1),
        ]}
      />,
    );

    expect(
      screen.getByText(makeT("en")("sync.summary.errors")),
    ).toBeDefined();
    expect(
      screen.getByText(makeT("en")("sync.summary.warnings")),
    ).toBeDefined();
    expect(screen.queryByText(makeT("zh")("sync.summary.errors"))).toBeNull();
    expect(screen.queryByText(makeT("zh")("sync.summary.warnings"))).toBeNull();
  });

  // Test 6 (shared common.* keys): the empty group body renders common.none;
  // the expand/collapse control uses common.collapse / common.expand with the
  // glyph inside the locale value.
  it("renders empty group body as common.none and expand/collapse via common.* keys", () => {
    // Warnings-only input: the Errors group is EMPTY → starts collapsed
    // (D-03 defaultExpanded={paths.length > 0}).
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[entry("warning", "//depot/w1", "m", 1)]}
      />,
    );

    // Expand the empty Errors group → its body shows common.none.
    const errorsButton = screen
      .getByText(makeT("en")("sync.summary.errors"))
      .closest("button")!;
    fireEvent.click(errorsButton);
    expect(screen.getByText(makeT("en")("common.none"))).toBeDefined();

    // The Warnings group has paths → default-EXPANDED, so its control reads
    // common.collapse; collapsing flips it to common.expand. Assert via the
    // warnings BUTTON's own control span (the empty Errors group also renders
    // an expand control, so query within the button scope).
    const warningsButton = screen
      .getByText(makeT("en")("sync.summary.warnings"))
      .closest("button")!;
    expect(
      within(warningsButton).getByText(makeT("en")("common.collapse")),
    ).toBeDefined();
    fireEvent.click(warningsButton);
    expect(
      within(warningsButton).getByText(makeT("en")("common.expand")),
    ).toBeDefined();
  });

  // Test 7 (BND-01 raw paths): depot paths render verbatim — never t()'d.
  it("renders raw depot paths verbatim (BND-01)", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[entry("warning", "//depot/w1", "m", 1)]}
      />,
    );

    expect(screen.getByText("//depot/w1")).toBeDefined();
  });

  // Test 8 (D-12 `<truncated>` sentinel): groupWarnings substitutes the
  // message for the literal "<truncated>" path, so the rendered text inside
  // the Warnings group is the message — NOT the literal "<truncated>" token.
  it("renders the <truncated> sentinel's message as the row text, not the literal sentinel", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[
          entry(
            "warning",
            "<truncated>",
            "+5 more paths suppressed (10 total warnings from 7 distinct paths)",
            0,
          ),
        ]}
      />,
    );

    expect(
      screen.getByText(
        "+5 more paths suppressed (10 total warnings from 7 distinct paths)",
      ),
    ).toBeDefined();
    // The literal sentinel never reaches the DOM as a path.
    expect(screen.queryByText(/^<truncated>$/, { exact: true })).toBeNull();
  });

  // Test 9 (D-13 empty path → message): a pathless pattern renders its
  // message, NOT a blank line.
  it("renders the message for a pathless warning (empty path)", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[entry("warning", "", "Library file missing.", 1)]}
      />,
    );

    expect(screen.getByText("Library file missing.")).toBeDefined();
  });

  // Test 10 (D-04 order + D-08 palette): Errors group renders BEFORE Warnings
  // group, and the severity tokens (red for errors, amber for warnings) are
  // applied to the respective group headers. The DOM order is asserted via
  // compareDocumentPosition.
  it("renders Errors group before Warnings group with red/amber palette tokens", () => {
    const { container } = renderWithI18n(
      <CompletionSummaryPanel
        warnings={[
          entry("error", "//depot/e1", "m", 1),
          entry("warning", "//depot/w1", "m", 1),
        ]}
      />,
    );

    const errorsHeader = screen.getByText(makeT("en")("sync.summary.errors"));
    const warningsHeader = screen.getByText(
      makeT("en")("sync.summary.warnings"),
    );
    // errorsHeader precedes warningsHeader in DOM order.
    // Node.DOCUMENT_POSITION_FOLLOWING = 4: warningsHeader follows errorsHeader.
    const relation = errorsHeader.compareDocumentPosition(warningsHeader);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Severity tokens present in the component source (assert via DOM).
    // The errors group's header carries a destructive token (text-destructive
    // or bg-destructive-surface); the warnings group carries a warning token.
    expect(
      container.querySelector(
        ".text-destructive, [class*='bg-destructive-surface']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        ".text-warning, [class*='bg-warning-surface']",
      ),
    ).not.toBeNull();
  });

  // Test 11 (D-03 defaultExpanded pin): when paths are non-empty, the
  // SeverityGroup defaults EXPANDED on first render — the path list is
  // visible WITHOUT a click (mirrors WorkspaceHealthPanel.tsx:137
  // `defaultExpanded={count > 0}`). Clicking the header toggles the list
  // hidden, then a second click restores it.
  it("defaults SeverityGroups expanded when paths are present and toggles on click (D-03)", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[entry("warning", "//depot/w1", "m", 1)]}
      />,
    );

    // Default-expanded: the path renders immediately without any click.
    expect(screen.getByText("//depot/w1")).toBeDefined();

    // Toggle: click the Warnings group header button (use the label text).
    const warningsButton = screen
      .getByText(makeT("en")("sync.summary.warnings"))
      .closest("button")!;
    fireEvent.click(warningsButton);

    // Collapsed: the path list no longer renders.
    expect(screen.queryByText("//depot/w1")).toBeNull();

    // Toggle back: the path reappears.
    fireEvent.click(warningsButton);
    expect(screen.getByText("//depot/w1")).toBeDefined();
  });

  // Test 12 (I18N-05 / SC#3 zh smoke): under a zh provider the group labels
  // are the zh dictionary values (sync.summary.errors — single-language), the
  // header uses the zh D-02 template with Latin warning/error tokens, and the
  // en group labels do not leak.
  it("zh smoke: group labels equal sync.summary.errors / warnings — no en leak", () => {
    renderWithI18n(
      <CompletionSummaryPanel
        warnings={[
          entry("error", "//depot/e1", "m", 1),
          entry("warning", "//depot/w1", "m", 1),
        ]}
      />,
      { locale: "zh" },
    );

    const tZh = makeT("zh");
    expect(screen.getByText(tZh("sync.summary.errors"))).toBeDefined();
    expect(screen.getByText(tZh("sync.summary.warnings"))).toBeDefined();
    expect(
      screen.getByText(
        tZh("sync.summary.header.both", { warns: 1, errors: 1 }),
      ),
    ).toBeDefined();
    expect(screen.queryByText(makeT("en")("sync.summary.errors"))).toBeNull();
    expect(screen.queryByText(makeT("en")("sync.summary.warnings"))).toBeNull();
  });
});

describe("CompletionSummaryPanel restyle (Phase 26)", () => {
  // Phase 26 (26-01 Task 2) — restyled region: the panel fills the result
  // card width (min-w-0, no shrink-to-fit w-fit/max-w-[90vw]) and raw paths
  // wrap in place (break-all) inside the bounded max-height scroll area
  // instead of whitespace-nowrap overflow.
  it("fills the result-card width and wraps raw paths instead of nowrap", () => {
    const { container } = renderWithI18n(
      <CompletionSummaryPanel
        warnings={[entry("warning", "//depot/very/long/raw/path.uasset", "m", 1)]}
      />,
    );

    const root = container.querySelector("[data-summary-root]") as HTMLElement;
    expect(root.className).toContain("min-w-0");
    expect(root.className).not.toContain("w-fit");
    expect(root.className).not.toContain("max-w-");

    const path = screen.getByText("//depot/very/long/raw/path.uasset");
    expect(path.className).toContain("break-all");
    expect(path.className).not.toContain("whitespace-nowrap");
    // The bounded scroll region survives the restyle.
    expect(path.closest("div.max-h-40")).not.toBeNull();
  });

  // Semantic toggle contract: the group toggle is a native button whose
  // expanded state is machine-readable (aria-expanded) and text-conveyed.
  it("exposes group expanded state via aria-expanded on the semantic toggle", () => {
    renderWithI18n(
      <CompletionSummaryPanel warnings={[entry("warning", "//depot/w1", "m", 1)]} />,
    );

    const toggle = screen
      .getByText(makeT("en")("sync.summary.warnings"))
      .closest("button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
