import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunFile, modeChip, numberFlag } from '../src/index.ts';

/**
 * Dispatcher-added M1 requirement (blocking): metrics.firstTouchDispatchMs
 * is 114-115ms *because the integrations are local stubs* -- wherever that
 * number is rendered (site/src/pages/index.astro's hero today; the demo
 * ledger and a future OG image/README figure later), the condition must
 * ship on the same surface, never a bare "0.1 s" beside the 42-hour HBR
 * claim. numberFlag() is the one function every such surface calls
 * (site/src/pages/index.astro renders it directly beneath .hero__number;
 * see tests/e2e/site.spec.ts for the rendered-HTML assertion) -- this
 * pins its text so the condition can't quietly get typed back out.
 *
 * Also covers a second, related bug found while fixing this: the
 * Simulator mode chip asserted "because no n8n recording exists yet",
 * which became false the moment M1 committed two real recordings right
 * next to it on the same /demo page.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

function loadRun(id: string): RunFile {
  return RunFile.parse(JSON.parse(readFileSync(join(ROOT, 'content/runs', id, 'run.json'), 'utf8')));
}

/** Re-labels a committed simulator run as a "recording" (mirrors run.test.ts's own helper) so
 * this test does not depend on the two real M1 recordings being present on disk at test time. */
function toRecordingShape(sim: RunFile): unknown {
  const { simulator: _simulator, ...rest } = sim as unknown as Record<string, unknown>;
  return {
    ...rest,
    mode: 'recording',
    real: ['n8n', 'webhook', 'normalize', 'wait', 'branch'],
    stubbed: ['gohighlevel', 'slack', 'google-sheets', 'voice-ai'],
    simulated: [],
    n8n: { version: '2.36.8', executionId: '1', mode: 'webhook' },
  };
}

describe('numberFlag — a recording never states a bare "measured" claim', () => {
  const recording = RunFile.parse(toRecordingShape(loadRun('sim-medspa-happy')));

  it('names both the stub basis and GoHighLevel specifically, not just "measured"', () => {
    const flag = numberFlag(recording);
    expect(flag).toMatch(/measured/i);
    expect(flag).toMatch(/stub/i);
    expect(flag).toMatch(/gohighlevel/i);
    expect(flag).not.toBe('measured');
    expect(flag.length).toBeGreaterThan('measured'.length + 20); // not a token-only claim
  });

  it('a simulator run never claims a real network call of any kind', () => {
    const sim = loadRun('sim-medspa-happy');
    const flag = numberFlag(sim);
    expect(flag).toMatch(/modeled/i);
    expect(flag).not.toMatch(/\bmeasured\b/i);
  });

  for (const id of ['rec-medspa-happy', 'rec-medspa-slack-401'] as const) {
    const runPath = join(ROOT, 'content/runs', id, 'run.json');

    it.skipIf(!existsSync(runPath))(`${id}: the real recording's own flag carries the same condition`, () => {
      const run = loadRun(id);
      const flag = numberFlag(run);
      expect(flag).toMatch(/stub/i);
      expect(flag).toMatch(/gohighlevel/i);
      expect(flag).toContain(run.n8n?.version ?? '\0'); // fails loudly if n8n block is missing
    });
  }
});

describe('modeChip — the Simulator label states no claim about the world that can go stale', () => {
  it('does not say "because no n8n recording exists yet" (false as of M1 — two recordings exist)', () => {
    for (const id of [
      'sim-medspa-happy',
      'sim-medspa-slack-revoked',
      'sim-medspa-ghl-429',
      'sim-medspa-duplicate',
      'sim-medspa-reply-timeout',
    ]) {
      const chip = modeChip(loadRun(id));
      expect(chip.text.toLowerCase()).not.toContain('no n8n recording exists');
    }
  });

  it('still states the timing basis is modeled, not measured', () => {
    const chip = modeChip(loadRun('sim-medspa-happy'));
    expect(chip.text).toMatch(/modeled timing table/i);
    expect(chip.text).toMatch(/not measured/i);
  });
});
