export const DEFAULT_SIDEBAR_WIDTH = 228;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH_PX = 420;
export const MAX_SIDEBAR_WIDTH_RATIO = 0.4;
export const SIDEBAR_WIDTH_STORAGE_KEY = "sugs.sidebarWidth";

const FALLBACK_VIEWPORT_WIDTH = 1100;

function resolveViewportWidth(viewportWidthPx?: number): number {
  if (typeof viewportWidthPx === "number" && Number.isFinite(viewportWidthPx)) {
    return viewportWidthPx;
  }
  if (typeof window !== "undefined" && Number.isFinite(window.innerWidth)) {
    return window.innerWidth;
  }
  return FALLBACK_VIEWPORT_WIDTH;
}

function clampSidebarIntent(widthPx: number): number {
  const rounded = Math.round(widthPx);
  if (!Number.isFinite(rounded)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.min(MAX_SIDEBAR_WIDTH_PX, Math.max(MIN_SIDEBAR_WIDTH, rounded));
}

export function clampSidebarWidth(
  widthPx: number,
  viewportWidthPx?: number,
): number {
  const viewport = resolveViewportWidth(viewportWidthPx);
  const upper = Math.min(
    MAX_SIDEBAR_WIDTH_PX,
    Math.floor(viewport * MAX_SIDEBAR_WIDTH_RATIO),
  );
  const max = upper < MIN_SIDEBAR_WIDTH ? MIN_SIDEBAR_WIDTH : upper;
  const rounded = Math.round(widthPx);
  if (!Number.isFinite(rounded)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, rounded));
}

export function loadSidebarWidthIntent(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw == null) {
      return DEFAULT_SIDEBAR_WIDTH;
    }
    return clampSidebarIntent(Number(raw));
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

export function loadSidebarWidth(): number {
  return clampSidebarWidth(loadSidebarWidthIntent());
}

export function saveSidebarWidth(widthPx: number): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampSidebarIntent(widthPx)),
    );
  } catch {
    // Private mode / quota must not abort a drag.
  }
}
