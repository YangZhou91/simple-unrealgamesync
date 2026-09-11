import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { LogViewer } from "@/components/sync/LogViewer";
import { makeT, renderWithI18n } from "@/lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: async () => {},
  loadLocale: async () => null,
}));
// react-virtuoso cannot measure in jsdom (Phase 14 documented blind spot —
// item list renders empty). Mock it to render itemContent directly so the
// BND-01 verbatim-line assert is meaningful at the itemContent level.
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

// LogViewer's populated path renders react-virtuoso, which cannot measure in
// jsdom — mocked above to render itemContent rows directly so the verbatim
// BND-01 assert exercises the real itemContent implementation.
describe("LogViewer chrome", () => {
  it("empty state shows dictionary sync.log.empty", () => {
    const t = makeT("en");
    renderWithI18n(<LogViewer lines={[]} />);
    expect(screen.getByText(t("sync.log.empty"))).toBeDefined();
  });

  it("populated shows the raw line verbatim and no empty chrome", () => {
    const t = makeT("en");
    renderWithI18n(<LogViewer lines={["//depot/Foo.cpp#12 - updating"]} />);
    expect(
      screen.getByText("//depot/Foo.cpp#12 - updating"),
    ).toBeDefined();
    expect(screen.queryByText(t("sync.log.empty"))).toBeNull();
  });

  it("zh smoke: empty state equals makeT(zh)(sync.log.empty)", () => {
    const zh = makeT("zh");
    renderWithI18n(<LogViewer lines={[]} />, { locale: "zh" });
    expect(screen.getByText(zh("sync.log.empty"))).toBeDefined();
  });

  // Phase 26 (26-02 Task 3): the row presentation carries the wrap contract
  // — pre-wrap whitespace plus overflow-wrap anywhere — so long raw lines
  // wrap within the log width instead of horizontally overflowing the
  // viewport at 352px (UI-SPEC §7 raw output card).
  it("rows carry pre-wrap and overflow-wrap-anywhere classes, never nowrap", () => {
    renderWithI18n(<LogViewer lines={["//depot/Foo.cpp#12 - updating"]} />);
    const row = screen.getByText("//depot/Foo.cpp#12 - updating");
    expect(row.className).toContain("whitespace-pre-wrap");
    expect(row.className).toContain("[overflow-wrap:anywhere]");
    expect(row.className).not.toContain("whitespace-nowrap");
    // 11px mono at 1.6 line height (canonical raw-log typography).
    expect(row.className).toContain("text-[11px]");
    expect(row.className).toContain("leading-[1.6]");
    expect(row.className).toContain("font-mono");
  });

  it("a long unbroken token renders as raw text without fabrication", () => {
    const longToken =
      "//DemoDepot/MainGame/Content/Characters/SomeVeryLongAssetName/Textures/T_VeryLongAssetName_DependencyChain_2K.uasset#1234 - updating";
    renderWithI18n(<LogViewer lines={[longToken]} />);
    expect(screen.getByText(longToken)).toBeDefined();
  });
});
