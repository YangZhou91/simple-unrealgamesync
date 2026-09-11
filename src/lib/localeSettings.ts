import { load, type Store } from "@tauri-apps/plugin-store";
import type { Locale } from "@/lib/i18n";

const STORE_PATH = ".settings";
const KEY_LOCALE = "app.locale";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_PATH, { autoSave: false, defaults: {} });
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

export async function loadLocale(): Promise<Locale | null> {
  const store = await getStore();
  const raw = await store.get<string>(KEY_LOCALE);
  if (raw === "zh" || raw === "en") return raw;
  return null;
}

export async function saveLocale(locale: Locale): Promise<void> {
  const store = await getStore();
  await store.set(KEY_LOCALE, locale);
  await store.save();
}
