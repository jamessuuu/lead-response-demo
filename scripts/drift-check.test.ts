/**
 * Vitest-visible coverage for the drift check (Spec section 8, "Run file
 * invalid / drifted from workflow.json | build fails"; Spec section 16,
 * acceptance criterion 9), specifically for the two M1 recordings.
 * `scripts/drift-check.ts` already runs this comparison for every
 * committed run as a standalone CI step (`pnpm check:drift`) -- this file
 * makes the same fact assertable from `pnpm test` directly, using the same
 * public `@lrd/engine`/`@lrd/schema` exports drift-check.ts itself calls
 * (no private logic is duplicated or re-implemented here).
 *
 * It also closes a gap `pnpm check:drift` cannot: that check only proves a
 * run's nodes match `content/workflow.json`, the copy committed to this
 * repo. It says nothing about whether that copy still matches the real
 * external source Spec section 5 names --
 * `service-samples/automations/speed-to-lead/workflow.json`
 * (`content/workflow.provenance.json` records the one-time copy). That
 * sibling folder is a local, personal-machine checkout -- not part of this
 * repo, not present in a clean CI clone (this repo's own
 * .github/workflows/ci.yml does a plain `actions/checkout@v4` of this repo
 * alone) -- so the second describe block below runs for real on this
 * machine right now (closing the loop concretely, as asked) and skips
 * itself wherever that sibling isn't there to check, exactly like the
 * recording-gated tests in packages/schema/test/run.test.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeSignatures, parseTopology } from '@lrd/engine';
import { validateRunDirectory, type NodeEvent } from '@lrd/schema';

const ROOT = join(import.meta.dirname, '..');
const WORKFLOW_PATH = join(ROOT, 'content/workflow.json');
const PROVENANCE_PATH = join(ROOT, 'content/workflow.provenance.json');
const SERVICE_SAMPLE_WORKFLOW_PATH = join(
  ROOT,
  '..',
  'service-samples',
  'automations',
  'speed-to-lead',
  'workflow.json',
);

function signatureOf(n: NodeEvent) {
  return { id: n.id, name: n.name, type: n.type, typeVersion: n.typeVersion };
}

function loadRunNodes(id: string): NodeEvent[] {
  const dir = join(ROOT, 'content/runs', id);
  const raw = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const run = validateRunDirectory({ run: raw, files: readdirSync(dir) });
  return [...run.nodes];
}

describe('drift check — the two M1 recordings against content/workflow.json (Spec section 8/16 criterion 9)', () => {
  const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');
  const expected = JSON.stringify(nodeSignatures(parseTopology(JSON.parse(workflowText))));

  for (const id of ['rec-medspa-happy', 'rec-medspa-slack-401'] as const) {
    const runPath = join(ROOT, 'content/runs', id, 'run.json');

    it.skipIf(!existsSync(runPath))(
      `${id}: node list (id/name/type/typeVersion, in order) matches content/workflow.json exactly`,
      () => {
        const actual = JSON.stringify(loadRunNodes(id).map(signatureOf));
        expect(actual).toBe(expected);
      },
    );
  }
});

describe('provenance — content/workflow.json is still the real service-samples file, byte for byte', () => {
  it.skipIf(!existsSync(SERVICE_SAMPLE_WORKFLOW_PATH))(
    'content/workflow.json matches service-samples/automations/speed-to-lead/workflow.json (Spec section 5\'s named source) exactly',
    () => {
      const sourceText = readFileSync(SERVICE_SAMPLE_WORKFLOW_PATH, 'utf8');
      const sourceSha256 = createHash('sha256').update(sourceText, 'utf8').digest('hex');
      const copySha256 = createHash('sha256').update(readFileSync(WORKFLOW_PATH, 'utf8'), 'utf8').digest('hex');
      expect(copySha256).toBe(sourceSha256);

      // The provenance file's own recorded hash must agree too, so a future
      // re-copy that forgets to update it is caught here, not just by eye.
      const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf8'));
      expect(provenance.sha256).toBe(copySha256);
    },
  );
});
