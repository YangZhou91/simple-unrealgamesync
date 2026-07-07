/**
 * Pure sticky-merge for progress state.
 *
 * The useSync progress handler receives two interleaved Progress streams from
 * the backend p4_executor:
 *   - stdout drain path (~5/s): emits bytesDone/bytesTotal/bytesRate = None
 *   - heartbeat path (~0.5/s): emits byte fields = Some(sampled value)
 *
 * A whole-object-overwrite in the handler caused the high-frequency drain
 * stream to clobber the heartbeat's byte signal ~90% of the time, producing
 * a flickering byte bar. This pure function merges so that:
 *   - byte fields are STICKY (only update when the event carries a real value;
 *     otherwise preserve prev — `??` falls back when event value is
 *     null/undefined)
 *   - current/total/currentFile ALWAYS track the latest event (never sticky)
 *
 * Dependency-free: no React, no Tauri, no I/O — trivially unit-testable.
 *
 * quick-260707-pf9
 */

export interface ProgressState {
  current: number;
  total: number;
  currentFile: string;
  bytesDone: number | null;
  bytesTotal: number | null;
  bytesRate: number | null;
}

export interface ProgressEvent {
  current: number;
  total: number;
  currentFile: string;
  bytesDone?: number | null;
  bytesTotal?: number | null;
  bytesRate?: number | null;
}

/**
 * Merge a progress event into the previous state.
 *
 * Byte fields are sticky: if `event.bytesDone` (and friends) is null/undefined,
 * the previous value is preserved. If the event carries a real number, it wins.
 * `current`, `total`, and `currentFile` are always taken from the event.
 */
export function mergeProgress(prev: ProgressState, event: ProgressEvent): ProgressState {
  return {
    current: event.current,
    total: event.total,
    currentFile: event.currentFile,
    bytesDone: event.bytesDone ?? prev.bytesDone,
    bytesTotal: event.bytesTotal ?? prev.bytesTotal,
    bytesRate: event.bytesRate ?? prev.bytesRate,
  };
}
