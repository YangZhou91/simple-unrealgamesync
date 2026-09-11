import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "virtual-changelog-stub",
      resolveId(id) {
        if (id === "virtual:changelog") return "\0virtual:changelog";
      },
      load(id) {
        if (id === "\0virtual:changelog") {
          return "export const changelog = [];";
        }
      },
    },
  ],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Phase 23 (23-01): tests/** holds Playwright specs (both frameworks match
    // *.spec.ts) — exclude them so vitest never collects the visual harness.
    // Privacy guard tests use node:test and run in check:privacy/prebuild.
    exclude: [".claude/worktrees/**", "node_modules/**", "tests/**", "scripts/guards/*.test.mjs"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
