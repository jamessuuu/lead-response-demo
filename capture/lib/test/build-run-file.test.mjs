// Unit coverage for build-run-file.mjs's mapping logic, independent of a
// live n8n capture (that proof is the two committed recordings + the real
// fire-test recorded in docs/PROGRESS.md). This exercises the trickiest
// parts with a hand-built, n8n-execution-shaped fixture: the error-halt
// path (a node fails, the rest of the topology becomes not-run, the error
// workflow artifact is populated), the node-to-stubhouse-call matching,
// and that redaction actually runs before RunFile.parse().
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTopology } from '../../../packages/engine/src/index.ts';
import { buildRunFile } from '../build-run-file.mjs';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const workflow = JSON.parse(readFileSync(join(ROOT, 'content/workflow.json'), 'utf8'));
const topology = parseTopology(workflow);
const WORKFLOW_SHA256 = '0'.repeat(64); // not under test here — schema only checks the string shape

const T0 = Date.parse('2026-08-29T10:00:00.000-05:00');

/** One fake n8n ITaskData entry. */
function task({ startMs, durationMs, json, error }) {
  return [
    {
      startTime: startMs,
      executionTime: durationMs,
      error,
      data: { main: [[{ json }]] },
    },
  ];
}

function baseRunData() {
  return {
    'Lead Webhook (form / ad)': task({ startMs: T0, durationMs: 5, json: { name: 'Alex Rivera', phone: '(512) 555-0134' } }),
    'Normalize Lead': task({
      startMs: T0 + 20,
      durationMs: 15,
      json: { firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', phone: '+15125550134', source: 'website-form', interest: 'lip filler' },
    }),
    'GHL: Upsert Contact': task({ startMs: T0 + 50, durationMs: 400, json: {} }),
  };
}

function baseStubhouseLog() {
  return [
    {
      method: 'POST',
      path: '/ghl/contacts/upsert',
      status: 200,
      requestBody: { firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', phone: '+15125550134' },
      responseBody: { new: true, contact: { id: 'c_test123', tags: ['speed-to-lead'] } },
    },
  ];
}

describe('buildRunFile — error-halt path (slack-401 shape)', () => {
  const runData = {
    ...baseRunData(),
    'GHL: Send Instant SMS': task({ startMs: T0 + 460, durationMs: 300, json: {} }),
    'GHL: Send Branded Email': task({ startMs: T0 + 770, durationMs: 300, json: {} }),
    'Notify Owner (Slack)': task({
      startMs: T0 + 1080,
      durationMs: 50,
      json: {},
      error: { message: 'Slack answered 401 invalid_auth.', name: 'NodeApiError', httpCode: '401' },
    }),
  };
  const stubhouseLog = [
    ...baseStubhouseLog(),
    { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'SMS', message: 'Hi Alex' }, responseBody: { messageId: 'msg_1' } },
    { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'Email', subject: 'Hi', emailFrom: 'a@b.example', html: '<p>hi</p>' }, responseBody: { messageId: 'msg_2' } },
    { method: 'POST', path: '/slack/api/chat.postMessage', status: 401, requestBody: { channel: '#leads', text: 'New lead' }, responseBody: { ok: false, error: 'invalid_auth' } },
  ];

  const run = buildRunFile({
    topology,
    executionData: { resultData: { runData, error: {}, lastNodeExecuted: 'Notify Owner (Slack)' } },
    stubhouseLog,
    runId: 'test-slack-401',
    scenario: 'slack-revoked',
    workflowSha256: WORKFLOW_SHA256,
    producedAt: '2026-08-29T15:00:00.000Z',
    n8nInfo: { version: '2.36.8', executionId: '999', mode: 'webhook' },
  });

  it('is a schema-valid recording (RunFile.parse ran inside buildRunFile without throwing)', () => {
    expect(run.mode).toBe('recording');
    expect(run.status).toBe('error');
  });

  it('marks the Slack node as errored and every node after it as not-run', () => {
    const byId = Object.fromEntries(run.nodes.map((n) => [n.id, n]));
    expect(byId['node-slack-notify'].status).toBe('error');
    expect(byId['node-slack-notify'].error?.message).toContain('401');
    expect(byId['node-sheets-log'].status).toBe('not-run');
    expect(byId['node-wait'].status).toBe('not-run');
    expect(byId['node-ghl-checkreply'].status).toBe('not-run');
  });

  it('still credits the first-touch SMS that dispatched before the halt', () => {
    expect(run.metrics.firstTouchDispatchMs).not.toBeNull();
    expect(run.artifacts.sms?.body).toBeTruthy();
  });

  it('does not credit ownerNotifiedMs or waitMs — the honesty-architecture bug M0 fixed, re-checked here for a real capture shape', () => {
    expect(run.metrics.ownerNotifiedMs).toBeNull();
    expect(run.metrics.waitMs).toBeNull();
  });

  it('populates artifacts.errorWorkflow as assumed (Spec: prescribed by the runbook, not captured)', () => {
    expect(run.artifacts.errorWorkflow).toEqual({
      fired: true,
      assumed: true,
      trigger: { node: 'Notify Owner (Slack)', message: expect.stringContaining('401') },
      alert: { channel: 'slack', status: 'error', reason: expect.any(String) },
    });
  });

  it('redacts the phone number everywhere it could appear, including request/response previews', () => {
    const text = JSON.stringify(run);
    expect(text).not.toContain('5125550134');
    expect(text).not.toContain('+15125550134');
  });

  it('lists real/stubbed/simulated correctly for a recording', () => {
    expect(run.real).toContain('n8n');
    expect(run.simulated).toHaveLength(0);
    expect(run.stubbed).toEqual(expect.arrayContaining(['gohighlevel', 'slack', 'google-sheets', 'voice-ai']));
  });
});

