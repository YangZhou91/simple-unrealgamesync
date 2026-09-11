import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({ ...base, testDir: "./tests/visual", testMatch: "capture-docs.ts" });
