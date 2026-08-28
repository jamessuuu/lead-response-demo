// Spec section 4, decision 3: "redaction at capture, never at render... CI
// greps committed runs for secret-shaped strings." scripts/check-secrets.mjs
// already does this over the whole tracked tree as a CI step
// (`pnpm check:secrets`) -- this makes the content/runs/**-specific claim
// assertable from `pnpm test` directly, reusing that script's own exported
// PATTERNS/walk/scanText rather than a second, driftable copy of the
// secret-shaped-string vocabulary.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanText, walk } from './check-secrets.mjs';

const ROOT = join(import.meta.dirname, '..');
const RUNS_DIR = join(ROOT, 'content/runs');

describe('secret scan — content/runs/** specifically (Spec section 4, decision 3)', () => {
  it('finds zero secret-shaped strings across every committed run file (run.json, execution.json, attest.json)', () => {
    const files = walk(RUNS_DIR);
    expect(files.length).toBeGreaterThan(0); // fails loudly if content/runs/ is ever empty, rather than passing vacuously

    const hits = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      hits.push(...scanText(rel, readFileSync(file, 'utf8')));
    }
    expect(hits).toEqual([]);
  });

  it('sanity check: the scan actually flags a planted secret-shaped string (proves the patterns are live, not vacuously passing)', () => {
    // Built from parts at runtime, not as one literal, so this fixture file
    // itself never contains a contiguous secret-shaped string on disk (the
    // same discipline scripts/generate-runs.ts's own M0 commit note
    // describes for exactly this reason).
    const plantedBearer = scanText('fixture.txt', 'Authorization: ' + 'Bearer ' + 'x'.repeat(40));
    expect(plantedBearer.length).toBeGreaterThan(0);

    const akiaPrefix = ['A', 'K', 'I', 'A'].join('');
    const plantedAwsKey = scanText('fixture.txt', akiaPrefix + '0123456789ABCDEF');
    expect(plantedAwsKey.length).toBeGreaterThan(0);

    const maskedPhone = scanText('fixture.txt', 'to: "+1512' + '•••' + '0134"'); // the real redacted shape must never trip the scan
    expect(maskedPhone).toEqual([]);
  });
});
