/**
 * Pure severity-grouping for the completion summary panel.
 *
 * Phase 13's backend ships `SyncCompleted.warnings: WarningEntry[]` already
 * deduped by (path, severity), bounded to MAX_WARNINGS (500), and sorted by
 * count desc + path asc. This helper takes that flat list and produces two
 * render-string arrays (errors first, warnings second) applying the D-12/D-13
 * folded path-vs-message rule:
 *
 *   render `path`      when `path` is non-empty AND not the `<truncated>` sentinel
 *   render `message`   otherwise (empty path = pathless pattern like
 *                      `Library file missing.`; `<truncated>` = Phase 13 D-04
 *                      truncator row whose `message` is the human footnote)
 *
 * Dependency-free: no React, no Tauri, no I/O — trivially unit-testable.
 * Mirrors the `mergeProgress.ts` pure-helper precedent.
 *
 * Phase 14 (Plan 14-01 / D-12 + D-13).
 */

import type { WarningEntry } from "@/lib/types";

export interface GroupedWarnings {
  errors: string[];
  warnings: string[];
}

/**
 * Split `entries` into `{ errors, warnings }` render-string arrays.
 *
 * Insertion order is preserved (no sort) — the backend already orders by
 * count desc + path asc (Phase 13 SUMMARY), and the UI mirrors that order.
 *
 * Per-row render string (D-12/D-13 folded rule):
 *   - `entry.path` when it is non-empty AND not the literal `<truncated>` sentinel
 *   - `entry.message` otherwise
 *
 * `<truncated>` is the Phase 13 D-04 truncator-sentinel string (see the
 * doc-comment on `WarningEntry.path` in `sync_event.rs` + the 13-01 SUMMARY
 * "append `<truncated>` sentinel row"); its `message` carries the human
 * footnote ("+N more paths suppressed (M total warnings from K distinct paths)").
 */
export function groupWarnings(entries: WarningEntry[]): GroupedWarnings {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    const render =
      entry.path.length > 0 && entry.path !== "<truncated>"
        ? entry.path
        : entry.message;

    if (entry.severity === "error") {
      errors.push(render);
    } else {
      warnings.push(render);
    }
  }

  return { errors, warnings };
}
