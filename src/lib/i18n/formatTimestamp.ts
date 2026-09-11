/**
 * Locale-sensitive date+time helper for Idle completed-time and History rows.
 *
 * Dependency-free: no React, no Tauri, no I/O — trivially unit-testable.
 * Passes app Locale "zh" | "en" unchanged (do not expand to zh-CN / en-US).
 * Duration h/m/s and empty glyphs stay out of this module.
 *
 * Phase 21 Plan 01 (SWEEP-02 / SC#2).
 */

import type { Locale } from "./index";

const OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "short",
  timeStyle: "short",
};

const cache = new Map<Locale, Intl.DateTimeFormat>();

export function formatTimestamp(ms: number, locale: Locale): string {
  if (!Number.isFinite(ms)) return "—";
  let fmt = cache.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, OPTIONS);
    cache.set(locale, fmt);
  }
  return fmt.format(new Date(ms));
}

/** Live `now_string()` is local "YYYY-MM-DD HH:MM:SS" with no T/Z. */
export function parseHistoryTimestamp(timestamp: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    timestamp,
  );
  if (!m) return null;
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(ms) ? ms : null;
}
