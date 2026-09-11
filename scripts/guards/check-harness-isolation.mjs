#!/usr/bin/env node
/**
 * check-harness-isolation.mjs — Phase 23 (23-04) mechanical isolation +
 * portability guard. SC#4 and the D-01/D-02 production-isolation decisions as
 * executable checks that fail loudly on violation.
 *
 * Dependency-free, Windows-safe: pure node fs + path walking, no grep/quoting
 * hazards, no child processes. Wired as `npm run check:harness`.
 *
 * Seven checks (each a named function):
 *
 *   1. PRODUCTION IMPORT FIREWALL — no file under src/ contains a module
 *      specifier resolving into tests/visual (import/export-from, dynamic
 *      import, require). D-02: the harness is never imported by production.
 *   2. TSCONFIG BOUNDARY — root tsconfig.json `include` is exactly ["src"] so
 *      the production typecheck (npm run build → tsc) never swallows the
 *      harness tree. Harness-tree tsc coverage lives in tsconfig.visual.json.
 *   3. ENTRY BOUNDARY — index.html references /src/main.tsx as its module
 *      script and no other entry. D-01: the production entry stays untouched
 *      (the harness has its own tests/visual/harness.html).
 *   4. FIXTURE CONSTANTS STAY TEST DATA — the canonical fixture CL literals
 *      (381700 / 381204, recorded in REQUIREMENTS/CONTEXT as test-only data)
 *      appear in no file under src/. T-23-05.
 *   5. PUBLIC PRIVACY — all tracked and intended submission files, including
 *      canonical references and scripts, use the shared generic privacy policy.
 *      Image bytes must match the explicitly reviewed manifest.
 *
 * Phase 24 (24-01) additions — SHELL-01's invariants as executable checks:
 *
 *   6. ZERO COMPONENT-LOCAL COLOR LITERALS — no .tsx file under src/
 *      (excluding __tests__ directories, whose intentional literals track
 *      production class renames) contains an arbitrary color literal
 *      (hsl(/rgb(/#hex) or a raw Tailwind palette utility (bg-sky-400,
 *      text-amber-300, ...). src/index.css is the single token source and is
 *      NOT scanned (.tsx only). UI-SPEC Color Contract / "the grep is the
 *      contract".
 *   7. COLOR-SCHEME BOTH SCHEMES — src/index.css declares
 *      `color-scheme: light dark`; without it the light-dark() tokens
 *      silently stick to one scheme (24-RESEARCH Pitfall 1).
 *
 * Self-test: `node scripts/guards/check-harness-isolation.mjs --self-test` runs
 * every check against in-memory violating + clean fixtures and asserts each
 * discriminates correctly — the guard proves itself without touching the tree
 * (T-23-10 guard-rot mitigation).
 *
 * Exit codes: 0 = all checks pass (or all self-tests pass), 1 = any failure.
 */

import { scanText, checkPublicPrivacy } from "./check-public-privacy.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Shared generic privacy policy is imported above; no directory exemptions.

// Fixture CL literals (check 4) — test-only data per REQUIREMENTS/CONTEXT.
const FIXTURE_CL_LITERALS = ["381700", "381204"];

// Text file extensions whose content check 1/4/5 inspects.
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".html",
  ".css",
  ".md",
  ".txt",
  ".svg",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".results", // playwright outputDir (gitignored, generated)
  "target",
]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Recursively collect files under `dirRel` (repo-relative). */
function collectFiles(dirRel) {
  const abs = path.join(REPO_ROOT, dirRel);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(d, entry.name));
      } else {
        out.push(path.join(d, entry.name));
      }
    }
  };
  visit(abs);
  return out;
}

/** Repo-relative, forward-slash-normalized path for reporting. */
function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join("/");
}

function readText(f) {
  return fs.readFileSync(f, "utf8");
}

// ---------------------------------------------------------------------------
// Check 1: PRODUCTION IMPORT FIREWALL (D-02)
// ---------------------------------------------------------------------------

