import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { WarningEntry } from "@/lib/types";

// react-virtuoso cannot measure layout in jsdom, so LogViewer renders zero
// items inside the test runner. CompletionSummaryPanel's contract is about
// WHICH strings render in WHICH group + expand/collapse — LogViewer's own
// virtualization is orthogonal (covered implicitly at runtime). Mock LogViewer
// to render each line as a plain div so the panel's path/message routing is
// observable. The mock is hoisted above the component import by vitest.
vi.mock("../LogViewer", () => ({
  LogViewer: ({ lines }: { lines: string[] }) => (
    <div data-testid="log-viewer">
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  ),
}));

// Import AFTER the mock so the panel picks up the mocked LogViewer.
import { CompletionSummaryPanel } from "@/components/sync/CompletionSummaryPanel";

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
  // Test 1 (SUMM-21 happy path — both severities): the header text renders the
  // distinct-path counts for BOTH severities, and both bilingual group labels
  // show with a Badge of 1 (distinct path count, matching WorkspaceHealthPanel
  // semantics).
  it("renders header + both severity groups with distinct-path Badges when both severities present", () => {
    render(
      <CompletionSummaryPanel
        warnings={[
          entry("error", "//depot/e1", "m", 2),
          entry("warning", "//depot/w1", "m", 3),
        ]}
      />,
    );

    expect(screen.getByText(/同步完成/)).toBeDefined();
    expect(screen.getByText(/1 条 warning/)).toBeDefined();
    expect(screen.getByText(/1 条 error/)).toBeDefined();
    expect(screen.getByText("错误 / Errors")).toBeDefined();
    expect(screen.getByText("警告 / Warnings")).toBeDefined();
  });

  // Test 2 (SUMM-22 / SC#2 silent gate — LOAD-BEARING): zero warnings → the
  // panel returns null; NO summary DOM is rendered. This is the test that
  // proves SC#2 byte-identical-to-today.
  it("renders zero summary DOM when warnings is empty (SC#2 silent gate)", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-testid", "wrap");
    // Attach to document.body manually so we can assert on wrapper.querySelector.
    document.body.appendChild(wrapper);
    try {
      const { unmount } = render(
        <div data-testid="wrap-inner">
          <CompletionSummaryPanel warnings={[]} />
        </div>,
        { container: wrapper },
      );

      // The panel must NOT render its root element when warnings.length === 0.
      expect(wrapper.querySelector("[data-summary-root]")).toBeNull();
      // And the header text is absent.
      expect(screen.queryByText(/同步完成/)).toBeNull();
      expect(screen.queryByText(/错误/)).toBeNull();
      expect(screen.queryByText(/警告/)).toBeNull();
      unmount();
    } finally {
      document.body.removeChild(wrapper);
    }
  });

  // Test 3 (D-12 `<truncated>` sentinel): groupWarnings substitutes the
  // message for the literal "<truncated>" path, so the rendered text inside
  // the Warnings group is the message — NOT the literal "<truncated>" token.
  it("renders the <truncated> sentinel's message as the row text, not the literal sentinel", () => {
    render(
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

  // Test 4 (D-13 empty path → message): a pathless pattern renders its
  // message, NOT a blank line.
  it("renders the message for a pathless warning (empty path)", () => {
    render(
      <CompletionSummaryPanel
        warnings={[entry("warning", "", "Library file missing.", 1)]}
      />,
    );

    expect(screen.getByText("Library file missing.")).toBeDefined();
  });

  // Test 5 (D-07 warnings-only header): zero errors → the error clause is
  // dropped; only the warning clause renders.
  it("renders warnings-only header without the error clause (D-07)", () => {
    render(
      <CompletionSummaryPanel
        warnings={[
          entry("warning", "//depot/w1", "m", 1),
          entry("warning", "//depot/w2", "m", 2),
        ]}
      />,
    );

    expect(screen.getByText(/同步完成/)).toBeDefined();
    expect(screen.getByText(/2 条 warning/)).toBeDefined();
    expect(screen.queryByText(/条 error/)).toBeNull();
  });

  // Test 6 (D-07 errors-only header): zero warnings → the warning clause is
  // dropped; only the error clause renders.
  it("renders errors-only header without the warning clause (D-07)", () => {
    render(
      <CompletionSummaryPanel
        warnings={[entry("error", "//depot/e1", "m", 1)]}
      />,
    );

    expect(screen.getByText(/同步完成/)).toBeDefined();
    expect(screen.getByText(/1 条 error/)).toBeDefined();
    expect(screen.queryByText(/条 warning/)).toBeNull();
  });

  // Test 7 (D-04 order + D-08 palette): Errors group renders BEFORE Warnings
  // group, and the severity tokens (red for errors, amber for warnings) are
  // applied to the respective group headers. The DOM order is asserted via
  // compareDocumentPosition.
  it("renders Errors group before Warnings group with red/amber palette tokens", () => {
    const { container } = render(
      <CompletionSummaryPanel
        warnings={[
          entry("error", "//depot/e1", "m", 1),
          entry("warning", "//depot/w1", "m", 1),
        ]}
      />,
    );

    const errorsHeader = screen.getByText("错误 / Errors");
    const warningsHeader = screen.getByText("警告 / Warnings");
    // errorsHeader precedes warningsHeader in DOM order.
    // Node.DOCUMENT_POSITION_FOLLOWING = 4: warningsHeader follows errorsHeader.
    const relation = errorsHeader.compareDocumentPosition(warningsHeader);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Severity tokens present in the component source (assert via DOM).
    // The errors group's header carries a red token (text-destructive or
    // bg-red-500/15); the warnings group carries an amber token.
    expect(
      container.querySelector(".text-destructive, [class*='bg-red-500']"),
    ).not.toBeNull();
    expect(
      container.querySelector(".text-amber-500, [class*='bg-amber-500']"),
    ).not.toBeNull();
  });

  // Test 8 (D-03 defaultExpanded pin): when paths are non-empty, the
  // SeverityGroup defaults EXPANDED on first render — the path list is
  // visible WITHOUT a click (mirrors WorkspaceHealthPanel.tsx:137
  // `defaultExpanded={count > 0}`). Clicking the header toggles the list
  // hidden, then a second click restores it.
  it("defaults SeverityGroups expanded when paths are present and toggles on click (D-03)", () => {
    render(
      <CompletionSummaryPanel
        warnings={[
          entry("warning", "//depot/w1", "m", 1),
        ]}
      />,
    );

    // Default-expanded: the path renders immediately without any click.
    expect(screen.getByText("//depot/w1")).toBeDefined();

    // Toggle: click the Warnings group header button (use the label text).
    const warningsHeader = screen.getByText("警告 / Warnings");
    const warningsButton = warningsHeader.closest("button")!;
    fireEvent.click(warningsButton);

    // Collapsed: the path list no longer renders.
    expect(screen.queryByText("//depot/w1")).toBeNull();

    // Toggle back: the path reappears.
    fireEvent.click(warningsButton);
    expect(screen.getByText("//depot/w1")).toBeDefined();
  });
});
