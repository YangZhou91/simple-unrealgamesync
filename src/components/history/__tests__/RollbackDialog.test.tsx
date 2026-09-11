import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { CSSProperties, ReactNode } from "react";
import { RollbackDialog } from "@/components/history/RollbackDialog";
import { makeT, renderWithI18n, useT } from "@/lib/i18n";
import type { ChangelistEntry } from "@/lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

const hoisted = vi.hoisted(() => ({
  getChangelists: vi.fn(),
  virtuoso: {
    style: undefined as CSSProperties | undefined,
    endReached: undefined as ((index: number) => void) | undefined,
  },
}));

vi.mock("@/lib/commands", () => ({
  getChangelists: (...args: unknown[]) => hoisted.getChangelists(...args),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    components,
    style,
    endReached,
  }: {
    data: unknown[];
    itemContent: (index: number, entry: unknown) => ReactNode;
    components?: { Footer?: () => ReactNode };
    style?: CSSProperties;
    endReached?: (index: number) => void;
  }) => {
    hoisted.virtuoso.style = style;
    hoisted.virtuoso.endReached = endReached;
    return (
      <div style={style}>
        {data.map((entry, i) => (
          <div key={i}>{itemContent(i, entry)}</div>
        ))}
        {components?.Footer ? <components.Footer /> : null}
      </div>
    );
  },
}));

const sampleEntry: ChangelistEntry = {
  number: "310771",
  user: "alice",
  date: "2024/01/15",
  description: "raw p4 desc",
  client: "my_client",
};

const baseProps = {
  open: true,
  onOpenChange: () => {},
  workspaceId: "ws-1" as string | null,
  onRollback: () => {},
};

function LoadErrorLocaleHarness() {
  const { setLocale } = useT();
  return (
    <div>
      <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
        zh
      </button>
      <RollbackDialog {...baseProps} />
    </div>
  );
}

function getClChoiceButton() {
  return screen.getByRole("button", { name: /alice/ });
}

