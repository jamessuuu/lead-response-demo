import {
  ARTIFACT_NODE_IDS,
  LeadPayload as LeadPayloadSchema,
  METRIC_NODE_IDS,
  RunFile as RunFileSchema,
  epochMs,
  formatIso,
  maskPhone,
  offsetMinutes,
  type Artifacts,
  type Fault,
  type LeadPayload,
  type Metrics,
  type NodeEvent,
  type RunFile,
  type Scenario,
  type SystemId,
} from '@lrd/schema';
import { evaluateReplied } from './branch.ts';
import { applyPlaceholders, renderTemplate, type ExprContext } from './expressions.ts';
import { normalizeLead } from './normalize.ts';
import { mulberry32, type Prng } from './prng.ts';
import { preview, redactDeep, stripHtml } from './redact.ts';
import { FAULT_BODIES, answer, classifyEndpoint, contactIdFor, type Endpoint, type StubState } from './stubs.ts';
import { entryFor, sampleDuration, type TimingTable } from './timing.ts';
import { stringParam, type Topology, type TopologyNode } from './workflow.ts';

export const ENGINE_VERSION = '0.1.0';

export type FaultSpec =
  | { seam: 'slack-401' }
  | { seam: 'ghl-429'; at?: 'upsert' | 'sms' | 'email' | 'check-reply' }
  | { seam: 'duplicate-webhook' }
  | { seam: 'reply-check-timeout' };

export interface PriorExecution {
  id: string;
  deliveredAfterMs: number;
  cause: string;
}

export interface ExecuteOptions {
  id: string;
  scenario: Scenario;
  payload: LeadPayload;
  /** t0, ISO with the offset every node timestamp will carry. */
  startedAt: string;
  /** Written into the file; fixed by the caller so regeneration is byte-identical. */
  producedAt: string;
  seed: number;
  faults: FaultSpec[];
  timingTable: TimingTable;
  topology: Topology;
  workflowSha256: string;
  placeholders: Record<string, string>;
  business: { name: string; fictional: true };
  /** The duplicate scenario: this execution is a second delivery of a payload already processed. */
  priorExecution?: PriorExecution;
  /** What the reply check finds after the wait. Default: no reply. */
  replyDirection?: 'inbound' | 'outbound';
}

/** Node ids in content/workflow.json the executor gives special meaning to. */
export const NODE_IDS = {
  webhook: 'node-webhook',
  normalize: 'node-normalize',
  enrich: 'node-enrich',
  upsert: 'node-ghl-upsert',
  sms: 'node-ghl-sms',
  email: 'node-ghl-email',
  slackNotify: 'node-slack-notify',
  sheets: 'node-sheets-log',
  wait: 'node-wait',
  checkReply: 'node-ghl-checkreply',
  ifReplied: 'node-if-replied',
  humanTakeover: 'node-human-takeover',
  voiceAiStub: 'node-voiceai-stub',
  slackEscalate: 'node-slack-escalate',
} as const;

const TYPES = {
  webhook: 'n8n-nodes-base.webhook',
  code: 'n8n-nodes-base.code',
  http: 'n8n-nodes-base.httpRequest',
  slack: 'n8n-nodes-base.slack',
  sheets: 'n8n-nodes-base.googleSheets',
  wait: 'n8n-nodes-base.wait',
  if: 'n8n-nodes-base.if',
  noop: 'n8n-nodes-base.noOp',
} as const;

const SIMULATED: SystemId[] = ['n8n', 'webhook', 'normalize', 'wait', 'branch'];
const STUBBED: SystemId[] = ['gohighlevel', 'slack', 'google-sheets', 'voice-ai'];

export function faultsForScenario(scenario: Scenario): FaultSpec[] {
  switch (scenario) {
    case 'happy':
      return [];
    case 'slack-revoked':
      return [{ seam: 'slack-401' }];
    case 'ghl-429':
      return [{ seam: 'ghl-429', at: 'upsert' }];
    case 'duplicate':
      return [{ seam: 'duplicate-webhook' }];
    case 'reply-timeout':
      return [{ seam: 'reply-check-timeout' }];
  }
}

