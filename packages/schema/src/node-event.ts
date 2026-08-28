import { z } from 'zod';
import { isIsoTimestamp } from './iso.ts';

export const Iso = z
  .string()
  .refine(isIsoTimestamp, 'expected an ISO-8601 timestamp with milliseconds and an offset');

export const NODE_STATUSES = ['success', 'error', 'disabled', 'not-run'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const NodeRequest = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().url(),
  /** Always true: auth headers are never written, at capture or in the engine. */
  headersRedacted: z.literal(true),
  /** Masked, truncated preview of the request body (phone already masked). */
  bodyPreview: z.string().max(400).optional(),
});
export type NodeRequest = z.infer<typeof NodeRequest>;

export const NodeResponse = z.strictObject({
  status: z.number().int().min(100).max(599),
  preview: z.string().max(400),
});
export type NodeResponse = z.infer<typeof NodeResponse>;

export const NodeError = z.strictObject({
  message: z.string().min(1),
  code: z.string().optional(),
  httpStatus: z.number().int().optional(),
});
export type NodeError = z.infer<typeof NodeError>;

/**
 * One node of one execution. Absolute timestamps only; offsets and durations
 * are derived (see timeline.ts) so a run file can never be hand-authored as
 * an animation.
 */
export const NodeEvent = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string().regex(/^n8n-nodes-base\./),
    typeVersion: z.number(),
    status: z.enum(NODE_STATUSES),
    startedAt: Iso.nullable(),
    finishedAt: Iso.nullable(),
    /** One plain sentence about what the node did or why it did not run. */
    summary: z.string().min(1).max(400),
    /** True when the node's counterpart was a stand-in (stubbed integration). */
    stub: z.boolean(),
    request: NodeRequest.optional(),
    response: NodeResponse.optional(),
    error: NodeError.optional(),
  })
  .superRefine((n, ctx) => {
    const ran = n.status === 'success' || n.status === 'error';
    if (ran && (n.startedAt === null || n.finishedAt === null)) {
      ctx.addIssue({ code: 'custom', message: `${n.name}: a node that ran must carry startedAt and finishedAt` });
    }
    if (!ran && (n.startedAt !== null || n.finishedAt !== null)) {
      ctx.addIssue({ code: 'custom', message: `${n.name}: a node that did not run must not carry timestamps` });
    }
    if (n.startedAt && n.finishedAt && Date.parse(n.finishedAt) < Date.parse(n.startedAt)) {
      ctx.addIssue({ code: 'custom', message: `${n.name}: finishedAt precedes startedAt` });
    }
    if (n.status === 'error' && !n.error) {
      ctx.addIssue({ code: 'custom', message: `${n.name}: an errored node must carry an error` });
    }
    if (n.status !== 'error' && n.error) {
      ctx.addIssue({ code: 'custom', message: `${n.name}: only an errored node may carry an error` });
    }
  });
export type NodeEvent = z.infer<typeof NodeEvent>;
