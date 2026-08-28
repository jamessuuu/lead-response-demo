// capture/lib/build-run-file.mjs
//
// Maps a REAL n8n execution (deserialized via `flatted`, per n8n-core's own
// execution-data serialization — see capture.mjs) plus stubhouse's request
// log into a schema `mode: "recording"` RunFile. This is the recording's
// only source of truth: every field is read from what n8n and stubhouse
// actually recorded, never authored by hand (Spec section 4, decision 1).
//
// Node-to-HTTP-call matching: stubhouse's log has no idea which n8n node
// made which call, so this reads the log in the SAME order n8n executed
// the topology and pops off exactly the calls each node is known (from the
// workflow's own fixed shape) to make — see EXPECTED_CALLS. This is a
// capture-only concern; the simulator never needs it because it renders
// artifacts directly.

import {
  epochMs,
  formatIso,
  maskPhone,
  METRIC_NODE_IDS,
  RunFile as RunFileSchema,
} from '@lrd/schema';
import { preview, redactDeep, stripHtml } from '@lrd/engine';

const SIMULATED_FOR_RECORDING = []; // a recording lists nothing as simulated — schema requires this
const REAL_SYSTEMS = ['n8n', 'webhook', 'normalize', 'wait', 'branch'];
const STUBBED_SYSTEMS = ['gohighlevel', 'slack', 'google-sheets', 'voice-ai'];

/** How many stubhouse calls each node id consumes, in execution order. 'sheets' = "keep consuming while the path is under /sheets/". */
const EXPECTED_CALLS = {
  'node-ghl-upsert': 1,
  'node-ghl-sms': 1,
  'node-ghl-email': 1,
  'node-slack-notify': 1,
  'node-sheets-log': 'sheets',
  'node-ghl-checkreply': 1,
  'node-slack-escalate': 1,
};

/** Which stubhouse routing prefix each of the above node ids is only ever allowed to consume calls from. */
const SERVICE_FOR_NODE = {
  'node-ghl-upsert': 'ghl',
  'node-ghl-sms': 'ghl',
  'node-ghl-email': 'ghl',
  'node-slack-notify': 'slack',
  'node-sheets-log': 'sheets',
  'node-ghl-checkreply': 'ghl',
  'node-slack-escalate': 'slack',
};

/** stubhouse's routing prefix for a logged call's path ("ghl" | "slack" | "sheets" | "oauth" | something unrecognized). */
function serviceOf(path) {
  return path.split('/').filter(Boolean)[0];
}

/**
 * Only the three vendor-routed prefixes ever belong to a node's own call
 * count — the OAuth2 refresh fallback (`/oauth/token`) and any unclassified
 * 404 (an unexpected route, or `/_stubhouse/*` admin traffic if it were
 * ever logged) must never be sitting in the queue where a node's own
 * popCalls could mistake it for one of its real calls.
 */
function relevantCalls(stubhouseLog) {
  return stubhouseLog.filter((c) => ['ghl', 'slack', 'sheets'].includes(serviceOf(c.path)));
}

function popCalls(queue, nodeId) {
  const spec = EXPECTED_CALLS[nodeId];
  if (!spec) return [];
  const expectedService = SERVICE_FOR_NODE[nodeId];
  const out = [];
  const take = () => {
    const call = queue.shift();
    if (serviceOf(call.path) !== expectedService) {
      throw new Error(
        `build-run-file: expected ${nodeId}'s next stubhouse call to be a "${expectedService}" call, got "${call.path}". ` +
          'The node-to-call matching (EXPECTED_CALLS) has drifted from what stubhouse actually logged for this execution.',
      );
    }
    out.push(call);
  };
  if (spec === 'sheets') {
    while (queue.length > 0 && serviceOf(queue[0].path) === 'sheets') take();
    return out;
  }
  for (let i = 0; i < spec && queue.length > 0; i++) take();
  return out;
}

function jsonOf(taskData) {
  return taskData?.data?.main?.[0]?.[0]?.json;
}

