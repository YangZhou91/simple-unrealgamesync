import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeT, renderWithI18n, KNOWN_SUB_STEPS, type Locale } from "@/lib/i18n";
import { screen, fireEvent } from "@testing-library/react";
import en from "@/lib/i18n/locales/en";

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const saveLocaleMock = vi.fn<(locale: string) => Promise<void>>(async () => {});
vi.mock("@/lib/localeSettings", () => ({
  saveLocale: (locale: string) => saveLocaleMock(locale),
  loadLocale: async () => null,
}));

import { useT } from "@/lib/i18n";

/** Renders a button that calls setLocale and reports the current locale. */
function LocaleSwitcher({ target }: { target: Locale }) {
  const { setLocale, locale } = useT();
  return (
    <div>
      <span data-testid="current-locale">{locale}</span>
      <button data-testid="switch" onClick={() => setLocale(target)}>
        switch
      </button>
    </div>
  );
}

describe("setLocale persist-then-push wiring (Phase 18)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveLocaleMock.mockClear();
  });

  it("persists via saveLocale BEFORE invoking set_locale with { locale }", async () => {
    renderWithI18n(<LocaleSwitcher target="zh" />);
    fireEvent.click(screen.getByTestId("switch"));

    // Wait for the persist-then-push chain to settle.
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    expect(saveLocaleMock).toHaveBeenCalledTimes(1);
    expect(saveLocaleMock).toHaveBeenCalledWith("zh");
    expect(invokeMock).toHaveBeenCalledWith("set_locale", { locale: "zh" });

    // Call-order assertion: saveLocale was invoked before set_locale.
    const order: string[] = [];
    saveLocaleMock.mockImplementationOnce(async () => {
      order.push("save");
    });
    invokeMock.mockImplementationOnce(async () => {
      order.push("invoke");
    });
    fireEvent.click(screen.getByTestId("switch"));
    await vi.waitFor(() => {
      expect(order).toEqual(["save", "invoke"]);
    });
  });

  it("a rejecting invoke does not throw (silent degrade)", async () => {
    invokeMock.mockRejectedValueOnce(new Error("IPC failed"));
    renderWithI18n(<LocaleSwitcher target="en" />);

    expect(() => fireEvent.click(screen.getByTestId("switch"))).not.toThrow();
    // The webview state still flipped instantly despite the failed push.
    expect(screen.getByTestId("current-locale").textContent).toBe("en");
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_locale", { locale: "en" });
    });
  });

  it("flips the provider locale instantly (Phase 17 behavior intact)", async () => {
    renderWithI18n(<LocaleSwitcher target="zh" />, { locale: "en" });
    expect(screen.getByTestId("current-locale").textContent).toBe("en");
    fireEvent.click(screen.getByTestId("switch"));
    expect(screen.getByTestId("current-locale").textContent).toBe("zh");
    await vi.waitFor(() => {
      expect(saveLocaleMock).toHaveBeenCalledWith("zh");
    });
  });

  it("flips UI even if saveLocale never resolves (native hang must not block React state)", () => {
    saveLocaleMock.mockImplementationOnce(() => new Promise(() => {}));
    renderWithI18n(<LocaleSwitcher target="en" />, { locale: "zh" });
    fireEvent.click(screen.getByTestId("switch"));
    expect(screen.getByTestId("current-locale").textContent).toBe("en");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("makeT", () => {
  it("returns the English string for a known dictionary key", () => {
    const t = makeT("en");
    expect(t("settings.language.title")).toBe("Language");
  });

  it("returns the Chinese string for the same key", () => {
    const t = makeT("zh");
    expect(t("settings.language.title")).toBe("语言");
  });

  it("interpolates steps.p4Sync.toCl {cl} with 310771", () => {
    const t = makeT("en");
    expect(t("steps.p4Sync.toCl", { cl: "310771" })).toBe("Syncing to CL 310771");
  });

  it("leaves literal {cl} when the param is missing (mechanism — UI must not hit this path)", () => {
    const t = makeT("en");
    expect(t("steps.p4Sync.toCl")).toContain("{cl}");
  });

  it("interpolates steps.status.cancelledAt {step} in both locales", () => {
    expect(makeT("zh")("steps.status.cancelledAt", { step: "同步文件" })).toBe(
      "已取消于 同步文件",
    );
    expect(makeT("en")("steps.status.cancelledAt", { step: "Syncing Files" })).toBe(
      "Cancelled at Syncing Files",
    );
  });

  it("with no params returns the string unchanged", () => {
    const t = makeT("en");
    expect(t("settings.language.title")).toBe("Language");
    expect(t("settings.language.description")).toBe(
      "Choose the interface language. Applies instantly."
    );
  });
});

describe("makeT Phase 20 interpolation families", () => {
  it("interpolates sync.summary.header.both {warns}/{errors} in en (always-plural, D-02)", () => {
    expect(makeT("en")("sync.summary.header.both", { warns: 1, errors: 2 })).toBe(
      "Synced — 1 warnings / 2 errors",
    );
  });

  it("interpolates sync.summary.header.both in zh keeping Latin warning/error (D-02)", () => {
    expect(makeT("zh")("sync.summary.header.both", { warns: 1, errors: 2 })).toBe(
      "同步完成 — 1 条 warning / 2 条 error",
    );
  });

  it("leaves literal {n} in sync.prep when the param is missing", () => {
    expect(makeT("en")("sync.prep")).toContain("{n}");
  });

  it("interpolates sync.prep {n} with 164038", () => {
    const out = makeT("en")("sync.prep", { n: 164038 });
    expect(out).toContain("164038");
    expect(out).not.toContain("{n}");
    expect(out).toBe("Preparing… updating 164038 files");
  });

  it("common.expand carries ▼ and common.collapse carries ▲ in both locales", () => {
    expect(makeT("en")("common.expand")).toContain("▼");
    expect(makeT("zh")("common.expand")).toContain("▼");
    expect(makeT("en")("common.collapse")).toContain("▲");
    expect(makeT("zh")("common.collapse")).toContain("▲");
  });
});

describe("makeT Phase 21 interpolation families", () => {
  it("substitutes history.files {n} into en and zh templates", () => {
    expect(makeT("en")("history.files", { n: 1 })).toBe("1 files");
    expect(makeT("zh")("history.files", { n: 1 })).toBe("1 个文件");
  });

  it("leaves literal {cl} in history.rollback.confirmBody when the param is missing", () => {
    expect(makeT("en")("history.rollback.confirmBody")).toContain("{cl}");
  });

  it("interpolates history.rollback.confirmBody {cl} with 310771", () => {
    const out = makeT("en")("history.rollback.confirmBody", { cl: 310771 });
    expect(out).toContain("310771");
    expect(out).not.toContain("{cl}");
  });

  it("interpolates workspace.item.deleteAria {name} with Main", () => {
    const out = makeT("en")("workspace.item.deleteAria", { name: "Main" });
    expect(out).toContain("Main");
    expect(out).not.toContain("{name}");
  });
});

describe("makeT Phase 22 interpolation families", () => {
  it("interpolates settings.logs.exported {dest} and leaves the token when missing", () => {
    const dest = "D:\\\\out.log";
    const out = makeT("en")("settings.logs.exported", { dest });
    expect(out).toContain(dest);
    expect(out).not.toContain("{dest}");
    expect(makeT("en")("settings.logs.exported")).toContain("{dest}");
  });

  it("interpolates settings.exclusions.removeAria {path}", () => {
    const out = makeT("en")("settings.exclusions.removeAria", { path: "Binaries" });
    expect(out).toContain("Binaries");
    expect(out).not.toContain("{path}");
  });

  it("interpolates layout.updater.askBody {version} and leaves the token when missing", () => {
    const out = makeT("en")("layout.updater.askBody", { version: "1.7.0" });
    expect(out).toContain("1.7.0");
    expect(out).not.toContain("{version}");
    expect(makeT("en")("layout.updater.askBody")).toContain("{version}");
  });
});

describe("renderWithI18n", () => {
  it("wraps component with I18nProvider at pinned locale (default en)", () => {
    function TestComponent() {
      return <div data-testid="test">Hello</div>;
    }
    renderWithI18n(<TestComponent />);
    expect(screen.getByTestId("test")).toBeInTheDocument();
  });

  it("accepts locale override via options.locale", () => {
    function TestComponent() {
      // Can't use useT here without I18nProvider, but renderWithI18n provides it
      // We'll test this by checking that the component renders (no crash)
      return <div data-testid="zh-test">中文测试</div>;
    }
    renderWithI18n(<TestComponent />, { locale: "zh" as Locale });
    expect(screen.getByTestId("zh-test")).toBeInTheDocument();
  });
});

describe("steps keys completeness", () => {
  it("every KNOWN_SUB_STEPS pair has steps.{step}.{subStep} in en", () => {
    expect(KNOWN_SUB_STEPS).toHaveLength(11);
    for (const [step, subStep] of KNOWN_SUB_STEPS) {
      const key = `steps.${step}.${subStep}`;
      expect(Object.prototype.hasOwnProperty.call(en, key), key).toBe(true);
    }
  });
});
