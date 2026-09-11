#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Exercise the real shared config in both modes with synthetic files only.
const configFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vite.config.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ugs-dev-privacy-"));
const privateFiles = ["fixture.key", "fixture.pem", ".settings", ".env", ".env.local", ".p4tickets", ".planning/fixture.txt", ".claude/fixture.txt", ".codex/fixture.txt", ".gsd/fixture.txt", ".git/fixture.txt", ".agents/fixture.txt", "AGENTS.md", "CLAUDE.md", ".mcp.json"];
const sentinel = "synthetic-private-sentinel-do-not-serve";
for (const file of privateFiles) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), sentinel);
}
fs.writeFileSync(path.join(root, "public.txt"), "public-fixture");
let count = 0;
try {
  for (const mode of ["development", "harness"]) {
    const server = await createServer({ configFile, root, mode, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, fs: { allow: [root] } } });
    try {
      await server.listen();
      const address = server.httpServer.address();
      const base = `http://127.0.0.1:${address.port}`;
      assert.equal(await (await fetch(`${base}/public.txt`)).text(), "public-fixture");
      for (const file of privateFiles) {
        const absolute = path.join(root, file).replaceAll("\\", "/");
        for (const route of [`/${file}`, `/@fs/${absolute}`]) {
          for (const query of ["", "?raw"]) {
            const response = await fetch(base + route + query);
            const body = await response.text();
            assert.ok([403, 404].includes(response.status), `${mode}: ${file}: unexpected status ${response.status}`);
            assert.ok(!body.includes(sentinel), `${mode}: ${file}: sentinel disclosed`);
            count++;
          }
        }
      }
    } finally { await server.close(); }
  }
  console.log(`Dev privacy: PASS (${count} denied requests, both modes; public control served)`);
} finally {
  // Remove only files created above; retain the isolated directory for diagnosis.
  for (const file of [...privateFiles, "public.txt"]) fs.unlinkSync(path.join(root, file));
}
