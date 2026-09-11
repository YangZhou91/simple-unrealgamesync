// Phase 23 (23-03, Pitfall 6 — tsc coverage of the harness tree): ambient
// declarations for the modules only the bundler (Vite) resolves at runtime.
// The root tsconfig covers src/ only; tsconfig.visual.json pulls in
// tests/visual + playwright.config.ts, and those transitively typecheck
// production modules whose imports the bundler satisfies outside tsc's view
// (virtual:changelog in production Sidebar.tsx, the CSS side-effect import in
// the harness entry). The production src/vite-env.d.ts declares the same
// virtual module for the root tsconfig; this copy exists so the visual-tree
// program sees an identical declaration without touching src/.
//
// Kept TEST-ONLY: this file is reachable only through tsconfig.visual.json
// (nothing under src/ imports it).

// CSS side-effect import (tests/visual/main.tsx `import("@/index.css")`).
declare module "*.css";

// vite-plugin-git-changelog virtual module (src/components/layout/Sidebar.tsx).
// Mirrors src/vite-env.d.ts verbatim (T-23-03: keep the two in sync).
declare module "virtual:changelog" {
  export interface CommitEntry {
    hash: string;
    date: string;
    subject: string;
  }
  export const changelog: CommitEntry[];
}
