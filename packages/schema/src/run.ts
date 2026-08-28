import { z } from 'zod';
import { epochMs, offsetMinutes } from './iso.ts';
import { Iso, NodeEvent } from './node-event.ts';
import { SYSTEM_IDS, type SystemId } from './systems.ts';

export const RUN_SCHEMA_VERSION = 1 as const;

export const SCENARIOS = ['happy', 'slack-revoked', 'ghl-429', 'duplicate', 'reply-timeout'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const RUN_MODES = ['simulator', 'recording'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** The four seams a fault can be injected at (Spec section 11). */
export const SEAMS = ['slack-401', 'ghl-429', 'duplicate-webhook', 'reply-check-timeout'] as const;
export type Seam = (typeof SEAMS)[number];

/**
 * Node ids (from workflow.json) that the metrics are defined against.
 * The drift check pins these ids to the workflow file.
 */
export const METRIC_NODE_IDS = {
  t0: 'node-webhook',
  firstTouch: 'node-ghl-sms',
  ownerNotified: 'node-slack-notify',
  wait: 'node-wait',
} as const;

/** Artifact key -> the node that composes it. Present exactly when that node ran. */
export const ARTIFACT_NODE_IDS = {
  sms: 'node-ghl-sms',
  email: 'node-ghl-email',
  slack: 'node-slack-notify',
  sheetRow: 'node-sheets-log',
  slackEscalation: 'node-slack-escalate',
} as const;

/** `+1512•••0142`: country and area code kept, middle masked, last four kept. */
export const MASKED_PHONE_RE = /^\+\d{1,5}•••\d{2,4}$/;

export function maskPhone(e164: string): string {
  if (!/^\+\d{7,15}$/.test(e164)) return e164.length ? '•••' : '';
  const keepFront = Math.min(5, e164.length - 7);
  return `${e164.slice(0, keepFront)}•••${e164.slice(-4)}`;
}

export const Fault = z.strictObject({
  seam: z.enum(SEAMS),
  /** Workflow node name the fault is injected at. */
  node: z.string().min(1),
  detail: z.string().min(1),
});
export type Fault = z.infer<typeof Fault>;

export const TimingTableRef = z
  .strictObject({
    id: z.string().min(1),
    basis: z.enum(['modeled', 'recording']),
    note: z.string().min(1),
    recordingId: z.string().min(1).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.basis === 'recording' && !t.recordingId) {
      ctx.addIssue({ code: 'custom', message: 'a recording-based timing table must name its recordingId' });
    }
    if (t.basis === 'modeled' && t.recordingId) {
      ctx.addIssue({ code: 'custom', message: 'a modeled timing table cannot name a recordingId' });
    }
  });
export type TimingTableRef = z.infer<typeof TimingTableRef>;

export const SimulatorInfo = z.strictObject({
  engine: z.literal('@lrd/engine'),
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  seed: z.number().int(),
  timingTable: TimingTableRef,
  /** Response shapes are modeled from public API docs; nothing has verified them against a live API. */
  stubShapes: z.literal('modeled'),
});
export type SimulatorInfo = z.infer<typeof SimulatorInfo>;

export const N8nInfo = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  executionId: z.string().min(1),
  mode: z.enum(['manual', 'webhook', 'trigger', 'cli']),
});
export type N8nInfo = z.infer<typeof N8nInfo>;

const Message = z.strictObject({ channel: z.string().min(1), text: z.string().min(1) });

export const Artifacts = z.strictObject({
  sms: z.strictObject({ to: z.string().regex(MASKED_PHONE_RE), body: z.string().min(1) }).nullable(),
  email: z
    .strictObject({ subject: z.string().min(1), from: z.string().min(1), preview: z.string().min(1) })
    .nullable(),
  slack: Message.nullable(),
  sheetRow: z.array(z.strictObject({ column: z.string().min(1), value: z.string() })).nullable(),
  slackEscalation: Message.nullable(),
  /**
   * The n8n error workflow is prescribed by the deployment runbook (section 4),
   * not part of workflow.json; a simulator run records it as assumed.
   */
  errorWorkflow: z
    .strictObject({
      fired: z.literal(true),
      assumed: z.boolean(),
      trigger: z.strictObject({ node: z.string().min(1), message: z.string().min(1) }),
      alert: z.strictObject({
        channel: z.literal('slack'),
        status: z.enum(['success', 'error']),
        reason: z.string().optional(),
      }),
    })
    .nullable(),
});
export type Artifacts = z.infer<typeof Artifacts>;

export const Metrics = z.strictObject({
  /** Webhook receipt -> SMS request completed. Null when the SMS never dispatched. */
  firstTouchDispatchMs: z.number().int().nonnegative().nullable(),
  /** Webhook receipt -> Slack notification completed. */
  ownerNotifiedMs: z.number().int().nonnegative().nullable(),
  /** Duration of the Wait node. Null when it never ran. */
  waitMs: z.number().int().nonnegative().nullable(),
  /** Webhook receipt -> last node finished. */
  totalMs: z.number().int().nonnegative(),
});
export type Metrics = z.infer<typeof Metrics>;

