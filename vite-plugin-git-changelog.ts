import type { Plugin } from "vite";
import { execSync } from "child_process";

/**
 * Vite plugin that reads git commit history at build time and exposes it
 * as a virtual module (`virtual:changelog`) that can be imported in React.
 *
 * The changelog always corresponds to the exact git commits included in the build,
 * so users can verify whether a specific bug fix is present in their version.
 */
const VIRTUAL_MODULE_ID = "virtual:changelog";
const RESOLVED_ID = "\0" + VIRTUAL_MODULE_ID;

interface CommitEntry {
  hash: string;
  date: string;
  subject: string;
}

function readGitLog(): CommitEntry[] {
  try {
    // Format: 7-char hash + space + short date + space + subject
    // --abbrev=7 ensures consistent hash length for reliable parsing
    const log = execSync(
      `git log --no-merges --format="%h %ad %s" --date=short --abbrev=7 -100`,
      { encoding: "utf-8" },
    ).trim();

    if (!log) return [];

    return log.split("\n").map((line) => ({
      hash: line.substring(0, 7),
      date: line.substring(8, 18),
      subject: line.substring(19),
    }));
  } catch {
    return [];
  }
}

export function gitChangelogPlugin(): Plugin {
  return {
    name: "vite-plugin-git-changelog",
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;

      const commits = readGitLog();
      return `export const changelog = ${JSON.stringify(commits)};`;
    },
  };
}
