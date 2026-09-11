import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { I18nProvider, type Locale } from "./lib/i18n";
import * as localeSettings from "./lib/localeSettings";
import { invoke } from "@tauri-apps/api/core";

const DEFAULT_LOCALE: Locale = "zh";

async function resolveLocale(): Promise<Locale> {
  const stored = await localeSettings.loadLocale();
  if (stored) return stored;
  // First launch: follow the Windows display language. I18N-04: null/failure → zh
  // (explicit default, REQUIREMENTS 2026-09-01) — only a non-zh locale maps to en.
  const systemLocale = await invoke<string | null>("get_system_locale");
  const detected: Locale = systemLocale && !systemLocale.startsWith("zh") ? "en" : "zh";
  await localeSettings.saveLocale(detected);
  // First-launch convergence (research 2.3 gap closure): push the detected
  // locale to Rust so the tray's boot-detected AppLocale converges with the
  // frontend's detected+persisted value even if the two detection paths
  // ever disagree. Best-effort — a failure here must not block boot.
  await invoke("set_locale", { locale: detected }).catch(() => {});
  return detected;
}

resolveLocale()
  .then((locale) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <I18nProvider initialLocale={locale}>
        <App />
      </I18nProvider>,
    );
  })
  .catch(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <I18nProvider initialLocale={DEFAULT_LOCALE}>
        <App />
      </I18nProvider>,
    );
  });