describe('buildRunFile — node-to-stubhouse-call matching for the Sheets node', () => {
  it('picks the PUT call as the representative request/response, not an earlier GET in the same cluster', () => {
    const runData = {
      ...baseRunData(),
      'GHL: Send Instant SMS': task({ startMs: T0 + 460, durationMs: 300, json: {} }),
      'GHL: Send Branded Email': task({ startMs: T0 + 770, durationMs: 300, json: {} }),
      'Notify Owner (Slack)': task({ startMs: T0 + 1080, durationMs: 50, json: {} }),
      'Log to Google Sheets': task({ startMs: T0 + 1140, durationMs: 200, json: {} }),
    };
    const stubhouseLog = [
      ...baseStubhouseLog(),
      { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'SMS', message: 'hi' }, responseBody: { messageId: 'm1' } },
      { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'Email', subject: 's', emailFrom: 'a@b.example', html: '<p>h</p>' }, responseBody: { messageId: 'm2' } },
      { method: 'POST', path: '/slack/api/chat.postMessage', status: 200, requestBody: { channel: '#leads', text: 'lead' }, responseBody: { ok: true } },
      { method: 'GET', path: '/sheets/v4/spreadsheets/doc123', status: 200, responseBody: { sheets: [{ properties: { title: 'Leads' } }] } },
      { method: 'GET', path: "/sheets/v4/spreadsheets/doc123/values/'Leads'", status: 200, responseBody: {} },
      {
        method: 'PUT',
        path: '/sheets/v4/spreadsheets/doc123/values/Leads!2:2',
        status: 200,
        requestBody: { values: [['2026-08-29T15:00:00.000Z', 'Alex', 'Rivera', '+15125550134', 'alex.rivera@example.com', 'lip filler', 'website-form', 'SMS + email (automated)']] },
        responseBody: { updatedRows: 1 },
      },
    ];

    const run = buildRunFile({
      topology,
      executionData: { resultData: { runData, lastNodeExecuted: 'Log to Google Sheets' } },
      stubhouseLog,
      runId: 'test-sheets-match',
      scenario: 'happy',
      workflowSha256: WORKFLOW_SHA256,
      producedAt: '2026-08-29T15:00:00.000Z',
      n8nInfo: { version: '2.36.8', executionId: '1000', mode: 'webhook' },
    });

    expect(run.artifacts.sheetRow).toHaveLength(8);
    expect(run.artifacts.sheetRow?.find((c) => c.column === 'firstName')?.value).toBe('Alex');
    const sheetsNode = run.nodes.find((n) => n.id === 'node-sheets-log');
    expect(sheetsNode?.request?.method).toBe('PUT');
  });
});

