import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const HAN = /\p{Script=Han}/u;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// this file is src/lib/__tests__/cjkGate.test.ts, so ../.. is src/.

describe("GATE-01 no Han outside src/lib/i18n/", () => {
  it("fails on any Han literal in src/ except the dictionary module", () => {
    const hits: string[] = [];
    const skip = path.join(SRC, "lib", "i18n");
    const stack = [SRC];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (p === skip || p.startsWith(skip + path.sep)) continue;
          stack.push(p);
          continue;
        }
        if (!/\.(ts|tsx|css)$/.test(ent.name)) continue;
        const lines = readFileSync(p, "utf8").split(/\n/);
        lines.forEach((line, i) => {
          if (HAN.test(line)) hits.push(`${path.relative(SRC, p)}:${i + 1}`);
        });
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