// Module specifiers that resolve into tests/visual: relative paths containing
// a tests/visual path segment, or absolute-from-root /tests/visual forms.
const IMPORT_SPECIFIER_RE =
  /(?:^|[^A-Za-z0-9_$])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Extract every static import / export-from, dynamic import(), and require()
 * specifier from `source`. Conservative: also matches bare `from "..."`
 * fragments of export statements via the first alternative.
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  const specs = [];
  const re = new RegExp(IMPORT_SPECIFIER_RE.source, "g");
  let m;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** True when a module specifier resolves into the tests/visual tree. */
export function specifierTargetsHarness(spec) {
  const norm = spec.split(path.sep).join("/");
  // relative or aliased forms that traverse into tests/visual
  if (/(^|\/)tests\/visual(\/|$)/.test(norm)) return true;
  return false;
}

/**
 * @returns {{ok: boolean, offenders: string[]}} — offenders as
 * "file → specifier" strings.
 */
export function checkProductionImportFirewall(readFile = readText, files = null) {
  const offenders = [];
  const srcFiles = files ?? collectFiles("src");
  for (const f of srcFiles) {
    if (!TEXT_EXT.has(path.extname(f))) continue;
    const specs = extractImportSpecifiers(readFile(f));
    for (const spec of specs) {
      if (specifierTargetsHarness(spec)) {
        offenders.push(`${rel(f)} → "${spec}"`);
      }
    }
  }
  return { ok: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------------------
// Check 2: TSCONFIG BOUNDARY
// ---------------------------------------------------------------------------

/**
 * @param {string} [tsconfigRaw] — override for self-test.
 * @returns {{ok: boolean, offenders: string[]}}
 */
export function checkTsconfigBoundary(tsconfigRaw = null) {
  const offenders = [];
  let raw;
  if (tsconfigRaw !== null) {
    raw = tsconfigRaw;
  } else {
    const f = path.join(REPO_ROOT, "tsconfig.json");
    if (!fs.existsSync(f)) {
      return { ok: false, offenders: ["tsconfig.json missing"] };
    }
    raw = readText(f);
  }
  let cfg;
  try {
    // tsconfig.json allows comments; strip them conservatively before parse.
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    cfg = JSON.parse(stripped);
  } catch {
    return { ok: false, offenders: ["tsconfig.json is not parseable JSON"] };
  }
  const include = cfg.include;
  const expected = ["src"];
  const ok =
    Array.isArray(include) &&
    include.length === expected.length &&
    include.every((v, i) => v === expected[i]);
  if (!ok) {
    offenders.push(
      `tsconfig.json include is ${JSON.stringify(include)} — expected exactly ${JSON.stringify(expected)}`,
    );
  }
  return { ok: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------------------
// Check 3: ENTRY BOUNDARY (D-01)
// ---------------------------------------------------------------------------

const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * @param {string} [htmlRaw] — override for self-test.
 * @returns {{ok: boolean, offenders: string[]}}
 */
export function checkEntryBoundary(htmlRaw = null) {
  const offenders = [];
  let raw;
  if (htmlRaw !== null) {
    raw = htmlRaw;
  } else {
    const f = path.join(REPO_ROOT, "index.html");
    if (!fs.existsSync(f)) {
      return { ok: false, offenders: ["index.html missing"] };
    }
    raw = readText(f);
  }
  const srcs = [];
  const re = new RegExp(SCRIPT_SRC_RE.source, "gi");
  let m;
  while ((m = re.exec(raw)) !== null) srcs.push(m[1]);
  const moduleSrcs = srcs; // only <script src=...> entries matter here
  const ok =
    moduleSrcs.length === 1 && moduleSrcs[0] === "/src/main.tsx";
  if (!ok) {
    offenders.push(
      `index.html script sources are ${JSON.stringify(moduleSrcs)} — expected exactly ["/src/main.tsx"]`,
    );
  }
  return { ok: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------------------
// Check 4: FIXTURE CONSTANTS STAY TEST DATA (T-23-05)
// ---------------------------------------------------------------------------

/**
 * @param {Function} [readFile]
 * @param {string[]|null} [files]
 * @returns {{ok: boolean, offenders: string[]}}
 */
export function checkFixtureConstantsStayTestData(readFile = readText, files = null) {
  const offenders = [];
  const srcFiles = files ?? collectFiles("src");
  for (const f of srcFiles) {
    const ext = path.extname(f);
    if (!TEXT_EXT.has(ext) && ext !== ".rs" && ext !== ".toml") continue;
    const c = readFile(f);
    for (const lit of FIXTURE_CL_LITERALS) {
      if (c.includes(lit)) {
        offenders.push(`${rel(f)} contains fixture CL literal ${lit}`);
      }
    }
  }
  return { ok: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------------------
// Check 5: NO USER-LOCAL PATHS (T-23-04 / SC#4)
// ---------------------------------------------------------------------------

/**
 * @param {Function} [readFile]
 * @param {Function} [collect] — dirRel → absolute file list (overridable for
 *   self-test).
 * @returns {{ok: boolean, offenders: string[]}}
 */
export function checkNoUserLocalPaths(readFile = readText, collect = null) {
  if (!collect) {
    const result = checkPublicPrivacy(REPO_ROOT);
    return { ok: result.ok, offenders: result.issues };
  }
  const offenders = [];
  for (const root of ["src", "tests"]) {
    for (const f of collect(root)) {
      for (const hit of scanText(readFile(f))) offenders.push(`${rel(f)}:${hit.line}: ${hit.rule}`);
    }
  }
  return { ok: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------------------
// Check 6: ZERO COMPONENT-LOCAL COLOR LITERALS (Phase 24, SHELL-01)
// ---------------------------------------------------------------------------

// Component-local theme literals: arbitrary color functions/values AND raw
// Tailwind palette utility prefixes. Module-level const, fresh RegExp per
// call (existing pattern — see extractImportSpecifiers).
const COLOR_LITERAL_RE =
  /hsl\(|rgb\(|#[0-9a-fA-F]{3,8}\b|(?:bg|text|border|ring|outline|decoration|divide|fill|stroke|accent|caret|from|via|to)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-/g;

/**
 * Scan every .tsx file under src/ EXCLUDING any path containing __tests__
 * (test files carry intentional literals that track production class
 * renames). src/index.css is the exempt single token source (.tsx only —
 * never scanned here).
 * @param {Function} [readFile]
 * @param {string[]|null} [files] — src tree override for self-test; .tsx
 *   filtering and __tests__ exclusion apply to it either way.
 * @returns {{ok: boolean, offenders: string[]}} — offenders as
 *   "file:line → matched-text" strings.
 */
export function checkNoComponentColorLiterals(
  readFile = readText,
  files = null,
) {
  const offenders = [];
  const candidates = (files ?? collectFiles("src")).filter(
    (f) => f.endsWith(".tsx") && !rel(f).includes("__tests__"),
  );
  const re = new RegExp(COLOR_LITERAL_RE.source, "g");
  for (const f of candidates) {
    const lines = readFile(f).split("\n");
    lines.forEach((line, i) => {
      const m = line.match(re);
      if (m) offenders.push(`${rel(f)}:${i + 1} → ${m.join(" | ")}`);
    });
  }
  return { ok: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------------------
// Check 7: COLOR-SCHEME BOTH SCHEMES (Phase 24, SHELL-01 / research Pitfall 1)
// ---------------------------------------------------------------------------

/**
 * src/index.css must include `color-scheme: light dark` — the one-line flip
 * that gates light-dark() switching; its absence silently pins every token to
 * a single scheme (24-RESEARCH Q5 / Pitfall 1).
 * @param {Function} [readFile]
 * @returns {{ok: boolean, offenders: string[]}} — the offender string quotes
 *   the file's actual color-scheme value (or its absence).
 */
export function checkColorSchemeBothSchemes(readFile = readText) {
  const offenders = [];
  const css = readFile(path.join(REPO_ROOT, "src", "index.css"));
  if (!css.includes("color-scheme: light dark")) {
    const m = css.match(/color-scheme:\s*[^;]+;/);
    offenders.push(
      `src/index.css ${m ? `declares ${JSON.stringify(m[0])}` : "has no color-scheme declaration"} — expected "color-scheme: light dark"`,
    );
  }
  return { ok: offenders.length === 0, offenders };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    id: 1,
    name: "PRODUCTION IMPORT FIREWALL",
    run: () => checkProductionImportFirewall(),
  },
  { id: 2, name: "TSCONFIG BOUNDARY", run: () => checkTsconfigBoundary() },
  { id: 3, name: "ENTRY BOUNDARY", run: () => checkEntryBoundary() },
  {
    id: 4,
    name: "FIXTURE CONSTANTS STAY TEST DATA",
    run: () => checkFixtureConstantsStayTestData(),
  },
  { id: 5, name: "NO USER-LOCAL PATHS", run: () => checkNoUserLocalPaths() },
  {
    id: 6,
    name: "ZERO COMPONENT-LOCAL COLOR LITERALS",
    run: () => checkNoComponentColorLiterals(),
  },
  {
    id: 7,
    name: "COLOR-SCHEME BOTH SCHEMES",
    run: () => checkColorSchemeBothSchemes(),
  },
];

export function runAllChecks() {
  const results = [];
  for (const check of CHECKS) {
    results.push({ id: check.id, name: check.name, ...check.run() });
  }
  return results;
}

function main() {
  const results = runAllChecks();
  let failed = 0;
  for (const r of results) {
    const status = r.ok ? "pass" : "FAIL";
    console.log(`[${status}] check ${r.id}: ${r.name}`);
    if (!r.ok) {
      failed++;
      for (const off of r.offenders) console.log(`        ${off}`);
    }
  }
  if (failed > 0) {
    console.error(
      `\ncheck-harness-isolation: ${failed} of ${results.length} checks FAILED`,
    );
    process.exit(1);
  }
  console.log(
    `\ncheck-harness-isolation: all ${results.length} checks pass`,
  );
}

// ---------------------------------------------------------------------------
// Self-test (T-23-10): prove each check discriminates violating vs clean
// in-memory fixtures, without touching the tree.
// ---------------------------------------------------------------------------

function selfTest() {
  let failures = 0;

  const expect = (label, cond) => {
    console.log(`[${cond ? "pass" : "FAIL"}] self-test: ${label}`);
    if (!cond) failures++;
  };

  // --- check 1 fixtures -----------------------------------------------------
  const violatingSrc = `import { setView } from "../../tests/visual/fixtures/controller";
const x = await import("/tests/visual/main.tsx");
module.exports = require("./tests/visual/tauri-mock");`;
  const cleanSrc = `import { useSync } from "@/hooks/useSync";
import React from "react";
const dyn = () => import("./lazy/panel");`;
  let r1v = checkProductionImportFirewall(
    () => violatingSrc,
    ["src/App.tsx"],
  );
  let r1c = checkProductionImportFirewall(() => cleanSrc, ["src/App.tsx"]);
  expect(
    "check 1 flags harness imports in src/",
    !r1v.ok && r1v.offenders.length === 3,
  );
  expect("check 1 passes clean src/", r1c.ok);

  // --- check 2 fixtures -----------------------------------------------------
  const violatingTs = '{"include": ["src", "tests"]}';
  const cleanTs = '{\n  // production only\n  "include": ["src"]\n}';
  expect(
    "check 2 flags widened tsconfig include",
    !checkTsconfigBoundary(violatingTs).ok,
  );
  expect(
    "check 2 passes include=[src] (with comments)",
    checkTsconfigBoundary(cleanTs).ok,
  );

  // --- check 3 fixtures -----------------------------------------------------
  const violatingHtml =
    '<script type="module" src="/tests/visual/main.tsx"></script>';
  const cleanHtml =
    '<div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>';
  const twoEntries =
    '<script type="module" src="/src/main.tsx"></script>\n<script type="module" src="/src/extra.tsx"></script>';
  expect(
    "check 3 flags harness entry in index.html",
    !checkEntryBoundary(violatingHtml).ok,
  );
  expect("check 3 passes /src/main.tsx only", checkEntryBoundary(cleanHtml).ok);
  expect(
    "check 3 flags a second script entry",
    !checkEntryBoundary(twoEntries).ok,
  );

  // --- check 4 fixtures -----------------------------------------------------
  const violatingConst = "const TARGET_CL = 381700;";
  const cleanConst = "const TARGET_CL = Number(userInput);";
  expect(
    "check 4 flags fixture CL literal in src/",
    !checkFixtureConstantsStayTestData(
      () => violatingConst,
      ["src/const.ts"],
    ).ok,
  );
  expect(
    "check 4 passes src/ without the literals",
    checkFixtureConstantsStayTestData(() => cleanConst, ["src/const.ts"]).ok,
  );

  // --- check 5 fixtures -----------------------------------------------------
  const fakeTree = [
    path.join(REPO_ROOT, "src", "main.tsx"),
    path.join(REPO_ROOT, "tests", "visual", "spec.ts"),
    path.join(REPO_ROOT, "tests", "visual", "canonical", "check-code-preview.cjs"),
  ];
  const contents = new Map([
    [
      path.join(REPO_ROOT, "src", "main.tsx"),
      "const clean = 1; // no local paths",
    ],
    [
      path.join(REPO_ROOT, "tests", "visual", "spec.ts"),
      ["C:", "Users", "private-person", "cache"].join("/"),
    ],
    [
      path.join(REPO_ROOT, "tests", "visual", "canonical", "check-code-preview.cjs"),
      ["C:", "Users", "private-person", "cache"].join("/"),
    ],
  ]);
  const readFixture = (f) => contents.get(f) ?? "";
  // Root-aware fake collector: src/ pass sees no files, tests/ pass sees the
  // tree — mirrors collectFiles semantics (no double-counting).
  const collectFixture = (root) =>
    root === "tests" ? fakeTree : [];
  const r5 = checkNoUserLocalPaths(readFixture, collectFixture);
  expect(
    "check 5 flags generic private paths including canonical/",
    !r5.ok &&
      r5.offenders.length === 2 &&
      r5.offenders[0].includes("tests/visual/spec.ts"),
  );
  const cleanContents = new Map([
    [path.join(REPO_ROOT, "src", "main.tsx"), "clean"],
    [path.join(REPO_ROOT, "tests", "visual", "spec.ts"), "clean"],
    [
      path.join(REPO_ROOT, "tests", "visual", "canonical", "check-code-preview.cjs"),
      `C:/Users/alice/demo`,
    ],
  ]);
  expect(
    "check 5 passes a clean tree",
    checkNoUserLocalPaths(
      (f) => cleanContents.get(f) ?? "",
      collectFixture,
    ).ok,
  );

  // --- check 6 fixtures -----------------------------------------------------
  const violatingTsxSrc = `const cls = "bg-[hsl(0,0%,9%)] text-sky-400";
const fg = "#fff";`;
  const cleanTsxSrc = `const cls = "bg-well text-success";
const tint = "bg-accent/15 text-info border-success/20";`;
  const r6v = checkNoComponentColorLiterals(() => violatingTsxSrc, [
    path.join(REPO_ROOT, "src", "components", "Panel.tsx"),
  ]);
  expect(
    "check 6 flags color literals in production tsx with file:line offenders",
    !r6v.ok &&
      r6v.offenders.length === 2 &&
      r6v.offenders[0].includes("src/components/Panel.tsx:1") &&
      r6v.offenders[1].includes("src/components/Panel.tsx:2"),
  );
  const r6c = checkNoComponentColorLiterals(
    (f) => (f.endsWith("X.test.tsx") ? violatingTsxSrc : cleanTsxSrc),
    [
      path.join(REPO_ROOT, "src", "components", "Panel.tsx"),
      path.join(REPO_ROOT, "src", "components", "__tests__", "X.test.tsx"),
    ],
  );
  expect(
    "check 6 passes clean tsx and ignores __tests__-path literals",
    r6c.ok,
  );

  // --- check 7 fixtures -----------------------------------------------------
  const violatingCss = ":root {\n  color-scheme: dark;\n}";
  const cleanCss = ":root {\n  color-scheme: light dark;\n}";
  const r7v = checkColorSchemeBothSchemes(() => violatingCss);
  expect(
    "check 7 flags color-scheme: dark (quotes the actual value)",
    !r7v.ok && r7v.offenders[0].includes("color-scheme: dark"),
  );
  expect(
    "check 7 passes color-scheme: light dark",
    checkColorSchemeBothSchemes(() => cleanCss).ok,
  );
  expect(
    "check 7 flags a missing color-scheme declaration",
    !checkColorSchemeBothSchemes(() => "body { margin: 0; }").ok,
  );
  if (failures > 0) {
    console.error(
      `\ncheck-harness-isolation --self-test: ${failures} self-test(s) FAILED`,
    );
    process.exit(1);
  }
  console.log(
    "\ncheck-harness-isolation --self-test: all check functions discriminate correctly",
  );
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  main();
}