describe('buildRunFile — the Wait node reports its RESUME instant as startTime, not when it began waiting', () => {
  // Shape verified against this repo's own first real capture
  // (content/runs/rec-medspa-happy): "Log to Google Sheets" finished at
  // t, and "Wait 15 Minutes"' own runData reported startTime=(t+900018),
  // executionTime=0 — i.e. n8n recorded the RESUME moment as "start", not
  // the ~900000ms real gap since the previous node finished. Left
  // uncorrected, metrics.waitMs comes out 0 for a real 15-minute wait —
  // the opposite of what a recording exists to prove. Timeline here stays
  // relative to this file's own T0 (real captures span two different
  // calendar days across the wait; a fixture mixing a hardcoded absolute
  // epoch into a T0-relative timeline would violate the schema's own
  // monotonic-startedAt cross-check for an unrelated reason).
  const SHEETS_FINISH = T0 + 1100;
  const WAIT_RESUME = SHEETS_FINISH + 900_018;

  it('derives the Wait node startedAt from the previous node finishing, not from its own reported startTime', () => {
    const runData = {
      ...baseRunData(),
      'GHL: Send Instant SMS': task({ startMs: T0 + 460, durationMs: 300, json: {} }),
      'GHL: Send Branded Email': task({ startMs: T0 + 770, durationMs: 300, json: {} }),
      'Notify Owner (Slack)': task({ startMs: T0 + 1080, durationMs: 15, json: {} }),
      'Log to Google Sheets': task({ startMs: SHEETS_FINISH - 20, durationMs: 20, json: {} }),
      'Wait 15 Minutes': task({ startMs: WAIT_RESUME, durationMs: 0, json: {} }),
    };
    const stubhouseLog = [
      ...baseStubhouseLog(),
      { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'SMS', message: 'hi' }, responseBody: { messageId: 'm1' } },
      { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'Email', subject: 's', emailFrom: 'a@b.example', html: '<p>h</p>' }, responseBody: { messageId: 'm2' } },
      { method: 'POST', path: '/slack/api/chat.postMessage', status: 200, requestBody: { channel: '#leads', text: 'lead' }, responseBody: { ok: true } },
      { method: 'GET', path: '/sheets/v4/spreadsheets/doc123', status: 200, responseBody: { sheets: [{ properties: { title: 'Leads' } }] } },
      { method: 'GET', path: "/sheets/v4/spreadsheets/doc123/values/'Leads'", status: 200, responseBody: {} },
      { method: 'PUT', path: '/sheets/v4/spreadsheets/doc123/values/Leads!2:2', status: 200, requestBody: { values: [['x']] }, responseBody: { updatedRows: 1 } },
    ];

    const run = buildRunFile({
      topology,
      executionData: { resultData: { runData, lastNodeExecuted: 'Wait 15 Minutes' } },
      stubhouseLog,
      runId: 'test-wait-resume',
      scenario: 'happy',
      workflowSha256: WORKFLOW_SHA256,
      producedAt: '2026-08-29T15:00:00.000Z',
      n8nInfo: { version: '2.36.8', executionId: '1001', mode: 'webhook' },
    });

    // ~900018ms in this fixture, real ~900000ms in the actual capture —
    // either way, nowhere near the 0 the uncorrected startTime would give.
    expect(run.metrics.waitMs).toBeGreaterThan(890_000);
    expect(run.metrics.waitMs).toBeLessThan(910_000);
  });
});

