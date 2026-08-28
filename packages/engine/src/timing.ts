import { z } from 'zod';
import type { Prng } from './prng.ts';

const Entry = z.strictObject({
  nominal: z.number().nonnegative(),
  jitterPct: z.number().min(0).max(100),
  basis: z.string().min(1),
});
export type TimingEntry = z.infer<typeof Entry>;

/**
 * Per-node durations the engine samples from. Either modeled (assumptions,
 * each with its basis written down) or derived from a recording (M1).
 */
export const TimingTable = z
  .strictObject({
    id: z.string().min(1),
    basis: z.enum(['modeled', 'recording']),
    note: z.string().min(1),
    recordingId: z.string().min(1).optional(),
    /** Executor overhead between consecutive nodes. */
    schedulerOverheadMs: Entry,
    /** Keyed by workflow node name. */
    nodes: z.record(z.string(), Entry),
    faults: z.strictObject({
      replyCheckTimeoutMs: z.strictObject({ value: z.number().positive(), basis: z.string().min(1) }),
    }),
  })
  .superRefine((t, ctx) => {
    if (t.basis === 'recording' && !t.recordingId) {
      ctx.addIssue({ code: 'custom', message: 'a recording-based timing table must name its recordingId' });
    }
  });
export type TimingTable = z.infer<typeof TimingTable>;

/** nominal * (1 +/- jitter), rounded to whole milliseconds, deterministic per PRNG state. */
export function sampleDuration(entry: TimingEntry, prng: Prng): number {
  const u = prng.next();
  const factor = 1 + (entry.jitterPct / 100) * (2 * u - 1);
  return Math.max(0, Math.round(entry.nominal * factor));
}

export function entryFor(table: TimingTable, nodeName: string): TimingEntry {
  const e = table.nodes[nodeName];
  if (!e) throw new Error(`timing table ${table.id} has no entry for node "${nodeName}"`);
  return e;
}
