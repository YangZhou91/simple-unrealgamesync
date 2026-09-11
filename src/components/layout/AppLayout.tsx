import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  clampSidebarWidth,
  loadSidebarWidthIntent,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH,
  saveSidebarWidth,
} from "@/lib/sidebarWidth";
import { useT } from "@/lib/i18n";

interface AppLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppLayout({ sidebar, children }: AppLayoutProps) {
  const { t } = useT();
  const initialIntentRef = useRef<number | null>(null);
  if (initialIntentRef.current === null) {
    initialIntentRef.current = loadSidebarWidthIntent();
  }
  const [width, setWidth] = useState(() =>
    clampSidebarWidth(initialIntentRef.current!),
  );
  const widthRef = useRef(width);
  // 24-03 (SHELL-04): the user's width intent — pointer/keyboard resizes and
  // the persisted value only. A breakpoint crossing re-clamps the APPLIED
  // width (a <=620 viewport floors it at MIN via the 40% rule) but must never
  // destructively narrow the intent, or the persisted width would not restore
  // above 620 (must_haves; reflow.spec sidebar-width-persists probe).
  const userWidthRef = useRef(initialIntentRef.current!);
  const captureElRef = useRef<HTMLElement | null>(null);

  const applyWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    widthRef.current = clamped;
    userWidthRef.current = clamped;
    setWidth(clamped);
    return clamped;
  }, []);

  useEffect(() => {
    const onResize = () => {
      // Re-clamp the USER INTENT against the current viewport — never the
      // last applied width: clamping the applied value would let a narrow
      // crossing permanently shrink the sidebar (228 -> 180 with no way
      // back). saveSidebarWidth never fires here — only on user resize.
      const clamped = clampSidebarWidth(userWidthRef.current);
      widthRef.current = clamped;
      setWidth(clamped);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const target = event.currentTarget;
    captureElRef.current = target;

    if (typeof target.setPointerCapture === "function") {
      target.setPointerCapture(event.pointerId);
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      applyWidth(startWidth + moveEvent.clientX - startX);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      const el = captureElRef.current;
      if (el && typeof el.releasePointerCapture === "function") {
        try {
          el.releasePointerCapture(event.pointerId);
        } catch {
          // already released
        }
      }
      captureElRef.current = null;
      saveSidebarWidth(widthRef.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 8 : -8;
    const next = applyWidth(widthRef.current + delta);
    saveSidebarWidth(next);
  }

  const maxNow = clampSidebarWidth(MAX_SIDEBAR_WIDTH_PX);

  return (
    // 24-03 (SHELL-04): one tree, CSS-only reflow — the flex shell becomes a
    // column stack at <=620 (canonical's display:block for a flex parent),
    // sidebar stacks ABOVE main; >620 rendering is byte-identical.
    <div className="flex h-screen min-h-0 bg-background text-foreground narrow:flex-col">
      <aside
        // narrow:!w-auto — the inline style={{width}} beats classes, so the
        // !important utility is the override that stops the persisted px from
        // constraining the full-width stacked sidebar at <=620 (the inline
        // style still REPORTS the value; vitest style.width asserts stay
        // green). border flips right -> bottom per the canonical 620 block.
        className="relative shrink-0 overflow-hidden border-r border-border bg-sidebar narrow:!w-auto narrow:border-b narrow:border-r-0"
        style={{ width: `${width}px` }}
      >
        {sidebar}
        {/* narrow:hidden — no side-by-side width to resize below 620; the
            persisted width is untouched and restores above (intent ref). */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("layout.resizeAria")}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuenow={width}
          aria-valuemax={maxNow}
          tabIndex={0}
          className="absolute top-0 z-20 h-full w-3 cursor-col-resize bg-transparent hover:bg-accent/80 active:bg-accent narrow:hidden"
          style={{ right: "-6px" }}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
        />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden medium:px-[18px] narrow:px-[14px]">{children}</main>
    </div>
  );
}
