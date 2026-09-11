import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { scanText, checkImages, trackedFiles, submissionFiles, checkPublicPrivacy, isPrivateFile } from "./check-public-privacy.mjs";

test("private filenames remain blocked even when force-added to Git", () => {
  for (const file of [".env", "config/.env.production", ".p4tickets", ".p4trust", ".npmrc", ".netrc", ".mcp.json", "signing.pfx", "signing.p12", "signing.key.pub", ".agents/notes.md", ".git/config"]) {
    assert.equal(isPrivateFile(file), true, file);
  }
  assert.equal(isPrivateFile(".env.example"), false);
  assert.equal(isPrivateFile("src-tauri/tauri.conf.json"), false);
});

test("non-image binary or UTF-16 files cannot silently bypass text review", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-binary-"));
  execFileSync("git", ["init", "--quiet", root]);
  fs.writeFileSync(path.join(root, "notes.txt"), Buffer.from("private fixture", "utf16le"));
  assert.ok(checkPublicPrivacy(root).issues.some(issue => issue.includes("unreviewed-binary-file")));
});

test("generic paths, credential URLs, private material and depot policy", () => {
  const user = "private-person";
  for (const separator of ["/", "\\", "\\\\"]) {
    assert.ok(scanText(["C:", "Users", user, "cache"].join(separator)).length);
  }
  assert.ok(scanText(["https://person", "private-password@example.test/repo"].join(":")).length);
  assert.ok(scanText(["-----BEGIN", "PRIVATE KEY-----"].join(" ")).length);
  assert.ok(scanText("ghp_" + "a".repeat(36)).length);
  assert.ok(scanText("//" + "PrivateStudio/Main/file.uasset").length);
  assert.ok(scanText("Art_" + "Stream_UGS_private-person").length);
  assert.deepEqual(scanText("C:/Users/alice/test //DemoDepot/Main/file.uasset https://github.com/YangZhou91/simple-unrealgamesync"), []);
});

test("index discovery includes staged additions, hidden files, canonical, scripts and spaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-guard-"));
  execFileSync("git", ["init", "--quiet", root]);
  const paths = [".hidden", "canonical/fixture.txt", "scripts/new file.mjs"];
  for (const file of paths) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "fixture");
  }
  execFileSync("git", ["-C", root, "add", "--", ...paths]);
  fs.writeFileSync(path.join(root, "local-only.txt"), "private");
  assert.deepEqual(trackedFiles(root).sort(), paths.sort());
  // Leave the isolated temp directory for inspection; never remove user paths.
});

test("image manifest is fail-closed for new, changed, missing and duplicate entries", () => {
  const bytes = Buffer.from("fixture image");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const read = () => bytes;
  const entry = { path: "image.png", sha256: hash };
  assert.deepEqual(checkImages(["image.png"], [entry], read), []);
  assert.ok(checkImages(["image.png"], [], read).length);
  assert.ok(checkImages(["image.png"], [{ ...entry, sha256: "0".repeat(64) }], read).length);
  assert.ok(checkImages([], [entry], read).length);
  assert.ok(checkImages(["image.png"], [entry, entry], read).length);
});

test("fresh index scans untracked submission and cannot pass an empty project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-fresh-"));
  execFileSync("git", ["init", "--quiet", root]);
  assert.equal(checkPublicPrivacy(root).ok, false);
  fs.writeFileSync(path.join(root, "new README.md"), ["C:", "Users", "private-person", "data"].join("/"));
  assert.deepEqual(submissionFiles(root), ["new README.md"]);
  assert.ok(checkPublicPrivacy(root).issues.some(issue => issue.includes("personal-profile-path")));
});
