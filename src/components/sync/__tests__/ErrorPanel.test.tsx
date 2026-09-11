import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { ErrorPanel } from "@/components/sync/ErrorPanel";
import { makeT, renderWithI18n } from "@/lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

const RAW_ERROR = "boom from rust";

function renderErrorPanel() {
  renderWithI18n(
    <ErrorPanel
      step="p4Sync"
      error={RAW_ERROR}
      retryKind="retry"
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("ErrorPanel raw AppError sibling", () => {
  it("renders boom from rust and dictionary sync.error.title", () => {
    const t = makeT("en");
    renderErrorPanel();
    expect(screen.getByText(RAW_ERROR)).toBeDefined();
    expect(screen.getByText(t("sync.error.title"))).toBeDefined();
  });

  it("does not pass the raw error as a t() param of sync.error.failedAt", () => {
    const t = makeT("en");
    renderErrorPanel();
    const failedAt = t("sync.error.failedAt", { step: t("steps.p4Sync.all") });
    expect(failedAt.includes(RAW_ERROR)).toBe(false);
    expect(screen.getByText(failedAt)).toBeDefined();
    expect(
      screen.queryByText(t("sync.error.failedAt", { step: RAW_ERROR })),
    ).toBeNull();
  });
});

// Phase 26 (26-03 Task 1): the canonical inline error card (UI-SPEC §8) —
// destructive top edge card inside the tab scroll area, raw payload in its
// own mono well, restart/retry distinction, and the role=alert announcement
// carried by the card root itself.
describe("ErrorPanel canonical inline card (26-03)", () => {
  it("renders the typed retry label for retry, the restart label for restart", () => {
    const t = makeT("en");
    const onRetry = vi.fn();
    const { unmount } = renderWithI18n(
      <ErrorPanel
        step="p4Sync"
        error={RAW_ERROR}
        retryKind="retry"
        onRetry={onRetry}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: t("sync.error.retry") }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: t("sync.error.restart") }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("sync.error.retry") }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    renderWithI18n(
      <ErrorPanel
        step="networkCheck"
        error={RAW_ERROR}
        retryKind="restart"
        onRetry={onRetry}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: t("sync.error.restart") }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: t("sync.error.retry") }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("sync.error.restart") }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("defaults to the retry kind when retryKind is omitted", () => {
    const t = makeT("en");
    renderWithI18n(
      <ErrorPanel
        step="p4Sync"
        error={RAW_ERROR}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: t("sync.error.retry") }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: t("sync.error.restart") }),
    ).toBeNull();
  });

  it("renders the raw error in its own mono well element, separate from the typed failed-at sentence", () => {
    const t = makeT("en");
    renderErrorPanel();
    const failedAtNode = screen.getByText(
      t("sync.error.failedAt", { step: t("steps.p4Sync.all") }),
    );
    const rawNode = screen.getByText(RAW_ERROR);
    // Sibling elements — the raw payload is never part of the typed sentence node.
    expect(rawNode).not.toBe(failedAtNode);
    // Canonical raw well: mono text that wraps anywhere inside a bg-well surface.
    expect(rawNode.className).toContain("font-mono");
    expect(rawNode.className).toContain("[overflow-wrap:anywhere]");
    const well = rawNode.parentElement;
    expect(well?.className).toContain("bg-well");
  });

  it("dismiss is a semantic button that fires onDismiss on click", () => {
    const t = makeT("en");
    const onDismiss = vi.fn();
    renderWithI18n(
      <ErrorPanel
        step="p4Sync"
        error={RAW_ERROR}
        onRetry={() => {}}
        onDismiss={onDismiss}
      />,
    );
    const dismiss = screen.getByRole("button", { name: t("sync.error.dismiss") });
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the card root carries role=alert with the destructive top edge, inside the tab scroll area", () => {
    renderErrorPanel();
    const alert = screen.getByRole("alert");
    // 4px destructive top edge + 1px semantic border on the remaining sides,
    // 8px radius card (UI-SPEC §3 error-card geometry).
    expect(alert.className).toContain("border-t-4");
    expect(alert.className).toContain("border-t-destructive");
    expect(alert.className).toContain("rounded-lg");
    // Inline card at the top of the tab's scroll area — the scroller is the parent.
    const scroller = alert.parentElement;
    expect(scroller?.className).toContain("overflow-y-auto");
    // Announcement covers the typed heading.
    expect(alert.textContent).toContain(makeT("en")("sync.error.title"));
  });
});
