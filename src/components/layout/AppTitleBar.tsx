// Phase 24 (24-02, D-03 / SHELL-02): the app's custom titlebar — the ONLY
// new production component this phase. Native decorations are off
// (tauri.conf.json); drag is handled by Tauri's injected drag.js via the
// bare drag-region attribute on the bar container AND the title-text span
// (the bare attribute is SELF-ONLY — children do not inherit it). The three
// window-control buttons never carry the attribute: drag.js excludes
// clickable elements by construction, which is what keeps drag regions
// disjoint from controls (24-RESEARCH Q3).
//
// Geometry contract (24-UI-SPEC §6): fixed 34px row, horizontal 14px
// padding, 1px bottom border, bg-sidebar, 11px title, gap 9px → 7px at narrow.
// Controls NEVER hide at narrow widths — the title truncates instead
// (locked deviation from canonical's uc-chrome display:none).
//
// Button base (WorkspaceItem analog shape, NOT its dimensions): native
// button, 28x28 hit area (the UI-SPEC floor; the analog's 24px is below it),
// rounded-sm, focus ring via outline (canonical .btn:focus-visible
// — outline 2px var(--color-ring), offset 2px).
import { useMemo } from "react";
import { Minus, Square, X } from "lucide-react";
import appIcon from "@/assets/app-icon.png";
import { useT } from "@/lib/i18n";
import { APP_TITLE, getTitleBarControls } from "@/lib/windowControls";

export function AppTitleBar() {
  const { t } = useT();
  // Bind the adapter once per mount — avoids re-resolving the window
  // controls on every render (the methods close over the invoke calls).
  const controls = useMemo(() => getTitleBarControls(), []);

  return (
    <div
      data-titlebar="app"
      data-tauri-drag-region
      className="flex h-[34px] shrink-0 select-none items-center gap-[9px] border-b border-border bg-sidebar px-[14px] py-0 text-[11px] narrow:gap-[7px]"
    >
      <img
        src={appIcon}
        alt=""
        aria-hidden
        data-app-brand-icon
        className="h-4 w-4 shrink-0"
      />
      <span
        data-tauri-drag-region
        className="min-w-0 flex-1 truncate text-muted-foreground"
      >
        {APP_TITLE}
      </span>
      <div className="ml-auto flex items-center">
        <button
          type="button"
          aria-label={t("titlebar.minimize")}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-well hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          onClick={() => void controls.minimize()}
        >
          <Minus className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("titlebar.maximize")}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-well hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          onClick={() => void controls.toggleMaximize()}
        >
          <Square className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("titlebar.close")}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-well hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          onClick={() => void controls.close()}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