interface NodeOutcome {
  durationMs: number;
  output: unknown;
  summary: string;
  stub: boolean;
  request?: NodeEvent['request'];
  response?: NodeEvent['response'];
  error?: NodeEvent['error'];
  /** Output indexes the execution continues on (default: all). */
  takeOutputs?: number[];
}

interface State {
  clock: number;
  prng: Prng;
  outputs: Map<string, unknown>;
  prevJson: unknown;
  stub: StubState;
  artifacts: Artifacts;
  ghl429At: string | null;
  slackRevoked: boolean;
  replyTimeout: boolean;
  branchNote: string | null;
}

class NodeFailure extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly httpStatus: number | undefined,
    readonly response: NodeEvent['response'] | undefined,
    readonly request: NodeEvent['request'] | undefined,
    readonly durationMs: number,
  ) {
    super(message);
    this.name = 'NodeFailure';
  }
}

function nodeById(topology: Topology, id: string): TopologyNode {
  const n = topology.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`workflow has no node with id ${id}`);
  return n;
}

function ghl429Target(spec: Extract<FaultSpec, { seam: 'ghl-429' }>): string {
  switch (spec.at ?? 'upsert') {
    case 'upsert':
      return NODE_IDS.upsert;
    case 'sms':
      return NODE_IDS.sms;
    case 'email':
      return NODE_IDS.email;
    case 'check-reply':
      return NODE_IDS.checkReply;
  }
}

