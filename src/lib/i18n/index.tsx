import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import en from "./locales/en";
import zh from "./locales/zh";
import * as localeSettings from "@/lib/localeSettings";

export type Locale = "zh" | "en";
export type MessageKey = keyof typeof en;
type InterpolationParams = Record<string, string | number>;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, zh };

export function makeT(locale: Locale) {
  const dict = dictionaries[locale];
  return (key: MessageKey, params?: InterpolationParams): string => {
    let str = dict[key];
    if (params) { for (const [token, value] of Object.entries(params)) { const re = new RegExp(`\\{${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "g"); str = str.replace(re, String(value)); } }
    return str;
  };
}

export interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, params?: InterpolationParams) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    // Persist FIRST (source of truth — a crashed push still leaves a
    // correct boot state), then push to Rust which relabels the tray.
    // The empty catch is the UI-SPEC-mandated silent degrade: no webview
    // error surface, no rollback. Identity deliberately stable ([] deps,
    // commit 4868231) — invoke is a module-level import needing no dep.
    void localeSettings
      .saveLocale(l)
      .then(() => invoke("set_locale", { locale: l }))
      .catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ locale, setLocale, t: makeT(locale) }),
    [locale, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useT must be used within an I18nProvider");
  }
  return ctx;
}

function isMessageKey(k: string): k is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, k);
}

// Lockstep with src-tauri/src/models/sync_event.rs known_sub_steps()
export const KNOWN_SUB_STEPS = [
  ["closeUe", "check"],
  ["closeExcel", "check"],
  ["cleanDevDir", "clean"],
  ["p4Sync", "toCl"],
  ["p4Sync", "all"],
  ["forceSync", "force"],
  ["genProject", "gen"],
  ["gitPull", "run"],
  ["gitPull", "stash"],
  ["gitPull", "preNetwork"],
  ["gitPull", "restoreStash"],
] as const;

const PIPELINE_CANONICAL: Record<string, string> = {
  closeUe: "check",
  closeExcel: "check",
  cleanDevDir: "clean",
  genProject: "gen",
  forceSync: "force",
};

export function resolveSubStep(
  step: string,
  subStep: string | null | undefined,
  targetCl: string,
): string | undefined {
  if (subStep) return subStep;
  if (step === "p4Sync") return targetCl ? "toCl" : "all";
  return PIPELINE_CANONICAL[step];
}

export { formatTimestamp, parseHistoryTimestamp } from "./formatTimestamp";

export function useStepLabels() {
  const { t } = useT();
  return useCallback(
    (step: string, subStep?: string | null, params?: { cl?: string }): string => {
      const key = `steps.${step}.${subStep ?? ""}`;
      if (subStep && isMessageKey(key)) {
        if (key === "steps.p4Sync.toCl") {
          if (!params?.cl) return t("steps.p4Sync.all");
          return t(key, { cl: params.cl });
        }
        return t(key, params);
      }
      return t("steps.unknown");
    },
    [t],
  );
}

/** Re-export for explicit test usage. Kept for Phase 18+ sweep tests that
 *  construct their own provider tree; not consumed within Phase 17. */
export { I18nProvider as TestI18nProvider };

/**
 * Vitest helper: wraps a component tree with I18nProvider at a pinned locale.
 * Default pins "en" because most existing test assertions are English.
 */
export function renderWithI18n(
  ui: React.ReactElement,
  options?: { locale?: Locale }
) {
  const locale = (options?.locale ?? ("en" as Locale)) as Locale;
  return render(ui, {
    wrapper: ({ children }) => (
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    ),
  });
}
