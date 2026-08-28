/**
 * Drift check (Spec section 8: "Run file invalid / drifted from
 * workflow.json | build fails"). For every committed content/runs/<id>/,
 * this asserts:
 *
 *  1. The run validates against the schema, together with its directory
 *     listing (validateRunDirectory) -- a "recording" missing its
 *     execution.json/attest.json siblings is rejected here.
 *  2. run.workflow.sha256 equals the sha256 of the CURRENT
 *     content/workflow.json.
 *  3. run.nodes[], reduced to {id, name, type, typeVersion} in order, equals
 *     nodeSignatures(parseTopology(the current workflow.json)) exactly.
 *
 * Check 3 is the one that matters even for a future recording (M1): a
 * recording cannot be regenerated the way a simulator run can (it is a real
 * n8n capture), so byte-identical regeneration (check:runs) cannot apply to
 * it -- but its node list must still match the workflow file. This script is
 * the mechanism that stays true for both modes; check:runs only covers
 * simulator runs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeSignatures, parseTopology } from '@lrd/engine';
import { validateRunDirectory, type NodeEvent } from '@lrd/schema';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_PATH = join(ROOT, 'content/workflow.json');
const RUNS_DIR = join(ROOT, 'content/runs');

function currentSignatures() {
  const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');
  const sha256 = createHash('sha256').update(workflowText, 'utf8').digest('hex');
  const topology = parseTopology(JSON.parse(workflowText));
  return { sha256, signatures: nodeSignatures(topology) };
}

function signatureOf(n: NodeEvent) {
  return { id: n.id, name: n.name, type: n.type, typeVersion: n.typeVersion };
}

function main(): void {
  const { sha256, signatures } = currentSignatures();
  const expected = JSON.stringify(signatures);

  let runIds: string[];
  try {
    runIds = readdirSync(RUNS_DIR).filter((name) => statSync(join(RUNS_DIR, name)).isDirectory());
  } catch {
    console.log('No content/runs/ directory yet -- nothing to drift-check.');
    return;
  }

  if (runIds.length === 0) {
    console.log('content/runs/ is empty -- nothing to drift-check.');
    return;
  }

  let failed = false;

  for (const id of runIds) {
    const dir = join(RUNS_DIR, id);
    const files = readdirSync(dir);
    const runPath = join(dir, 'run.json');
    let run;
    try {
      const raw = JSON.parse(readFileSync(runPath, 'utf8'));
      run = validateRunDirectory({ run: raw, files });
    } catch (err) {
      console.error(`FAIL  ${id}: ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
      continue;
    }

    if (run.workflow.sha256 !== sha256) {
      console.error(
        `DRIFT ${id}: run.workflow.sha256 (${run.workflow.sha256.slice(0, 12)}…) does not match the current ` +
          `content/workflow.json (${sha256.slice(0, 12)}…). Re-run pnpm gen:runs (or re-capture, for a recording).`,
      );
      failed = true;
      continue;
    }

    const actual = JSON.stringify(run.nodes.map(signatureOf));
    if (actual !== expected) {
      console.error(
        `DRIFT ${id}: the run's node list (id/name/type/typeVersion, in order) does not match the current ` +
          `content/workflow.json topology.`,
      );
      failed = true;
      continue;
    }

    console.log(`OK    ${id} (${run.mode}, ${run.nodes.length} nodes)`);
  }

  if (failed) {
    console.error('\nDrift check failed. workflow.json and one or more committed runs disagree.');
    process.exit(1);
  }
  console.log(`\n${runIds.length} run(s) agree with content/workflow.json.`);
}

main();