/** Execute the topology once, deterministically, and return a validated run file. */
export function execute(opts: ExecuteOptions): RunFile {
  const payload = LeadPayloadSchema.parse(opts.payload);
  const { topology, timingTable } = opts;
  const offset = offsetMinutes(opts.startedAt);
  const locationId = applyPlaceholders('REPLACE_GHL_LOCATION_ID', opts.placeholders);

  const state: State = {
    clock: epochMs(opts.startedAt),
    prng: mulberry32(opts.seed),
    outputs: new Map(),
    prevJson: undefined,
    stub: { knownContacts: new Set(), replyDirection: opts.replyDirection ?? 'outbound', locationId },
    artifacts: { sms: null, email: null, slack: null, sheetRow: null, slackEscalation: null, errorWorkflow: null },
    ghl429At: null,
    slackRevoked: false,
    replyTimeout: false,
    branchNote: null,
  };

  const faults: Fault[] = [];
  for (const spec of opts.faults) {
    switch (spec.seam) {
      case 'slack-401':
        state.slackRevoked = true;
        faults.push({
          seam: 'slack-401',
          node: nodeById(topology, NODE_IDS.slackNotify).name,
          detail:
            'Slack bot token revoked: every chat.postMessage answers 401 invalid_auth. Both Slack nodes and the error workflow share the credential.',
        });
        break;
      case 'ghl-429': {
        state.ghl429At = ghl429Target(spec);
        faults.push({
          seam: 'ghl-429',
          node: nodeById(topology, state.ghl429At).name,
          detail: 'LeadConnector answers 429 Too Many Requests. The base workflow configures no retry on this node.',
        });
        break;
      }
      case 'duplicate-webhook': {
        if (!opts.priorExecution) throw new Error('duplicate-webhook needs priorExecution');
        faults.push({
          seam: 'duplicate-webhook',
          node: nodeById(topology, NODE_IDS.webhook).name,
          detail: `The same payload was delivered again ${opts.priorExecution.deliveredAfterMs} ms after execution ${opts.priorExecution.id} (${opts.priorExecution.cause}). n8n starts a second execution; nothing in the workflow dedupes it.`,
        });
        break;
      }
      case 'reply-check-timeout':
        state.replyTimeout = true;
        faults.push({
          seam: 'reply-check-timeout',
          node: nodeById(topology, NODE_IDS.checkReply).name,
          detail: `No response headers within ${timingTable.faults.replyCheckTimeoutMs.value} ms; the HTTP Request node errors with ETIMEDOUT after the first touch already went out.`,
        });
        break;
    }
  }
  if (opts.priorExecution) {
    // The CRM already holds this lead: seed the stub so the upsert matches instead of creating.
    const probe = normalizeLead(payload, new Date(state.clock).toISOString());
    state.stub.knownContacts.add(contactIdFor(locationId, probe.email, probe.phone));
  }

  const events: NodeEvent[] = [];
  const scheduled = new Set<string>([topology.trigger]);
  let halted: { node: string; message: string } | null = null;

  const ctx: ExprContext = {
    get json() {
      return state.prevJson;
    },
    nodeOutput: (name: string) => {
      if (!state.outputs.has(name)) throw new Error(`no output recorded for node "${name}"`);
      return state.outputs.get(name);
    },
  };

  const scheduleNext = (node: TopologyNode, indexes?: number[]) => {
    const outs = topology.outputs.get(node.name) ?? [];
    outs.forEach((targets, i) => {
      if (indexes && !indexes.includes(i)) return;
      for (const t of targets) scheduled.add(t);
    });
  };

  for (const node of topology.nodes) {
    const base = { id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion };
    if (halted) {
      events.push({ ...base, status: 'not-run', startedAt: null, finishedAt: null, stub: false, summary: `Not reached: the execution stopped at "${halted.node}".` });
      continue;
    }
    if (!scheduled.has(node.name)) {
      events.push({ ...base, status: 'not-run', startedAt: null, finishedAt: null, stub: false, summary: state.branchNote ?? 'Not taken.' });
      continue;
    }
    if (node.disabled) {
      events.push({ ...base, status: 'disabled', startedAt: null, finishedAt: null, stub: false, summary: 'Disabled in workflow.json: n8n passed the data through untouched. Left empty on purpose rather than faking a vendor call.' });
      state.outputs.set(node.name, state.prevJson);
      scheduleNext(node);
      continue;
    }

    if (events.some((e) => e.status === 'success')) {
      state.clock += sampleDuration(timingTable.schedulerOverheadMs, state.prng);
    }
    const startedAt = state.clock;
    try {
      const out = runNode(node, opts, state, ctx, payload);
      state.clock = startedAt + out.durationMs;
      events.push({
        ...base,
        status: 'success',
        startedAt: formatIso(startedAt, offset),
        finishedAt: formatIso(state.clock, offset),
        summary: out.summary,
        stub: out.stub,
        ...(out.request ? { request: out.request } : {}),
        ...(out.response ? { response: out.response } : {}),
      });
      state.outputs.set(node.name, out.output);
      state.prevJson = out.output;
      scheduleNext(node, out.takeOutputs);
    } catch (err) {
      if (!(err instanceof NodeFailure)) throw err;
      state.clock = startedAt + err.durationMs;
      events.push({
        ...base,
        status: 'error',
        startedAt: formatIso(startedAt, offset),
        finishedAt: formatIso(state.clock, offset),
        summary: `Failed: ${err.message} The execution stopped here (n8n default: no continue-on-fail).`,
        stub: true,
        ...(err.request ? { request: err.request } : {}),
        ...(err.response ? { response: err.response } : {}),
        error: {
          message: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.httpStatus ? { httpStatus: err.httpStatus } : {}),
        },
      });
      halted = { node: node.name, message: err.message };
      state.artifacts.errorWorkflow = {
        fired: true,
        assumed: true,
        trigger: { node: node.name, message: err.message },
        alert: state.slackRevoked
          ? { channel: 'slack', status: 'error', reason: 'the error workflow posts through the same revoked Slack credential, so its alert failed too' }
          : { channel: 'slack', status: 'success' },
      };
    }
  }

  const byId = new Map(events.map((e) => [e.id, e]));
  const t0 = epochMs(opts.startedAt);
  // A node that errored produced no dispatch: gate every "did this actually
  // happen" metric on success, not just on carrying a finishedAt (the error
  // path timestamps the attempt too). totalMs is the exception on purpose —
  // it is elapsed wall-clock time for the whole execution, success or not.
  const sinceT0 = (id: string): number | null => {
    const e = byId.get(id);
    return e && e.status === 'success' && e.finishedAt ? epochMs(e.finishedAt) - t0 : null;
  };
  const wait = byId.get(METRIC_NODE_IDS.wait);
  let end = t0;
  for (const e of events) if (e.finishedAt) end = Math.max(end, epochMs(e.finishedAt));
  const metrics: Metrics = {
    firstTouchDispatchMs: sinceT0(METRIC_NODE_IDS.firstTouch),
    ownerNotifiedMs: sinceT0(METRIC_NODE_IDS.ownerNotified),
    waitMs: wait?.status === 'success' && wait.startedAt && wait.finishedAt ? epochMs(wait.finishedAt) - epochMs(wait.startedAt) : null,
    totalMs: end - t0,
  };

  const run = {
    schema: 1 as const,
    id: opts.id,
    mode: 'simulator' as const,
    scenario: opts.scenario,
    business: opts.business,
    producedAt: opts.producedAt,
    startedAt: opts.startedAt,
    workflow: { id: topology.id, name: topology.name, source: 'content/workflow.json' as const, sha256: opts.workflowSha256 },
    simulator: {
      engine: '@lrd/engine' as const,
      engineVersion: ENGINE_VERSION,
      seed: opts.seed,
      timingTable: {
        id: timingTable.id,
        basis: timingTable.basis,
        note: timingTable.note,
        ...(timingTable.recordingId ? { recordingId: timingTable.recordingId } : {}),
      },
      stubShapes: 'modeled' as const,
    },
    real: [] as SystemId[],
    stubbed: STUBBED,
    simulated: SIMULATED,
    faults,
    duplicate: opts.priorExecution
      ? { of: opts.priorExecution.id, deliveredAfterMs: opts.priorExecution.deliveredAfterMs, cause: opts.priorExecution.cause }
      : null,
    status: halted ? ('error' as const) : ('success' as const),
    nodes: events,
    artifacts: state.artifacts,
    metrics,
    redaction: { phoneMasked: true as const, headersRedacted: true as const },
  };

  // Redact before anything is written; then let the schema refuse anything inconsistent.
  return RunFileSchema.parse(redactDeep(run));
}