describe('buildRunFile — the If node reports data.main as [trueItems, falseItems]', () => {
  // n8n's If node puts the item that took the branch in ONE of two output
  // arrays, not always index 0 — reading main[0][0] unconditionally (as a
  // naive port of the happy path might) returns undefined whenever the
  // FALSE branch is the one that actually ran, which is exactly the
  // committed happy scenario (no reply within the wait). A fixture that
  // only ever exercises the true branch would never catch this.
  function ifNodeTask({ startMs, durationMs, repliedBranchTaken, direction }) {
    const item = { json: { conversations: [{ lastMessageDirection: direction }] } };
    return [
      {
        startTime: startMs,
        executionTime: durationMs,
        data: { main: repliedBranchTaken ? [[item], []] : [[], [item]] },
      },
    ];
  }

  it('reports replied=false and the real observed direction when only the FALSE branch carried data', () => {
    const runData = {
      ...baseRunData(),
      'GHL: Send Instant SMS': task({ startMs: T0 + 460, durationMs: 300, json: {} }),
      'GHL: Send Branded Email': task({ startMs: T0 + 770, durationMs: 300, json: {} }),
      'Notify Owner (Slack)': task({ startMs: T0 + 1080, durationMs: 15, json: {} }),
      'Log to Google Sheets': task({ startMs: T0 + 1100, durationMs: 20, json: {} }),
      'Wait 15 Minutes': task({ startMs: T0 + 901_120, durationMs: 0, json: {} }),
      'GHL: Check for Reply': task({ startMs: T0 + 901_130, durationMs: 15, json: { conversations: [{ lastMessageDirection: 'outbound' }] } }),
      'Replied?': ifNodeTask({ startMs: T0 + 901_150, durationMs: 3, repliedBranchTaken: false, direction: 'outbound' }),
    };
    const stubhouseLog = [
      ...baseStubhouseLog(),
      { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'SMS', message: 'hi' }, responseBody: { messageId: 'm1' } },
      { method: 'POST', path: '/ghl/conversations/messages', status: 200, requestBody: { type: 'Email', subject: 's', emailFrom: 'a@b.example', html: '<p>h</p>' }, responseBody: { messageId: 'm2' } },
      { method: 'POST', path: '/slack/api/chat.postMessage', status: 200, requestBody: { channel: '#leads', text: 'lead' }, responseBody: { ok: true } },
      { method: 'GET', path: '/sheets/v4/spreadsheets/doc123', status: 200, responseBody: { sheets: [{ properties: { title: 'Leads' } }] } },
      { method: 'GET', path: "/sheets/v4/spreadsheets/doc123/values/'Leads'", status: 200, responseBody: {} },
      { method: 'PUT', path: '/sheets/v4/spreadsheets/doc123/values/Leads!2:2', status: 200, requestBody: { values: [['x']] }, responseBody: { updatedRows: 1 } },
      { method: 'GET', path: '/ghl/conversations/search?locationId=loc_demo_radiant&contactId=c_test123', status: 200, responseBody: { conversations: [{ lastMessageDirection: 'outbound' }] } },
    ];

    const run = buildRunFile({
      topology,
      executionData: { resultData: { runData, lastNodeExecuted: 'Replied?' } },
      stubhouseLog,
      runId: 'test-if-replied',
      scenario: 'happy',
      workflowSha256: WORKFLOW_SHA256,
      producedAt: '2026-08-29T15:00:00.000Z',
      n8nInfo: { version: '2.36.8', executionId: '1002', mode: 'webhook' },
    });

    const ifNode = run.nodes.find((n) => n.id === 'node-if-replied');
    expect(ifNode?.summary).toContain('Evaluated Replied? as false');
    expect(ifNode?.summary).toContain('"outbound"');
    expect(ifNode?.summary).not.toContain('"none"'); // the bug: reading the empty true-branch item defaults to 'none'
  });
});

describe('buildRunFile — popCalls refuses to mis-attribute a call from the wrong service', () => {
  it('throws rather than silently crediting an unrelated stubhouse call to a node', () => {
    const runData = {
      ...baseRunData(),
    };
    // A stray Slack call sitting where "GHL: Send Instant SMS"'s real
    // ghl.conversations.messages call should be — simulates the
    // node-to-call matching drifting from what stubhouse actually logged
    // (the exact failure mode EXPECTED_CALLS/SERVICE_FOR_NODE exists to
    // catch). Note relevantCalls() already strips anything that ISN'T
    // ghl/slack/sheets-prefixed (e.g. a stray /oauth/token entry), so the
    // mismatch has to be a call from one of the three real services, just
    // the wrong one, to ever reach popCalls's own check.
    const stubhouseLog = [...baseStubhouseLog(), { method: 'POST', path: '/slack/api/chat.postMessage', status: 200, requestBody: { channel: '#leads', text: 'wrong call' }, responseBody: { ok: true } }];
    const runDataWithSms = {
      ...runData,
      'GHL: Send Instant SMS': task({ startMs: T0 + 460, durationMs: 300, json: {} }),
    };

    expect(() =>
      buildRunFile({
        topology,
        executionData: { resultData: { runData: runDataWithSms, lastNodeExecuted: 'GHL: Send Instant SMS' } },
        stubhouseLog,
        runId: 'test-service-mismatch',
        scenario: 'happy',
        workflowSha256: WORKFLOW_SHA256,
        producedAt: '2026-08-29T15:00:00.000Z',
        n8nInfo: { version: '2.36.8', executionId: '1003', mode: 'webhook' },
      }),
    ).toThrow(/expected node-ghl-sms's next stubhouse call to be a "ghl" call/);
  });
});
