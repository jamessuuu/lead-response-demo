import { describe, expect, it } from 'vitest';
import { RunFile, type Scenario } from '@lrd/schema';
import { execute, renderRunFile } from '../src/execute.ts';
import { baseOptions } from './fixtures.ts';

/**
 * Golden traces: one committed run.json per scenario, byte-identical.
 * `toMatchFileSnapshot` writes the file on first run (that write IS the
 * commit — review the diff like any other change) and fails the assertion
 * on any later mismatch. This is the same executor the site and
 * scripts/generate-runs.ts call; a change to execute.ts, the timing table,
 * or content/workflow.json that alters output shows up here first.
 */
const SCENARIOS: readonly Scenario[] = ['happy', 'slack-revoked', 'ghl-429', 'duplicate', 'reply-timeout'];

describe('execute — golden traces', () => {
  for (const scenario of SCENARIOS) {
    it(`produces a byte-identical, schema-valid run for "${scenario}"`, async () => {
      const run = execute(baseOptions(scenario));
      // execute() already validates internally (RunFileSchema.parse(redactDeep(run)));
      // parsing again here documents that contract for the reader and fails
      // loudly if a future refactor ever lets an invalid run leave execute().
      expect(() => RunFile.parse(run)).not.toThrow();
      await expect(renderRunFile(run)).toMatchFileSnapshot(`./golden/${scenario}.run.json`);
    });
  }

  it('is deterministic: identical options produce byte-identical output on every call', () => {
    const a = renderRunFile(execute(baseOptions('slack-revoked')));
    const b = renderRunFile(execute(baseOptions('slack-revoked')));
    const c = renderRunFile(execute(baseOptions('slack-revoked')));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('a different seed changes the sampled timings but not the topology or artifacts', () => {
    const a = execute(baseOptions('happy', { seed: 1 }));
    const b = execute(baseOptions('happy', { seed: 99999 }));
    expect(a.nodes.map((n) => n.status)).toEqual(b.nodes.map((n) => n.status));
    expect(a.artifacts.sms?.body).toBe(b.artifacts.sms?.body);
    expect(renderRunFile(a)).not.toBe(renderRunFile(b));
  });
});

describe('execute — scenario semantics (Spec section 11, the seam moment)', () => {
  it('happy: every node completes except the disabled placeholder and the untaken branch; every artifact composed', () => {
    const run = execute(baseOptions('happy'));
    expect(run.status).toBe('success');
    expect(run.nodes.map((n) => n.status)).toEqual([
      'success', // Lead Webhook
      'success', // Normalize Lead
      'disabled', // Enrichment (placeholder)
      'success', // GHL: Upsert Contact
      'success', // GHL: Send Instant SMS
      'success', // GHL: Send Branded Email
      'success', // Notify Owner (Slack)
      'success', // Log to Google Sheets
      'success', // Wait 15 Minutes
      'success', // GHL: Check for Reply
      'success', // Replied?
      'not-run', // Replied — Human Takes Over (branch not taken: no reply)
      'success', // Voice AI Callback (stub)
      'success', // Escalate: No Reply (Slack)
    ]);
    expect(run.artifacts.sms).not.toBeNull();
    expect(run.artifacts.email).not.toBeNull();
    expect(run.artifacts.slack).not.toBeNull();
    expect(run.artifacts.sheetRow).not.toBeNull();
    expect(run.artifacts.slackEscalation).not.toBeNull();
    expect(run.artifacts.errorWorkflow).toBeNull();
    expect(run.metrics.firstTouchDispatchMs).not.toBeNull();
    expect(run.metrics.ownerNotifiedMs).not.toBeNull();
    expect(run.metrics.waitMs).toBe(900_000);
    expect(run.duplicate).toBeNull();
    expect(run.faults).toHaveLength(0);
  });

  it('slack-revoked: first touch lands, the owner alert silently fails, nothing downstream runs', () => {
    const run = execute(baseOptions('slack-revoked'));
    const byId = new Map(run.nodes.map((n) => [n.id, n]));
    expect(run.status).toBe('error');
    expect(byId.get('node-ghl-sms')?.status).toBe('success');
    expect(byId.get('node-slack-notify')?.status).toBe('error');
    expect(byId.get('node-slack-notify')?.error?.code).toBe('invalid_auth');
    expect(byId.get('node-sheets-log')?.status).toBe('not-run');
    expect(run.artifacts.sms).not.toBeNull();
    expect(run.artifacts.email).not.toBeNull();
    // The failed call composed nothing — a Slack card must never render for this run.
    expect(run.artifacts.slack).toBeNull();
    expect(run.metrics.firstTouchDispatchMs).not.toBeNull();
    // The point of this seam: the owner was never actually notified.
    expect(run.metrics.ownerNotifiedMs).toBeNull();
    expect(run.artifacts.errorWorkflow?.fired).toBe(true);
    expect(run.artifacts.errorWorkflow?.alert.status).toBe('error');
    expect(run.faults).toEqual([
      {
        seam: 'slack-401',
        node: 'Notify Owner (Slack)',
        detail:
          'Slack bot token revoked: every chat.postMessage answers 401 invalid_auth. Both Slack nodes and the error workflow share the credential.',
      },
    ]);
  });

  it('ghl-429: fails at the very first outbound call — nothing dispatches at all', () => {
    const run = execute(baseOptions('ghl-429'));
    const byId = new Map(run.nodes.map((n) => [n.id, n]));
    expect(run.status).toBe('error');
    expect(byId.get('node-ghl-upsert')?.status).toBe('error');
    expect(byId.get('node-ghl-upsert')?.error?.httpStatus).toBe(429);
    expect(byId.get('node-ghl-sms')?.status).toBe('not-run');
    expect(run.metrics.firstTouchDispatchMs).toBeNull();
    expect(run.metrics.ownerNotifiedMs).toBeNull();
    expect(run.artifacts.sms).toBeNull();
    expect(run.artifacts.slack).toBeNull();
    // Slack itself is unaffected by this fault — its own credential is fine.
    expect(run.artifacts.errorWorkflow?.alert.status).toBe('success');
  });

  it('duplicate: runs the full happy path, marked as a repeat delivery, matches the existing contact', () => {
    const run = execute(baseOptions('duplicate'));
    expect(run.status).toBe('success');
    expect(run.duplicate).toEqual({ of: 'fixture-happy', deliveredAfterMs: 1400, cause: 'form double-submit' });
    expect(run.nodes[0]?.summary).toContain('second delivery of the same payload');
    expect(run.faults[0]?.seam).toBe('duplicate-webhook');
  });

  it('reply-timeout: first touch and owner notification succeed, the reply check times out after the wait', () => {
    const run = execute(baseOptions('reply-timeout'));
    const byId = new Map(run.nodes.map((n) => [n.id, n]));
    expect(run.status).toBe('error');
    expect(run.metrics.firstTouchDispatchMs).not.toBeNull();
    expect(run.metrics.ownerNotifiedMs).not.toBeNull();
    expect(run.metrics.waitMs).toBe(900_000);
    expect(byId.get('node-ghl-checkreply')?.status).toBe('error');
    expect(byId.get('node-ghl-checkreply')?.error?.code).toBe('ETIMEDOUT');
    expect(byId.get('node-if-replied')?.status).toBe('not-run');
  });

  it('the human-takeover branch runs when the reply check finds an inbound reply', () => {
    const run = execute(baseOptions('happy', { replyDirection: 'inbound' }));
    const byId = new Map(run.nodes.map((n) => [n.id, n]));
    expect(byId.get('node-human-takeover')?.status).toBe('success');
    expect(byId.get('node-voiceai-stub')?.status).toBe('not-run');
    expect(byId.get('node-slack-escalate')?.status).toBe('not-run');
    expect(run.artifacts.slackEscalation).toBeNull();
  });
});