/** Canonical JSON text of a run file: 2-space indent, trailing newline, byte-identical per input. */
export function renderRunFile(run: RunFile): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

function runNode(node: TopologyNode, opts: ExecuteOptions, state: State, ctx: ExprContext, payload: LeadPayload): NodeOutcome {
  const table = opts.timingTable;
  const dur = () => sampleDuration(entryFor(table, node.name), state.prng);
  switch (node.type) {
    case TYPES.webhook:
      return runWebhook(node, opts, payload, dur());
    case TYPES.code:
      return runNormalize(node, state, dur());
    case TYPES.http:
      return runHttp(node, opts, state, ctx, dur());
    case TYPES.slack:
      return runSlack(node, opts, state, ctx, dur());
    case TYPES.sheets:
      return runSheets(node, opts, state, ctx, dur());
    case TYPES.wait:
      return runWait(node, state);
    case TYPES.if:
      return runIf(node, state, dur());
    case TYPES.noop:
      return runNoOp(node, state, dur());
    default:
      throw new Error(`${node.name}: the engine does not execute ${node.type}`);
  }
}

function runWebhook(node: TopologyNode, opts: ExecuteOptions, payload: LeadPayload, durationMs: number): NodeOutcome {
  const path = stringParam(node, 'path');
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  let summary = `Received POST /webhook/${path} (${bytes} bytes of JSON) and answered 200 immediately (responseMode: onReceived).`;
  if (opts.priorExecution) {
    summary += ` This is a second delivery of the same payload, ${opts.priorExecution.deliveredAfterMs} ms after execution ${opts.priorExecution.id}; n8n started a new execution because nothing dedupes at the webhook.`;
  }
  return {
    durationMs,
    output: { headers: { 'content-type': 'application/json' }, params: {}, query: {}, body: payload },
    summary,
    stub: false,
  };
}

function runNormalize(node: TopologyNode, state: State, durationMs: number): NodeOutcome {
  const lead = normalizeLead(state.prevJson, new Date(state.clock).toISOString());
  return {
    durationMs,
    output: lead,
    summary: `Normalized the payload: first name "${lead.firstName}", phone ${maskPhone(lead.phone) || '(none)'} in E.164, email lower-cased, source "${lead.source}", interest "${lead.interest}".`,
    stub: false,
  };
}