/** n8n's NodeApiError-shaped error object -> our NodeError schema. */
function mapError(rawError) {
  if (!rawError) return undefined;
  const message = rawError.message ?? rawError.description ?? 'The node failed.';
  const httpStatus = Number(rawError.httpCode) || undefined;
  return {
    message: String(message),
    ...(rawError.name ? { code: String(rawError.name) } : {}),
    ...(httpStatus ? { httpStatus } : {}),
  };
}

/** Strips stubhouse's leading routing segment ("/ghl", "/slack", "/sheets") off a logged call's path. */
function stripServicePrefix(path) {
  const parts = path.split('/').filter(Boolean);
  return `/${parts.slice(1).join('/')}`;
}

/** Builds {method,url,headersRedacted,bodyPreview} from a stubhouse-logged call, restated as the real vendor URL it stood in for. */
function requestOf(call, realOrigin) {
  if (!call) return undefined;
  return {
    method: /** @type {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} */ (call.method),
    url: `${realOrigin}${stripServicePrefix(call.path)}`,
    headersRedacted: /** @type {true} */ (true),
    ...(call.requestBody !== undefined ? { bodyPreview: preview(JSON.stringify(call.requestBody)) } : {}),
  };
}

function responseOf(call) {
  if (!call) return undefined;
  return { status: call.status, preview: preview(JSON.stringify(call.responseBody ?? {})) };
}

const ORIGIN_FOR = {
  'node-ghl-upsert': 'https://services.leadconnectorhq.com',
  'node-ghl-sms': 'https://services.leadconnectorhq.com',
  'node-ghl-email': 'https://services.leadconnectorhq.com',
  'node-ghl-checkreply': 'https://services.leadconnectorhq.com',
  'node-slack-notify': 'https://slack.com',
  'node-slack-escalate': 'https://slack.com',
  'node-sheets-log': 'https://sheets.googleapis.com',
};

/**
 * @param {object} opts
 * @param {import('@lrd/engine').Topology} opts.topology - parseTopology(content/workflow.json), the CANONICAL (untransformed) one
 * @param {any} opts.executionData - flatted.parse(execution.data) from n8n's REST API
 * @param {Array<{method:string,path:string,status:number,requestBody?:unknown,responseBody?:unknown}>} opts.stubhouseLog
 * @param {string} opts.runId
 * @param {'happy'|'slack-revoked'} opts.scenario
 * @param {string} opts.workflowSha256
 * @param {string} opts.producedAt - fixed capture-time ISO stamp for attest/run bookkeeping (NOT a node timestamp)
 * @param {{version:string, executionId:string}} opts.n8nInfo
 */
