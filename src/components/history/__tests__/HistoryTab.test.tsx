import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { HistoryTab } from "@/components/history/HistoryTab";
import { makeT, renderWithI18n, useT } from "@/lib/i18n";
import {
  formatTimestamp,
  parseHistoryTimestamp,
} from "@/lib/i18n/formatTimestamp";
import type { HistoryRecord } from "@/lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));

// react-virtuoso cannot measure in jsdom (RESEARCH Pitfall 1). Render
// itemContent for every data item so populated-row asserts stay meaningful.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, entry: unknown) => ReactNode;
  }) => (
    <div>
      {data.map((entry, i) => (
        <div key={i}>{itemContent(i, entry)}</div>
      ))}
    </div>
  ),
}));

const baseProps = {
  workspaceId: "ws-1" as string | null,
  isSyncRunning: false,
  onRollback: () => {},
  records: [] as HistoryRecord[],
  isLoading: false,
};

const sampleRecord: HistoryRecord = {
  changelist: "310771",
  timestamp: "2024-01-15 10:30:00",
  fileCount: 42,
  workspaceId: "ws-1",
  durationMs: 5000,
};

function LocaleSwitchHarness({ records }: { records: HistoryRecord[] }) {
  const { setLocale } = useT();
  return (
    <div>
      <button data-testid="switch-zh" onClick={() => setLocale("zh")}>
        zh
      </button>
      <HistoryTab {...baseProps} records={records} />
    </div>
  );
}

describe("HistoryTab chrome", () => {
  it("shows history.loading when isLoading and hides empty title", () => {
    const t = makeT("en");
    renderWithI18n(<HistoryTab {...baseProps} isLoading />);
    expect(screen.getByText(t("history.loading"))).toBeDefined();
    expect(screen.queryByText(t("history.empty.title"))).toBeNull();
    expect(screen.queryByText(t("history.columns.changelist"))).toBeNull();
    expect(screen.queryByText(t("history.columns.time"))).toBeNull();
    expect(screen.queryByText(t("history.columns.duration"))).toBeNull();
    expect(screen.queryByText(t("history.columns.files"))).toBeNull();
  });

  it("shows empty title and body when not loading and records=[]", () => {
    const t = makeT("en");
    renderWithI18n(<HistoryTab {...baseProps} />);
    expect(screen.getByText(t("history.empty.title"))).toBeDefined();
    expect(screen.getByText(t("history.empty.body"))).toBeDefined();
    expect(screen.queryByText(t("history.columns.changelist"))).toBeNull();
    expect(screen.queryByText(t("history.columns.time"))).toBeNull();
    expect(screen.queryByText(t("history.columns.duration"))).toBeNull();
    expect(screen.queryByText(t("history.columns.files"))).toBeNull();
  });

  it("header button name equals history.rollback; disabled title when isSyncRunning", () => {
    const t = makeT("en");
    renderWithI18n(<HistoryTab {...baseProps} isSyncRunning />);
    const btn = screen.getByRole("button", { name: t("history.rollback") });
    expect(btn).toBeDefined();
    expect(btn.getAttribute("title")).toBe(t("history.rollback.disabledTitle"));
  });

  it("paints formatted timestamp not the raw storage string", () => {
    const ms = parseHistoryTimestamp("2024-01-15 10:30:00")!;
    renderWithI18n(<HistoryTab {...baseProps} records={[sampleRecord]} />);
    expect(screen.getByText(formatTimestamp(ms, "en"))).toBeDefined();
    expect(screen.queryByText("2024-01-15 10:30:00")).toBeNull();
  });

  it("file cell and CL badge use dictionary interpolation", () => {
    const t = makeT("en");
    renderWithI18n(<HistoryTab {...baseProps} records={[sampleRecord]} />);
    expect(
      screen.getByText(t("history.files", { n: sampleRecord.fileCount })),
    ).toBeDefined();
    expect(
      screen.getByText(t("history.clBadge", { cl: sampleRecord.changelist })),
    ).toBeDefined();
  });

  it("durationMs 5000 paints 5s; omitted paints glyph —", () => {
    renderWithI18n(
      <HistoryTab
        {...baseProps}
        records={[
          sampleRecord,
          {
            ...sampleRecord,
            changelist: "1",
            timestamp: "2024-01-15 10:31:00",
            durationMs: undefined,
            fileCount: 1,
          },
        ]}
      />,
    );
    expect(screen.getByText("5s")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
  });

  it("unparseable timestamp paints the raw storage string", () => {
    renderWithI18n(
      <HistoryTab
        {...baseProps}
        records={[{ ...sampleRecord, timestamp: "not-a-date" }]}
      />,
    );
    expect(screen.getByText("not-a-date")).toBeDefined();
  });

  it("zh smoke: header button name equals makeT zh history.rollback", () => {
    const zh = makeT("zh");
    renderWithI18n(<HistoryTab {...baseProps} />, { locale: "zh" });
    expect(
      screen.getByRole("button", { name: zh("history.rollback") }),
    ).toBeDefined();
  });

  it("locale switch re-paints the row date without remount", () => {
    const ms = parseHistoryTimestamp(sampleRecord.timestamp)!;
    renderWithI18n(<LocaleSwitchHarness records={[sampleRecord]} />, {
      locale: "en",
    });
    expect(screen.getByText(formatTimestamp(ms, "en"))).toBeDefined();
    fireEvent.click(screen.getByTestId("switch-zh"));
    expect(screen.getByText(formatTimestamp(ms, "zh"))).toBeDefined();
  });

  it("populated history paints title and four column headers", () => {
    const t = makeT("en");
    const ms = parseHistoryTimestamp(sampleRecord.timestamp)!;
    renderWithI18n(<HistoryTab {...baseProps} records={[sampleRecord]} />);
    expect(screen.getByText(t("history.title"))).toBeDefined();
    expect(screen.getByText(t("history.columns.changelist"))).toBeDefined();
    expect(screen.getByText(t("history.columns.time"))).toBeDefined();
    expect(screen.getByText(t("history.columns.duration"))).toBeDefined();
    expect(screen.getByText(t("history.columns.files"))).toBeDefined();
    expect(
      screen.getByText(t("history.clBadge", { cl: sampleRecord.changelist })),
    ).toBeDefined();
    expect(screen.getByText(formatTimestamp(ms, "en"))).toBeDefined();
    expect(screen.getByText("5s")).toBeDefined();
    expect(
      screen.getByText(t("history.files", { n: sampleRecord.fileCount })),
    ).toBeDefined();
  });

  it("populated row and four cells include min-w-0", () => {
    const t = makeT("en");
    renderWithI18n(<HistoryTab {...baseProps} records={[sampleRecord]} />);
    const clCell = screen.getByText(
      t("history.clBadge", { cl: sampleRecord.changelist }),
    );
    const row = clCell.parentElement;
    expect(row).not.toBeNull();
    expect(row!.className.split(/\s+/)).toContain("min-w-0");
    expect(row!.children).toHaveLength(4);
    for (const cell of Array.from(row!.children)) {
      expect(cell.className.split(/\s+/)).toContain("min-w-0");
    }
  });

  it("Rollback is an outlined labelled button", () => {
    const t = makeT("en");
    renderWithI18n(<HistoryTab {...baseProps} records={[sampleRecord]} />);
    const btn = screen.getByRole("button", { name: t("history.rollback") });
    expect(btn).toBeDefined();
    expect(btn.getAttribute("data-variant")).toBe("outline");
  });
});