function httpFailure(message: string, code: string | undefined, status: number | undefined, body: unknown, request: NodeEvent['request'], durationMs: number): NodeFailure {
  return new NodeFailure(message, code, status, status ? { status, preview: preview(JSON.stringify(body)) } : undefined, request, durationMs);
}

function runHttp(node: TopologyNode, opts: ExecuteOptions, state: State, ctx: ExprContext, durationMs: number): NodeOutcome {
  const method = (typeof node.parameters.method === 'string' ? node.parameters.method : 'GET') as 'GET' | 'POST';
  const url = applyPlaceholders(renderTemplate(stringParam(node, 'url'), ctx), opts.placeholders);
  const endpoint: Endpoint = classifyEndpoint(method, url);
  let body: unknown = undefined;
  let request: NodeEvent['request'] = { method, url, headersRedacted: true };
  if (node.parameters.sendBody === true) {
    const rendered = applyPlaceholders(renderTemplate(stringParam(node, 'jsonBody'), ctx), opts.placeholders);
    try {
      body = JSON.parse(rendered);
    } catch {
      throw new NodeFailure('JSON parameter needs to be valid JSON.', 'invalid_json', undefined, undefined, request, durationMs);
    }
    request = { ...request, bodyPreview: preview(JSON.stringify(body)) };
  } else if (endpoint === 'ghl.conversations.search') {
    const params = new URL(url).searchParams;
    body = { contactId: params.get('contactId') ?? '', locationId: params.get('locationId') ?? '' };
  }

  if (state.ghl429At === node.id) {
    throw httpFailure('The service is receiving too many requests from you (429 Too Many Requests).', 'ERR_TOO_MANY_REQUESTS', 429, FAULT_BODIES.ghl429, request, durationMs);
  }
  if (state.replyTimeout && node.id === NODE_IDS.checkReply) {
    const timeout = opts.timingTable.faults.replyCheckTimeoutMs.value;
    throw new NodeFailure(`No response headers within ${timeout} ms (ETIMEDOUT).`, 'ETIMEDOUT', undefined, undefined, request, timeout);
  }

  const completedAtMs = state.clock + durationMs;
  const result = answer({ endpoint, body, completedAtMs }, state.stub, state.prng);
  const response = { status: result.status, preview: preview(JSON.stringify(result.body)) };
  const out = result.body as Record<string, unknown>;
  let summary: string;
  switch (endpoint) {
    case 'ghl.contacts.upsert': {
      const contact = out.contact as { id: string };
      summary = out.new
        ? `Upserted the contact in GoHighLevel: created ${contact.id} with tags speed-to-lead, new-web-lead.`
        : `Upserted the contact in GoHighLevel: matched existing ${contact.id} and updated it (no duplicate contact).`;
      break;
    }
    case 'ghl.conversations.messages': {
      const b = body as Record<string, string>;
      const lead = state.outputs.get('Normalize Lead') as { phone: string; email: string };
      if (b.type === 'SMS') {
        state.artifacts.sms = { to: maskPhone(lead.phone), body: b.message ?? '' };
        summary = `Composed the first-touch SMS to ${maskPhone(lead.phone)} and handed it to GoHighLevel (queued as ${String(out.messageId)}).`;
      } else {
        state.artifacts.email = { subject: b.subject ?? '', from: b.emailFrom ?? '', preview: stripHtml(b.html ?? '') };
        summary = `Composed the branded email "${b.subject ?? ''}" to ${lead.email} and handed it to GoHighLevel.`;
      }
      break;
    }
    case 'ghl.conversations.search': {
      const convs = out.conversations as Array<{ lastMessageDirection: string }>;
      summary = `Searched the contact's conversation: last message direction "${convs[0]?.lastMessageDirection ?? 'none'}".`;
      break;
    }
    default:
      summary = `${method} ${url}`;
  }
  return { durationMs, output: result.body, summary, stub: true, request, response };
}