export function buildRunFile({ topology, executionData, stubhouseLog, runId, scenario, workflowSha256, producedAt, n8nInfo }) {
  const runData = executionData.resultData?.runData ?? {};
  const callQueue = relevantCalls(stubhouseLog).map((c) => ({ ...c }));

  const nodes = [];
  const artifacts = { sms: null, email: null, slack: null, sheetRow: null, slackEscalation: null, errorWorkflow: null };
  // Tracks the previous ran node's finish time. Needed for exactly one
  // thing: n8n's own runData for a Wait node reports `startTime` as the
  // RESUME moment (when the executor picked the workflow back up), with
  // `executionTime` ~0 — not the moment it began waiting. Verified against
  // this repo's own first real capture: the gap between "Log to Google
  // Sheets" finishing and "Wait 15 Minutes"'s reported startTime was
  // 900018ms — essentially exactly the real 15-minute parameter, while the
  // Wait node's OWN startTime/executionTime pair collapses to 0ms. Using
  // the previous node's finish as the Wait node's effective start is what
  // makes metrics.waitMs (and the Spec section 4 arithmetic check) reflect
  // the real elapsed wait instead of the resume instant.
  let lastFinishMs = null;

  for (const tnode of topology.nodes) {
    const base = { id: tnode.id, name: tnode.name, type: tnode.type, typeVersion: tnode.typeVersion };
    const runs = runData[tnode.name];

    if (tnode.disabled) {
      nodes.push({
        ...base,
        status: 'disabled',
        startedAt: null,
        finishedAt: null,
        stub: false,
        summary: 'Disabled in workflow.json: n8n passed the data through untouched. Left empty on purpose rather than faking a vendor call.',
      });
      continue;
    }

    if (!runs || runs.length === 0) {
      // A node that never ran made no HTTP calls — nothing to pop for it.
      nodes.push({
        ...base,
        status: 'not-run',
        startedAt: null,
        finishedAt: null,
        stub: false,
        summary: 'Not reached or not taken by the real execution — see the node(s) before it in this table.',
      });
      continue;
    }

    const task = runs[0];
    // See the file-level comment above lastFinishMs: the Wait node's own
    // reported startTime is its resume instant, not when it began waiting.
    const startMs = tnode.id === 'node-wait' && lastFinishMs !== null ? lastFinishMs : task.startTime;
    const durationMs = task.executionTime ?? 0;
    const finishMs = tnode.id === 'node-wait' ? task.startTime + durationMs : startMs + durationMs;
    const errored = Boolean(task.error);
    const origin = ORIGIN_FOR[tnode.id];
    // Only a node that actually ran can have made HTTP calls — popped here,
    // not unconditionally for every topology node, so a halted execution's
    // untouched tail never mis-consumes calls that don't belong to it.
    const calls = popCalls(callQueue, tnode.id);
    const lastCall = calls[calls.length - 1];

    let summary = '';
    let stub = false;
    let request;
    let response;
    let error;

    switch (tnode.id) {
      case 'node-webhook': {
        const body = jsonOf(task);
        const bytes = Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8');
        summary = `Received a real POST to n8n's production webhook (${bytes} bytes of JSON) and answered 200 immediately (responseMode: onReceived).`;
        break;
      }
      case 'node-normalize': {
        const lead = jsonOf(task) ?? {};
        summary = `Normalized the payload: first name "${lead.firstName ?? ''}", phone ${maskPhone(lead.phone ?? '') || '(none)'} in E.164, email lower-cased, source "${lead.source ?? ''}", interest "${lead.interest ?? ''}".`;
        break;
      }
      case 'node-ghl-upsert': {
        stub = true;
        request = requestOf(lastCall, origin);
        response = responseOf(lastCall);
        const body = /** @type {any} */ (lastCall?.responseBody);
        const contact = body?.contact;
        summary = body?.new
          ? `Upserted the contact in GoHighLevel: created ${contact?.id} with tags ${(contact?.tags ?? []).join(', ')}.`
          : `Upserted the contact in GoHighLevel: matched existing ${contact?.id} and updated it (no duplicate contact).`;
        break;
      }
      case 'node-ghl-sms': {
        stub = true;
        request = requestOf(lastCall, origin);
        response = responseOf(lastCall);
        const reqBody = /** @type {any} */ (lastCall?.requestBody);
        const respBody = /** @type {any} */ (lastCall?.responseBody);
        const maskedTo = maskPhone(jsonOf(runData['Normalize Lead']?.[0])?.phone ?? '');
        artifacts.sms = { to: maskedTo, body: String(reqBody?.message ?? '') };
        summary = `Composed the first-touch SMS to ${maskedTo} and handed it to GoHighLevel (queued as ${respBody?.messageId}).`;
        break;
      }
      case 'node-ghl-email': {
        stub = true;
        request = requestOf(lastCall, origin);
        response = responseOf(lastCall);
        const reqBody = /** @type {any} */ (lastCall?.requestBody);
        const lead = jsonOf(runData['Normalize Lead']?.[0]) ?? {};
        artifacts.email = { subject: String(reqBody?.subject ?? ''), from: String(reqBody?.emailFrom ?? ''), preview: stripHtml(String(reqBody?.html ?? '')) };
        summary = `Composed the branded email "${reqBody?.subject ?? ''}" to ${lead.email ?? ''} and handed it to GoHighLevel.`;
        break;
      }
      case 'node-slack-notify':
      case 'node-slack-escalate': {
        stub = true;
        request = requestOf(lastCall, origin);
        if (errored) {
          error = mapError(task.error);
          response = responseOf(lastCall);
          summary = `Failed: ${error?.message ?? 'Slack rejected the request.'} The execution stopped here (n8n default: no continue-on-fail).`;
        } else {
          response = responseOf(lastCall);
          const reqBody = /** @type {any} */ (lastCall?.requestBody);
          const text = String(reqBody?.text ?? '');
          const channel = String(reqBody?.channel ?? '');
          if (tnode.id === 'node-slack-escalate') artifacts.slackEscalation = { channel, text };
          else artifacts.slack = { channel, text };
          summary = `Posted to ${channel}: "${preview(text, 96)}"`;
        }
        break;
      }
      case 'node-sheets-log': {
        stub = true;
        // The last /sheets/ call in this node's cluster that actually wrote
        // data is a values.update PUT (see stubhouse/server.mjs's doc
        // comment on handleSheetsPlumbing for why n8n takes that path
        // rather than POST .../values/{range}:append here).
        const writeCall = [...calls].reverse().find((c) => c.method === 'PUT') ?? lastCall;
        request = requestOf(writeCall, origin);
        response = responseOf(writeCall);
        const values = /** @type {any} */ (writeCall?.requestBody)?.values?.[0] ?? [];
        // Column order mirrors content/workflow.json's own columns.value key order.
        const columnNames = ['receivedAt', 'firstName', 'lastName', 'phone', 'email', 'interest', 'source', 'firstTouch'];
        artifacts.sheetRow = columnNames.map((column, i) => ({ column, value: String(values[i] ?? '') }));
        summary = `Appended one row (${values.length} columns) to sheet "Leads" — n8n resolved the sheet, reserved a row, and wrote the values across ${calls.length} real HTTP calls (see execution.json for all of them).`;
        break;
      }
      case 'node-wait': {
        summary = 'Held the execution for 15 minutes (workflow parameter). n8n genuinely suspended and resumed the execution via its own Wait-node resume mechanism — the timestamps below are real elapsed wall-clock time, not scaled or shortened for this recording.';
        break;
      }
      case 'node-ghl-checkreply': {
        stub = true;
        request = requestOf(lastCall, origin);
        response = responseOf(lastCall);
        const respBody = /** @type {any} */ (lastCall?.responseBody);
        const direction = respBody?.conversations?.[0]?.lastMessageDirection ?? 'none';
        summary = `Searched the contact's conversation: last message direction "${direction}".`;
        break;
      }
      case 'node-if-replied': {
        // n8n's If node reports two output branches in data.main:
        // [trueItems, falseItems]. jsonOf() (main[0][0].json) is wrong here
        // whenever the false branch is the one that actually carried data —
        // exactly the no-reply case, main[0] is an empty array. Which
        // branch is non-empty IS the true/false verdict; read the item from
        // that branch, not from a hardcoded index.
        const branches = task?.data?.main ?? [];
        const trueItems = branches[0] ?? [];
        const falseItems = branches[1] ?? [];
        const replied = trueItems.length > 0;
        const out = (replied ? trueItems : falseItems)[0]?.json;
        const direction = out?.conversations?.[0]?.lastMessageDirection ?? 'none';
        summary = `Evaluated Replied? as ${replied}: lastMessageDirection was "${direction}", so the execution continued on the ${replied ? 'human-takeover' : 'no-reply'} branch.`;
        break;
      }
      case 'node-human-takeover': {
        summary = 'Lead replied inside 15 minutes; the conversation lives in the GHL inbox from here (NoOp — a real deployment marks the handoff, nothing to execute).';
        break;
      }
      case 'node-voiceai-stub': {
        stub = true;
        summary = 'NoOp: STUB. See sticky note — the Voice AI agent is configured inside GHL, not built in n8n. This marks the handoff point. No call happened.';
        break;
      }
      default:
        summary = 'Ran.';
    }

    nodes.push({
      ...base,
      status: errored ? 'error' : 'success',
      startedAt: startMs, // epoch ms for now; caller formats with the run's offset in a second pass
      finishedAt: finishMs,
      summary,
      stub,
      ...(request ? { request } : {}),
      ...(response ? { response } : {}),
      ...(error ? { error } : {}),
    });
    lastFinishMs = finishMs;

    if (errored) {
      artifacts.errorWorkflow = {
        fired: true,
        assumed: true, // the error workflow is prescribed by the deployment runbook, not part of workflow.json — see docs/DEVIATIONS.md
        trigger: { node: tnode.name, message: error?.message ?? 'The node failed.' },
        alert: { channel: 'slack', status: 'error', reason: 'the error workflow posts through the same revoked Slack credential, so its alert failed too' },
      };
      // Every node after the halt point is not-run.
      break;
    }
  }

  // Any topology node after a halt (or simply never reached) that the loop
  // above never appended yet still needs a not-run row.
  const seenIds = new Set(nodes.map((n) => n.id));
  for (const tnode of topology.nodes) {
    if (seenIds.has(tnode.id)) continue;
    nodes.push({
      id: tnode.id,
      name: tnode.name,
      type: tnode.type,
      typeVersion: tnode.typeVersion,
      status: 'not-run',
      startedAt: null,
      finishedAt: null,
      stub: false,
      summary: `Not reached: the execution stopped before "${tnode.name}".`,
    });
  }
  // Restore topology order (the halt-break above can leave the not-run tail correctly ordered already, but be explicit).
  nodes.sort((a, b) => topology.nodes.findIndex((n) => n.id === a.id) - topology.nodes.findIndex((n) => n.id === b.id));

  // --- Second pass: absolute ISO timestamps, all sharing one offset.
  const captureOffsetMinutes = -new Date().getTimezoneOffset();
  const t0Ms = nodes.find((n) => n.id === METRIC_NODE_IDS.t0)?.startedAt;
  if (typeof t0Ms !== 'number') throw new Error('build-run-file: webhook node has no captured start time');
  for (const n of nodes) {
    if (typeof n.startedAt === 'number') n.startedAt = formatIso(n.startedAt, captureOffsetMinutes);
    if (typeof n.finishedAt === 'number') n.finishedAt = formatIso(n.finishedAt, captureOffsetMinutes);
  }
  const startedAtIso = formatIso(t0Ms, captureOffsetMinutes);

  // --- metrics, computed the same way packages/schema/src/run.ts's cross-check recomputes them.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sinceT0 = (id) => {
    const n = byId.get(id);
    if (!n || n.status !== 'success' || !n.finishedAt) return null;
    return epochMs(n.finishedAt) - t0Ms;
  };
  const wait = byId.get(METRIC_NODE_IDS.wait);
  const waitMs = wait && wait.status === 'success' && wait.startedAt && wait.finishedAt ? epochMs(wait.finishedAt) - epochMs(wait.startedAt) : null;
  let endMs = t0Ms;
  for (const n of nodes) if (n.finishedAt) endMs = Math.max(endMs, epochMs(n.finishedAt));

  const status = nodes.some((n) => n.status === 'error') ? 'error' : 'success';

  const run = {
    schema: 1,
    id: runId,
    mode: 'recording',
    scenario,
    business: { name: 'Radiant Aesthetics', fictional: true },
    producedAt,
    startedAt: startedAtIso,
    workflow: { id: topology.id, name: topology.name, source: 'content/workflow.json', sha256: workflowSha256 },
    n8n: n8nInfo,
    real: REAL_SYSTEMS,
    stubbed: STUBBED_SYSTEMS,
    simulated: SIMULATED_FOR_RECORDING,
    faults:
      scenario === 'slack-revoked'
        ? [
            {
              seam: 'slack-401',
              node: 'Notify Owner (Slack)',
              detail: 'stubhouse answered chat.postMessage with 401 invalid_auth for this capture, simulating a revoked Slack bot token. Both Slack nodes share the credential.',
            },
          ]
        : [],
    duplicate: null,
    status,
    nodes,
    artifacts,
    metrics: {
      firstTouchDispatchMs: sinceT0(METRIC_NODE_IDS.firstTouch),
      ownerNotifiedMs: sinceT0(METRIC_NODE_IDS.ownerNotified),
      waitMs,
      totalMs: endMs - t0Ms,
    },
    redaction: { phoneMasked: true, headersRedacted: true },
  };

  // Redact before validating/returning — masks any phone-shaped string that
  // slipped into a preview/body, exactly like the engine does (Spec section
  // 4, decision 3: "redaction at capture, never at render").
  return RunFileSchema.parse(redactDeep(run));
}
