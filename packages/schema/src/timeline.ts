import { epochMs } from './iso.ts';
import type { NodeEvent } from './node-event.ts';

export interface TimelineRow {
  node: NodeEvent;
  /** Milliseconds from t0 (the first node's start) to this node's start; null if it did not run. */
  offsetMs: number | null;
  durationMs: number | null;
}

/**
 * Derive offsets and durations from absolute timestamps. This is the only
 * place they are computed; run files never store them (Spec section 4, decision 1).
 */
export function deriveTimeline(nodes: readonly NodeEvent[]): TimelineRow[] {
  const t0 = timelineStart(nodes);
  return nodes.map((node) => {
    if (node.startedAt === null || node.finishedAt === null || t0 === null) {
      return { node, offsetMs: null, durationMs: null };
    }
    return {
      node,
      offsetMs: epochMs(node.startedAt) - t0,
      durationMs: epochMs(node.finishedAt) - epochMs(node.startedAt),
    };
  });
}

/** Epoch ms of the earliest start across nodes that ran, or null. */
export function timelineStart(nodes: readonly NodeEvent[]): number | null {
  let t0: number | null = null;
  for (const n of nodes) {
    if (n.startedAt === null) continue;
    const ms = epochMs(n.startedAt);
    if (t0 === null || ms < t0) t0 = ms;
  }
  return t0;
}

/** Epoch ms of the latest finish across nodes that ran, or null. */
export function timelineEnd(nodes: readonly NodeEvent[]): number | null {
  let t1: number | null = null;
  for (const n of nodes) {
    if (n.finishedAt === null) continue;
    const ms = epochMs(n.finishedAt);
    if (t1 === null || ms > t1) t1 = ms;
  }
  return t1;
}

/** `0.9 s`, `12 ms`, `15:00 min` style formatting for durations. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')} min`;
}

/** The headline form: one decimal, seconds. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
