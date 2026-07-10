/**
 * Updater proxy settings, persisted over tauri-plugin-store.
 *
 * quick-260710-gfp
 *
 * Purpose: let the auto-updater's GitHub egress be routed through the user's
 * local proxy (e.g. a Clash mixed-port at localhost:7897) so the update check
 * + download survive the GFW. Defaults to OFF (direct GitHub), matching the
 * pre-feature behavior byte-for-byte.
 *
 * Two store keys live under a dedicated ".settings" store file:
 *   - updater.proxy_enabled (boolean, default false)
 *   - updater.proxy_url     (string,  default http://localhost:7897)
 *
 * The store handle is loaded once and cached at module scope (a single shared
 * promise) so the repeated callers in useUpdater (one read per check) and the
 * Settings dialog (one read per open) all share one IPC handle instead of
 * re-`load`-ing on every call.
 *
 * Invariants enforced here:
 *   - proxyUrl is NEVER returned empty. Empty/whitespace falls back to the
 *     default on read (T-quick-01 mitigation).
 *   - proxyUrl is NEVER persisted empty. saveUpdaterSettings substitutes the
 *     default before writing (a broken empty string would otherwise survive
 *     a restart and silently break the next check).
 */

import { load, type Store } from "@tauri-apps/plugin-store";

export interface UpdaterSettings {
  proxyEnabled: boolean;
  proxyUrl: string;
}

/** Default local proxy URL — Clash's typical mixed-port. */
export const DEFAULT_UPDATER_PROXY_URL = "http://localhost:7897";

const STORE_PATH = ".settings";
const KEY_ENABLED = "updater.proxy_enabled";
const KEY_URL = "updater.proxy_url";

// Module-level cache: one shared Store handle for the lifetime of the page.
// Concurrent first-callers all await the same in-flight load promise.
let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    // autoSave: false — we flush explicitly in saveUpdaterSettings; reads
    // never mutate, so the default 100ms debounce is unnecessary overhead.
    // `defaults: {}` is required by StoreOptions in plugin-store v2.4.x; an
    // empty object keeps the store file as the source of truth (our read
    // coercion handles missing keys).
    storePromise = load(STORE_PATH, { autoSave: false, defaults: {} });
    // If the load rejects (e.g. plugin unavailable), drop the cached promise
    // so the next caller gets a fresh attempt instead of a sticky failure.
    storePromise.catch(() => {
      storePromise = null;
    });
  }
  return storePromise;
}

/**
 * Load the updater proxy settings, coerced to safe defaults.
 *
 * Never returns an empty `proxyUrl` — empty/whitespace stored values fall
 * back to {@link DEFAULT_UPDATER_PROXY_URL}. Does NOT mutate the store.
 */
export async function loadUpdaterSettings(): Promise<UpdaterSettings> {
  const store = await getStore();
  const enabledRaw = await store.get<boolean>(KEY_ENABLED);
  const urlRaw = await store.get<string>(KEY_URL);

  const proxyUrl =
    typeof urlRaw === "string" && urlRaw.trim().length > 0
      ? urlRaw
      : DEFAULT_UPDATER_PROXY_URL;

  return {
    proxyEnabled: enabledRaw ?? false,
    proxyUrl,
  };
}

/**
 * Persist both settings keys and flush the store to disk.
 *
 * If `proxyUrl` is empty/whitespace, persists {@link DEFAULT_UPDATER_PROXY_URL}
 * instead — an empty URL must never reach disk (it would silently break the
 * next startup's check).
 */
export async function saveUpdaterSettings(s: UpdaterSettings): Promise<void> {
  const store = await getStore();
  const proxyUrl =
    typeof s.proxyUrl === "string" && s.proxyUrl.trim().length > 0
      ? s.proxyUrl
      : DEFAULT_UPDATER_PROXY_URL;
  await store.set(KEY_ENABLED, s.proxyEnabled);
  await store.set(KEY_URL, proxyUrl);
  await store.save();
}