describe("RollbackDialog dictionary chrome", () => {
  beforeEach(() => {
    hoisted.getChangelists.mockReset();
    hoisted.getChangelists.mockResolvedValue([sampleEntry]);
    hoisted.virtuoso.style = undefined;
    hoisted.virtuoso.endReached = undefined;
  });

  it("opens with one entry: title, CL badge chrome, and raw p4 user/date/description", async () => {
    const t = makeT("en");
    renderWithI18n(<RollbackDialog {...baseProps} />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: t("history.rollback.dialogTitle") }),
      ).toBeDefined();
    });
    expect(
      screen.getByText(t("history.clBadge", { cl: "310771" })),
    ).toBeDefined();
    expect(screen.getByText("alice")).toBeDefined();
    expect(screen.getByText("2024/01/15")).toBeDefined();
    expect(screen.getByText("raw p4 desc")).toBeDefined();
  });

  it("Next is disabled until a CL is selected; unselected name is history.rollback", async () => {
    const t = makeT("en");
    renderWithI18n(<RollbackDialog {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeDefined();
    });
    const next = screen.getByRole("button", { name: t("history.rollback") });
    expect(next).toBeDisabled();
    expect(next).toHaveAttribute("data-variant", "outline");
    expect(next.className).not.toMatch(/(?:^|\s)bg-accent(?:\s|$)/);
    fireEvent.click(getClChoiceButton());
    const toCl = screen.getByRole("button", {
      name: t("history.rollback.toCl", { cl: "310771" }),
    });
    expect(toCl).not.toBeDisabled();
  });

  it("selects a CL via a native button with aria-pressed and selected accent", async () => {
    const t = makeT("en");
    renderWithI18n(<RollbackDialog {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeDefined();
    });
    const choice = getClChoiceButton();
    expect(choice.tagName).toBe("BUTTON");
    expect(choice).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(choice);
    expect(choice).toHaveAttribute("aria-pressed", "true");
    expect(choice.className).toContain("border-primary");
    expect(choice.className).toContain("bg-accent");
    expect(choice.className).not.toContain("bg-accent/10");
    expect(screen.getByText("alice")).toBeDefined();
    expect(screen.getByText("2024/01/15")).toBeDefined();
    expect(screen.getByText("raw p4 desc")).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: t("history.rollback.toCl", { cl: "310771" }),
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("history.rollback.dismiss") }),
    ).toBeDefined();
  });

  it("getChangelists uses workspaceId, batch 25, afterCl paging, 400px height, and endReached", async () => {
    const older: ChangelistEntry = {
      number: "310770",
      user: "bob",
      date: "2024/01/14",
      description: "older raw desc",
      client: "my_client",
    };
    hoisted.getChangelists
      .mockResolvedValueOnce([sampleEntry])
      .mockResolvedValueOnce([older]);
    renderWithI18n(<RollbackDialog {...baseProps} />);
    await waitFor(() => {
      expect(hoisted.getChangelists).toHaveBeenCalledWith("ws-1", 25, undefined);
    });
    expect(hoisted.virtuoso.style).toEqual({ height: 400 });
    expect(typeof hoisted.virtuoso.endReached).toBe("function");
    hoisted.virtuoso.endReached?.(1);
    await waitFor(() => {
      expect(hoisted.getChangelists).toHaveBeenCalledWith("ws-1", 25, "310771");
    });
    expect(screen.getByText("bob")).toBeDefined();
  });

  it("selected row: primary is toCl and dismiss is history.rollback.dismiss", async () => {
    const t = makeT("en");
    renderWithI18n(<RollbackDialog {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeDefined();
    });
    fireEvent.click(getClChoiceButton());
    expect(
      screen.getByRole("button", {
        name: t("history.rollback.toCl", { cl: "310771" }),
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: t("history.rollback.dismiss") }),
    ).toBeDefined();
  });

  it("confirm step: title, confirmSubtitle, selected, confirmBody {cl} only, raw description as sibling", async () => {
    const t = makeT("en");
    renderWithI18n(<RollbackDialog {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeDefined();
    });
    fireEvent.click(getClChoiceButton());
    fireEvent.click(
      screen.getByRole("button", {
        name: t("history.rollback.toCl", { cl: "310771" }),
      }),
    );
    expect(
      screen.getByRole("heading", { name: t("history.rollback.confirmTitle") }),
    ).toBeDefined();
    expect(screen.getByText(t("history.rollback.confirmSubtitle"))).toBeDefined();
    expect(
      screen.getByText(t("history.rollback.selected", { cl: "310771" })),
    ).toBeDefined();
    const body = t("history.rollback.confirmBody", { cl: "310771" });
    const bodyNode = screen.getByText(body);
    expect(bodyNode).toBeDefined();
    expect(bodyNode.textContent).not.toContain("raw p4 desc");
    const descNode = screen.getByText("raw p4 desc");
    expect(descNode).toBeDefined();
    expect(descNode).not.toBe(bodyNode);
    expect(bodyNode.className).toContain("bg-warning-surface");
    expect(bodyNode.className).toContain("text-warning");
  });

  it("confirm execute stays primary; Keep Current CL is outline and disables while rolling back", async () => {
    const t = makeT("en");
    const onRollback = vi.fn();
    renderWithI18n(<RollbackDialog {...baseProps} onRollback={onRollback} />);
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeDefined();
    });
    fireEvent.click(getClChoiceButton());
    fireEvent.click(
      screen.getByRole("button", {
        name: t("history.rollback.toCl", { cl: "310771" }),
      }),
    );
    const execute = screen.getByRole("button", {
      name: t("history.rollback.toCl", { cl: "310771" }),
    });
    expect(execute).toHaveAttribute("data-variant", "default");
    expect(execute.getAttribute("data-variant")).not.toBe("destructive");
    const dismiss = screen.getByRole("button", {
      name: t("history.rollback.dismiss"),
    });
    expect(dismiss).toHaveAttribute("data-variant", "outline");
    expect(dismiss).not.toBeDisabled();
    fireEvent.click(execute);
    expect(onRollback).toHaveBeenCalledWith("310771");
    expect(
      screen.getByRole("button", { name: t("history.rollback.rollingBack") }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: t("history.rollback.dismiss") }),
    ).toBeDisabled();
  });

  it("load failure: loadError + retry chrome; locale-switch re-paints without retrying", async () => {
    hoisted.getChangelists.mockRejectedValue(new Error("boom"));
    const t = makeT("en");
    renderWithI18n(<LoadErrorLocaleHarness />);
    await waitFor(() => {
      expect(screen.getByText(t("history.rollback.loadError"))).toBeDefined();
    });
    expect(
      screen.getByRole("button", { name: t("history.rollback.retry") }),
    ).toBeDefined();
    const calls = hoisted.getChangelists.mock.calls.length;
    fireEvent.click(screen.getByTestId("switch-zh"));
    const zh = makeT("zh");
    expect(screen.getByText(zh("history.rollback.loadError"))).toBeDefined();
    expect(
      screen.getByRole("button", { name: zh("history.rollback.retry") }),
    ).toBeDefined();
    expect(hoisted.getChangelists.mock.calls.length).toBe(calls);
  });

  it("successful zero batch: empty copy inside the dialog and dismiss still present", async () => {
    hoisted.getChangelists.mockResolvedValue([]);
    const t = makeT("en");
    renderWithI18n(<RollbackDialog {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByText(t("history.rollback.empty"))).toBeDefined();
    });
    expect(
      screen.getByRole("button", { name: t("history.rollback.dismiss") }),
    ).toBeDefined();
    expect(screen.getByText(t("history.rollback.empty")).parentElement?.style.height).toBe(
      "400px",
    );
  });

  it("zh smoke: dismiss name equals makeT zh history.rollback.dismiss", async () => {
    const zh = makeT("zh");
    renderWithI18n(<RollbackDialog {...baseProps} />, { locale: "zh" });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: zh("history.rollback.dismiss") }),
      ).toBeDefined();
    });
  });
});
