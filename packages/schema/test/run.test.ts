import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunFile, validateRunDirectory, epochMs, METRIC_NODE_IDS } from '../src/index.ts';

/**
 * REQUIRED_SIBLINGS / validateRunDirectory tests, added alongside the first
 * real capture (M1) — capture/README.md flagged this gap at M0: "no test
 * file exists for it yet either; add one alongside the first real capture."
 *
 * The structural tests below build a synthetic "recording" by taking a
 * committed simulator run and re-labelling its mode/real/stubbed/simulated
 * fields (nodes/metrics/artifacts stay byte-identical — they aren't
 * mode-dependent) rather than hand-authoring a second full fixture that
 * could quietly drift from what the schema actually requires. This keeps
 * the sibling-file tests independent of whether a real capture has been
 * run yet; the tests further down load the REAL committed recordings.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SIM_HAPPY_PATH = join(ROOT, 'content/runs/sim-medspa-happy/run.json');

function loadSimHappy(): unknown {
  return JSON.parse(readFileSync(SIM_HAPPY_PATH, 'utf8'));
}

/** Re-labels a valid simulator run object as a "recording" (see file header). */
function toRecordingShape(sim: any): unknown {
  const { simulator, ...rest } = sim;
  return {
    ...rest,
    mode: 'recording',
    real: ['n8n', 'webhook', 'normalize', 'wait', 'branch'],
    stubbed: ['gohighlevel', 'slack', 'google-sheets', 'voice-ai'],
    simulated: [],
    n8n: { version: '2.36.8', executionId: '1', mode: 'webhook' },
  };
}

describe('validateRunDirectory / REQUIRED_SIBLINGS (Spec section 4)', () => {
  const recording = toRecordingShape(loadSimHappy());

  it('parses on its own via RunFile (the recording-mode cross-checks are satisfied)', () => {
    expect(() => RunFile.parse(recording)).not.toThrow();
  });

  it('rejects a "recording" whose directory is missing execution.json', () => {
    expect(() => validateRunDirectory({ run: recording, files: ['run.json', 'attest.json'] })).toThrow(
      /execution\.json/,
    );
  });

  it('rejects a "recording" whose directory is missing attest.json', () => {
    expect(() => validateRunDirectory({ run: recording, files: ['run.json', 'execution.json'] })).toThrow(
      /attest\.json/,
    );
  });

  it('rejects a "recording" missing both siblings, naming both in one message', () => {
    expect(() => validateRunDirectory({ run: recording, files: ['run.json'] })).toThrow(
      /execution\.json and attest\.json/,
    );
  });

  it('accepts a "recording" whose directory has both siblings', () => {
    const validated = validateRunDirectory({ run: recording, files: ['run.json', 'execution.json', 'attest.json'] });
    expect(validated.mode).toBe('recording');
  });

  it('a "simulator" run needs no siblings at all', () => {
    const sim = loadSimHappy();
    const validated = validateRunDirectory({ run: sim, files: ['run.json'] });
    expect(validated.mode).toBe('simulator');
  });
});

describe('the two real M1 recordings, if committed', () => {
  const RECORDINGS = ['rec-medspa-happy', 'rec-medspa-slack-401'] as const;

  for (const id of RECORDINGS) {
    const dir = join(ROOT, 'content/runs', id);
    const runPath = join(dir, 'run.json');

    it.skipIf(!existsSync(runPath))(`${id}: run.json validates directly against RunFile`, () => {
      const raw = JSON.parse(readFileSync(runPath, 'utf8'));
      const run = RunFile.parse(raw);
      expect(run.mode).toBe('recording');
      expect(run.n8n).toBeTruthy();
      expect(run.real).toContain('n8n');
      expect(run.simulated).toHaveLength(0);
    });

    it.skipIf(!existsSync(runPath))(`${id}: validateRunDirectory accepts it with its real committed siblings`, () => {
      const raw = JSON.parse(readFileSync(runPath, 'utf8'));
      expect(existsSync(join(dir, 'execution.json'))).toBe(true);
      expect(existsSync(join(dir, 'attest.json'))).toBe(true);
      expect(() =>
        validateRunDirectory({ run: raw, files: ['run.json', 'execution.json', 'attest.json'] }),
      ).not.toThrow();
    });

    it.skipIf(!existsSync(runPath))(`${id}: metrics.firstTouchDispatchMs equals the arithmetic over nodes (Spec section 4, decision 1)`, () => {
      const raw = JSON.parse(readFileSync(runPath, 'utf8'));
      const run = RunFile.parse(raw);
      const t0 = epochMs(run.nodes[0]!.startedAt as string);
      const smsNode = run.nodes.find((n) => n.id === METRIC_NODE_IDS.firstTouch);
      const expected = smsNode && smsNode.status === 'success' && smsNode.finishedAt ? epochMs(smsNode.finishedAt) - t0 : null;
      expect(run.metrics.firstTouchDispatchMs).toBe(expected);
    });

    it.skipIf(!existsSync(runPath))(`${id}: attest.json is complete and its n8n block matches run.json's`, () => {
      const run = RunFile.parse(JSON.parse(readFileSync(runPath, 'utf8')));
      const attest = JSON.parse(readFileSync(join(dir, 'attest.json'), 'utf8'));
      expect(attest.n8n.version).toBe(run.n8n?.version);
      expect(attest.n8n.executionId).toBe(run.n8n?.executionId);
      expect(attest.redaction).toEqual({ authHeadersStripped: true, phoneMasked: true });
      expect(attest.stubhouseCommit).toMatch(/^[0-9a-f]{7,40}$/);
      expect(attest.operator).toBeTruthy();
    });
  }
});
