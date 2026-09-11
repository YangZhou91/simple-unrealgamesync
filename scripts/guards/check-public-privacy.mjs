#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|icns|avif|svg)$/i;
const DEMO_USER = /^(alice|bob|demo|example|fixture|test|user|username|you|public|default|<[^>]+>)$/i;
const DEMO_DEPOT = /^(demo\w*|example\w*|fixture\w*|test\w*|depot|mygame|project|mydepot|stream|client(?:_name)?|<[^>]+>)$/i;

export function isPrivateFile(file) {
  const normalized = file.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  return /(^|\/)(?:\.git|\.planning|\.claude|\.codex|\.gsd|\.agents)(\/|$)/i.test(normalized)
    || /^(?:\.settings|\.p4tickets|\.p4trust|\.mcp\.json|\.npmrc|\.netrc)$/i.test(basename)
    || (/^\.env(?:\.|$)/i.test(basename) && basename !== ".env.example")
    || /\.(?:key(?:\.pub)?|pem|p12|pfx)$/i.test(basename);
}

/** Generic policy: fictional profile users and demo depot roots only.
 * No path exemptions; credentials and key material are reported without values.
 * Tests needing unsafe strings must construct synthetic values at runtime.
 */
export function scanText(text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const normalized = line.replace(/\\+/g, "/");
    const add = rule => findings.push({ line: index + 1, rule });
    for (const match of normalized.matchAll(/\b[A-Za-z]:\/Users\/([^/\s"'`]+)/gi)) {
      if (!DEMO_USER.test(match[1])) add("personal-profile-path");
    }
    if (/[a-z][a-z0-9+.-]*:\/\/[^\s/"'<>]+@/i.test(line)) add("credential-url");
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(line) || /^untrusted comment: .*secret key/i.test(line)) add("private-key");
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{32,})\b/.test(line)) add("secret-token");
    for (const match of line.matchAll(/(?:^|[\s"'`(=])\/\/([A-Za-z][\w.-]*)\//g)) {
      if (!DEMO_DEPOT.test(match[1])) add("non-demo-depot");
    }
    if (/\b(?:Art|Dev)_Stream_UGS_[A-Za-z0-9_]+\b/i.test(line)) add("non-demo-workspace");
  }
  return findings;
}

export function trackedFiles(root = ROOT) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

export function submissionFiles(root = ROOT) {
  const untracked = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  return [...new Set([...trackedFiles(root), ...untracked])].sort();
}

export function checkImages(images, entries, read) {
  const issues = [], seen = new Map();
  for (const entry of entries) {
    if (seen.has(entry.path)) issues.push(`${entry.path}: duplicate-image-review`);
    seen.set(entry.path, entry.sha256);
    if (!images.includes(entry.path)) issues.push(`${entry.path}: missing-image`);
  }
  for (const file of images) {
    if (!seen.has(file)) issues.push(`${file}: unreviewed-image`);
    else {
      try {
        const hash = createHash("sha256").update(read(file)).digest("hex");
        if (hash !== seen.get(file)) issues.push(`${file}: image-review-mismatch`);
      } catch { issues.push(`${file}: unreadable-image`); }
    }
  }
  return issues;
}

export function checkPublicPrivacy(root = ROOT) {
  const files = submissionFiles(root), issues = [], images = [];
  if (!files.length) issues.push("submission: empty-inventory");
  for (const file of files) {
    try {
      const bytes = fs.readFileSync(path.join(root, file));
      if (IMAGE.test(file)) images.push(file);
      if (!bytes.includes(0)) for (const finding of scanText(bytes.toString("utf8"))) issues.push(`${file}:${finding.line}: ${finding.rule}`);
      else if (!IMAGE.test(file)) issues.push(`${file}: unreviewed-binary-file`);
      if (isPrivateFile(file)) issues.push(`${file}: private-file-in-submission`);
    } catch { issues.push(`${file}: unreadable-tracked-file`); }
  }
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(root, "scripts/guards/reviewed-images.json"), "utf8"));
    issues.push(...checkImages(images, entries, file => fs.readFileSync(path.join(root, file))));
  } catch { issues.push("scripts/guards/reviewed-images.json: invalid-or-missing-manifest"); }
  return { ok: issues.length === 0, issues, fileCount: files.length, imageCount: images.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPublicPrivacy();
  for (const issue of result.issues) console.error(issue);
  console.log(`Privacy: ${result.ok ? "PASS" : "FAIL"}; ${result.fileCount} files, ${result.imageCount} images`);
  process.exitCode = result.ok ? 0 : 1;
}