function runSlack(node: TopologyNode, opts: ExecuteOptions, state: State, ctx: ExprContext, durationMs: number): NodeOutcome {
  const channelRaw = (node.parameters.channelId as { value?: string } | undefined)?.value ?? '';
  const channel = applyPlaceholders(channelRaw, opts.placeholders);
  const text = applyPlaceholders(renderTemplate(stringParam(node, 'text'), ctx), opts.placeholders);
  const request: NodeEvent['request'] = {
    method: 'POST',
    url: 'https://slack.com/api/chat.postMessage',
    headersRedacted: true,
    bodyPreview: preview(JSON.stringify({ channel, text })),
  };
  if (state.slackRevoked) {
    throw httpFailure('Slack answered 401 invalid_auth: the bot token is no longer valid.', 'invalid_auth', 401, FAULT_BODIES.slack401, request, durationMs);
  }
  const result = answer({ endpoint: 'slack.chat.postMessage', body: { channel, text }, completedAtMs: state.clock + durationMs }, state.stub, state.prng);
  if (node.id === NODE_IDS.slackEscalate) state.artifacts.slackEscalation = { channel, text };
  else state.artifacts.slack = { channel, text };
  return {
    durationMs,
    output: result.body,
    summary: `Posted to ${channel}: "${preview(text, 96)}"`,
    stub: true,
    request,
    response: { status: result.status, preview: preview(JSON.stringify(result.body)) },
  };
}

function runSheets(node: TopologyNode, opts: ExecuteOptions, state: State, ctx: ExprContext, durationMs: number): NodeOutcome {
  const documentId = applyPlaceholders((node.parameters.documentId as { value?: string } | undefined)?.value ?? '', opts.placeholders);
  const sheet = (node.parameters.sheetName as { value?: string } | undefined)?.value ?? 'Sheet1';
  const mapping = (node.parameters.columns as { value?: Record<string, string> } | undefined)?.value ?? {};
  const row = Object.entries(mapping).map(([column, template]) => ({
    column,
    value: applyPlaceholders(renderTemplate(template, ctx), opts.placeholders),
  }));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values/${encodeURIComponent(sheet)}:append?valueInputOption=USER_ENTERED`;
  const request: NodeEvent['request'] = {
    method: 'POST',
    url,
    headersRedacted: true,
    bodyPreview: preview(JSON.stringify({ values: [row.map((c) => c.value)] })),
  };
  const result = answer(
    { endpoint: 'sheets.values.append', body: { spreadsheetId: documentId, sheet, columns: row.length }, completedAtMs: state.clock + durationMs },
    state.stub,
    state.prng,
  );
  state.artifacts.sheetRow = row;
  return {
    durationMs,
    output: result.body,
    summary: `Appended one row (${row.length} columns) to sheet "${sheet}" of spreadsheet ${documentId}.`,
    stub: true,
    request,
    response: { status: result.status, preview: preview(JSON.stringify(result.body)) },
  };
}

function runWait(node: TopologyNode, state: State): NodeOutcome {
  const amount = Number(node.parameters.amount ?? 0);
  const unit = String(node.parameters.unit ?? 'seconds');
  const perUnit: Record<string, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  const factor = perUnit[unit];
  if (!factor) throw new Error(`${node.name}: unsupported wait unit ${unit}`);
  return {
    durationMs: amount * factor,
    output: state.prevJson,
    summary: `Held the execution for ${amount} ${unit} (workflow parameter), then resumed.`,
    stub: false,
  };
}

function runIf(node: TopologyNode, state: State, durationMs: number): NodeOutcome {
  const decision = evaluateReplied(state.prevJson);
  state.branchNote = `Not taken: "${node.name}" evaluated ${decision.replied}.`;
  return {
    durationMs,
    output: state.prevJson,
    summary: `Evaluated Replied? as ${decision.replied}: lastMessageDirection was "${decision.observed}", so the execution continued on the ${decision.replied ? 'human-takeover' : 'no-reply'} branch.`,
    stub: false,
    takeOutputs: [decision.outputIndex],
  };
}

function runNoOp(node: TopologyNode, state: State, durationMs: number): NodeOutcome {
  const isVoiceAi = node.id === NODE_IDS.voiceAiStub;
  return {
    durationMs,
    output: state.prevJson,
    summary: node.notes ? `NoOp: ${preview(node.notes, 300)}` : 'NoOp.',
    stub: isVoiceAi,
  };
}

export { ARTIFACT_NODE_IDS };
