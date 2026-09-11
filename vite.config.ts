import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { gitChangelogPlugin } from "./vite-plugin-git-changelog";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// Phase 23 (23-01, D-01): the Playwright harness boots the dev server with
// `--mode harness` to serve tests/visual/harness.html. In that mode the
// changelog virtual module is stubbed with an empty export — real git-log
// content is clone-state-dependent and would churn geometry and baselines.
// Mirrors the virtual-changelog-stub precedent already in vitest.config.ts.
// Every other mode (dev/build/preview) keeps the real gitChangelogPlugin —
// zero change to production dev/build paths.
function harnessChangelogStub(): Plugin {
  const VIRTUAL_MODULE_ID = "virtual:changelog";
  const RESOLVED_ID = "\0" + VIRTUAL_MODULE_ID;
  return {
    name: "harness-changelog-stub",
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id === RESOLVED_ID) return "export const changelog = [];";
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    mode === "harness" ? harnessChangelogStub() : gitChangelogPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: {
      // Preserve Vite defaults, extending them for local desktop-app artifacts.
      strict: true,
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**",
        "**/*.{key,p12,pfx}", "**/.settings", "**/.p4tickets", "**/.p4trust",
        "**/.planning/**", "**/.claude/**", "**/.codex/**", "**/.gsd/**",
        "**/.agents/**", "**/AGENTS.md", "**/CLAUDE.md", "**/.mcp.json"],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