const SystemList = z.array(z.enum(SYSTEM_IDS));

const RunFileObject = z.strictObject({
  schema: z.literal(RUN_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  mode: z.enum(RUN_MODES),
  scenario: z.enum(SCENARIOS),
  business: z.strictObject({ name: z.string().min(1), fictional: z.literal(true) }),
  /** When this file was produced (fixed per run so regeneration is byte-identical). */
  producedAt: Iso,
  /** t0: the webhook receipt. Every node timestamp carries this offset. */
  startedAt: Iso,
  workflow: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    source: z.literal('content/workflow.json'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  n8n: N8nInfo.optional(),
  simulator: SimulatorInfo.optional(),
  real: SystemList,
  stubbed: SystemList,
  simulated: SystemList,
  faults: z.array(Fault),
  duplicate: z
    .strictObject({
      of: z.string().min(1),
      deliveredAfterMs: z.number().int().positive(),
      cause: z.string().min(1),
    })
    .nullable(),
  status: z.enum(['success', 'error']),
  nodes: z.array(NodeEvent).min(1),
  artifacts: Artifacts,
  metrics: Metrics,
  redaction: z.strictObject({ phoneMasked: z.literal(true), headersRedacted: z.literal(true) }),
});

const REQUIRED_SIMULATED: readonly SystemId[] = ['n8n', 'webhook', 'normalize', 'wait', 'branch'];
const EXTERNAL: readonly SystemId[] = ['gohighlevel', 'slack', 'google-sheets', 'voice-ai'];

const SCENARIO_SEAM: Record<Scenario, Seam | null> = {
  happy: null,
  'slack-revoked': 'slack-401',
  'ghl-429': 'ghl-429',
  duplicate: 'duplicate-webhook',
  'reply-timeout': 'reply-check-timeout',
};

function issue(ctx: z.RefinementCtx, message: string, path: (string | number)[] = []): void {
  ctx.addIssue({ code: 'custom', message, path });
}

export const RunFile = RunFileObject.superRefine((run, ctx) => {
  // --- the three system lists are disjoint and together account for every system
  const seen = new Map<SystemId, string>();
  for (const [list, ids] of [
    ['real', run.real],
    ['stubbed', run.stubbed],
    ['simulated', run.simulated],
  ] as const) {
    for (const id of ids) {
      const prior = seen.get(id);
      if (prior) issue(ctx, `${id} is listed as both ${prior} and ${list}`, [list]);
      seen.set(id, list);
    }
  }
  for (const id of SYSTEM_IDS) {
    if (!seen.has(id)) issue(ctx, `${id} is not listed as real, stubbed or simulated`);
  }

  // --- mode rules: a simulator run cannot claim anything was real; a recording must prove itself
  if (run.mode === 'simulator') {
    if (!run.simulator) issue(ctx, 'a simulator run must carry the simulator block', ['simulator']);
    if (run.n8n) issue(ctx, 'a simulator run cannot carry an n8n block', ['n8n']);
    if (run.real.length > 0) issue(ctx, 'a simulator run cannot list any system as real', ['real']);
    for (const id of REQUIRED_SIMULATED) {
      if (!run.simulated.includes(id)) issue(ctx, `a simulator run must list ${id} as simulated`, ['simulated']);
    }
    for (const id of EXTERNAL) {
      if (!run.stubbed.includes(id)) {
        issue(ctx, `a simulator run has no I/O, so ${id} must be listed as stubbed`, ['stubbed']);
      }
    }
  } else {
    if (!run.n8n) issue(ctx, 'a recording must carry the n8n block', ['n8n']);
    if (run.simulator) issue(ctx, 'a recording cannot carry a simulator block', ['simulator']);
    if (run.simulated.length > 0) issue(ctx, 'a recording cannot list any system as simulated', ['simulated']);
    if (!run.real.includes('n8n')) issue(ctx, 'a recording must list n8n as real', ['real']);
    if (!run.stubbed.includes('voice-ai')) {
      issue(ctx, 'voice-ai is a NoOp stub in the workflow itself and must be listed as stubbed', ['stubbed']);
    }
  }

  // --- the scenario and the fault list agree
  const seams = new Set(run.faults.map((f) => f.seam));
  const want = SCENARIO_SEAM[run.scenario];
  if (want === null && seams.size > 0) issue(ctx, 'the happy scenario cannot carry faults', ['faults']);
  if (want !== null && !seams.has(want)) issue(ctx, `scenario ${run.scenario} must carry the ${want} fault`, ['faults']);
  if ((run.scenario === 'duplicate') !== (run.duplicate !== null)) {
    issue(ctx, 'the duplicate block is present exactly when the scenario is duplicate', ['duplicate']);
  }
  const names = new Set(run.nodes.map((n) => n.name));
  for (const f of run.faults) {
    if (!names.has(f.node)) issue(ctx, `fault targets unknown node ${f.node}`, ['faults']);
  }

  // --- timestamps: the first node is t0 and every timestamp keeps the run's offset
  const first = run.nodes[0];
  if (!first || first.id !== METRIC_NODE_IDS.t0) {
    issue(ctx, `the first node must be ${METRIC_NODE_IDS.t0} (the webhook)`, ['nodes']);
  } else if (first.startedAt !== run.startedAt) {
    issue(ctx, 'run.startedAt must equal the webhook node startedAt', ['startedAt']);
  }
  const offset = offsetMinutes(run.startedAt);
  let last = -Infinity;
  run.nodes.forEach((n, i) => {
    for (const ts of [n.startedAt, n.finishedAt]) {
      if (ts !== null && offsetMinutes(ts) !== offset) {
        issue(ctx, `${n.name}: timestamp offset differs from the run's`, ['nodes', i]);
      }
    }
    if (n.startedAt === null) return;
    const ms = epochMs(n.startedAt);
    if (ms < last) issue(ctx, `${n.name}: starts before the previous node that ran`, ['nodes', i]);
    last = ms;
  });

  // --- status agrees with the nodes; the error workflow fires exactly on error
  const anyError = run.nodes.some((n) => n.status === 'error');
  if ((run.status === 'error') !== anyError) issue(ctx, 'run.status must be error exactly when a node errored', ['status']);
  if (anyError !== (run.artifacts.errorWorkflow !== null)) {
    issue(ctx, 'the error workflow fires exactly when a node errored', ['artifacts', 'errorWorkflow']);
  }

  // --- metrics equal node arithmetic (Spec section 4, decision 1)
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const t0 = first?.startedAt ? epochMs(first.startedAt) : null;
  const sinceT0 = (id: string): number | null => {
    const n = byId.get(id);
    if (!n || n.status !== 'success' || n.finishedAt === null || t0 === null) return null;
    return epochMs(n.finishedAt) - t0;
  };
  const check = (key: keyof Metrics, value: number | null) => {
    if (run.metrics[key] !== value) {
      issue(ctx, `metrics.${key} is ${run.metrics[key]} but the nodes say ${value}`, ['metrics', key]);
    }
  };
  check('firstTouchDispatchMs', sinceT0(METRIC_NODE_IDS.firstTouch));
  check('ownerNotifiedMs', sinceT0(METRIC_NODE_IDS.ownerNotified));
  const wait = byId.get(METRIC_NODE_IDS.wait);
  check(
    'waitMs',
    wait && wait.status === 'success' && wait.startedAt !== null && wait.finishedAt !== null
      ? epochMs(wait.finishedAt) - epochMs(wait.startedAt)
      : null,
  );
  let end: number | null = null;
  for (const n of run.nodes) {
    if (n.finishedAt === null) continue;
    const ms = epochMs(n.finishedAt);
    if (end === null || ms > end) end = ms;
  }
  check('totalMs', end !== null && t0 !== null ? end - t0 : null);

  // --- artifacts exist exactly for the nodes that succeeded. A node that
  // errored produced no artifact by construction (execute.ts assigns the
  // artifact only after the stub call answers, never on the throw path) —
  // an errored Slack call must not be credited as a notification sent.
  const succeeded = (id: string) => byId.get(id)?.status === 'success';
  for (const [key, id] of Object.entries(ARTIFACT_NODE_IDS) as Array<[keyof typeof ARTIFACT_NODE_IDS, string]>) {
    if (byId.has(id) && succeeded(id) !== (run.artifacts[key] !== null)) {
      issue(ctx, `artifacts.${key} is present exactly when ${id} succeeded`, ['artifacts', key]);
    }
  }
});
export type RunFile = z.infer<typeof RunFile>;

/** Files that must sit beside a run.json for its mode to be legitimate. */
export const REQUIRED_SIBLINGS: Record<RunMode, readonly string[]> = {
  simulator: [],
  recording: ['execution.json', 'attest.json'],
};

export interface RunDirectory {
  run: unknown;
  /** Names of the files in the run's directory. */
  files: readonly string[];
}

/**
 * Validate a run together with its directory listing. A recording without its
 * raw execution export and its attestation is rejected here, so the site can
 * never build one into a page.
 */
export function validateRunDirectory(dir: RunDirectory): RunFile {
  const run = RunFile.parse(dir.run);
  const missing = REQUIRED_SIBLINGS[run.mode].filter((f) => !dir.files.includes(f));
  if (missing.length > 0) {
    throw new Error(
      `run ${run.id} claims mode "${run.mode}" but ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} missing beside run.json`,
    );
  }
  return run;
}
