import { z } from 'zod';
import { Iso } from './node-event.ts';
import { SYSTEM_IDS } from './systems.ts';

/**
 * Capture metadata written beside a recording (Spec section 4). A run file
 * with mode "recording" may not exist without this file and the raw
 * execution export; `validateRunDirectory` enforces that.
 */
export const AttestFile = z.strictObject({
  schema: z.literal(1),
  runId: z.string().min(1),
  capturedAt: Iso,
  n8n: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+/),
    executionId: z.string().min(1),
    mode: z.enum(['manual', 'webhook', 'trigger', 'cli']),
  }),
  os: z.string().min(1),
  captureCommand: z.string().min(1),
  /** Git SHA of the stubhouse that answered the external calls. */
  stubhouseCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  /** Which systems the stubhouse stood in for. Must equal run.stubbed. */
  stubbed: z.array(z.enum(SYSTEM_IDS)),
  operator: z.string().min(1),
  redaction: z.strictObject({
    authHeadersStripped: z.literal(true),
    phoneMasked: z.literal(true),
  }),
});
export type AttestFile = z.infer<typeof AttestFile>;
