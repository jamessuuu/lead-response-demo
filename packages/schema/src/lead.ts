import { z } from 'zod';

/** Maximum accepted inbound payload, serialized (Spec section 6: body <= 4 KB). */
export const LEAD_PAYLOAD_MAX_BYTES = 4096;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * The raw inbound lead as a form or ad forwarder would POST it. Deliberately
 * loose (the normalize step exists to absorb inconsistency), bounded in size,
 * and flat: nested objects are rejected so a payload cannot smuggle
 * structure past the size check.
 */
export const LeadPayload = z
  .record(z.string().min(1).max(64), scalar)
  .superRefine((value, ctx) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > LEAD_PAYLOAD_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `payload is ${bytes} bytes; the limit is ${LEAD_PAYLOAD_MAX_BYTES}`,
      });
    }
  });
export type LeadPayload = z.infer<typeof LeadPayload>;

/** Output shape of the Normalize Lead code node (ported from workflow.json). */
export const NormalizedLead = z.strictObject({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  source: z.string(),
  interest: z.string(),
  receivedAt: z.string(),
});
export type NormalizedLead = z.infer<typeof NormalizedLead>;
