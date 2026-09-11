// Phase 23 (23-02, D-03 / CONTRACT-02): the geometry oracle — the canonical
// `measure()` bounds walk ported verbatim from check-code-preview.cjs:40
// (reference copy lives with the canonical assets; the canonical checker
// itself is user-local and NEVER executed by this repo). Extended to Radix
// portal roots appended to document.body.
//
// Canonical semantics, ported verbatim (T-23-07 — do not weaken):
//   filter:   element width > 0 AND (left < root.left - 1 OR right > root.right + 1
//             OR bottom > root.bottom + 1) — left/right/bottom only, ±1px
//             tolerance. The canonical routine deliberately does NOT check top
//             (root-anchored layout); do not silently add it.
//   carve-out: elements inside a closed <details> are skipped, EXCEPT the
//             closed <details> element itself and any summary descendants —
//             `details:not([open])` kept verbatim.
//
// Portal extension (D-03): Radix Dialog/Tooltip/Popover portals append to
// document.body, outside the app root. Every document.body child that does
// NOT contain the app root contributes its descendants to the walk;
// portal-origin elements are bounds-checked against the VIEWPORT
// (0..innerWidth / 0..innerHeight) instead of the root rect, since portals
// live outside it.
//
// 32px preview-wrapper normalization (D-03, mandatory documentation):
//   Canonical captures were taken with the preview widget inside a wrapper —
//   a canonical 1056px viewport contains a 1024px widget. The repo harness
//   measures the app root directly — a repo capture at viewport 1056 contains
//   a 1056px app. Baseline comparisons AGAINST canonical captures must
//   account for this 32px delta; repo-to-repo comparisons are unaffected.
//
// Zero-tolerance policy (D-04): this oracle is font-agnostic and stays strict
// forever. Visual (pixel) tolerances may loosen in later phases; geometry
// never waives — a pixel-baseline approval can never green a bounds failure.
import type { Page } from "@playwright/test";

/** Result of one oracle run over the live DOM (root tree + portal trees). */
export interface BoundsReport {
  /** Identifiers (id / className / <tag>, truncated) of out-of-bounds visible elements. */
  outside: string[];
  /** Total number of elements walked (root tree + portal trees). */
  checked: number;
}

/**
 * Run the ported canonical bounds walk in the page. Assert-empty contract:
 * the caller expects `outside` to be `[]` for every combination (CONTRACT-02).
 */
export async function measureBounds(page: Page): Promise<BoundsReport> {
  return page.evaluate((): BoundsReport => {
    // Root = the filled child of #root (the app root), not the canonical
    // #ugs-code widget — see the 32px normalization note above.
    const root = document.querySelector("#root > *");
    if (!root) {
      return { outside: ["#root > * missing — app not mounted"], checked: 0 };
    }
    const rr = root.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Root-tree candidates: the canonical walk.
    const rootCandidates: Element[] = [...root.querySelectorAll("*")];

    // Portal-tree candidates: body children outside the app root's subtree
    // (Radix portals). The portal root element itself is included too.
    const portalCandidates: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === root || child.contains(root)) continue;
      portalCandidates.push(child, ...child.querySelectorAll("*"));
    }

    const identify = (e: Element): string => {
      const cls = typeof e.className === "string" ? e.className : "";
      return (e.id || cls || `<${e.tagName.toLowerCase()}>`).slice(0, 80);
    };

    // One predicate, parameterized by the reference rect: the root rect for
    // root-tree elements, the viewport rect for portal-origin elements.
    const isOutside = (
      e: Element,
      left: number,
      right: number,
      bottom: number,
    ): boolean => {
      // Canonical carve-out, verbatim: skip descendants of a closed
      // <details>; the closed element itself and summary descendants stay.
      const closed = e.closest("details:not([open])");
      if (closed && e !== closed && !e.closest("summary")) return false;
      const r = e.getBoundingClientRect();
      return (
        r.width > 0 &&
        (r.left < left - 1 || r.right > right + 1 || r.bottom > bottom + 1)
      );
    };

    const outside = [
      ...rootCandidates.filter((e) => isOutside(e, rr.left, rr.right, rr.bottom)),
      ...portalCandidates.filter((e) => isOutside(e, 0, vw, vh)),
    ].map(identify);

    return {
      outside,
      checked: rootCandidates.length + portalCandidates.length,
    };
  });
}
