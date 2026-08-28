/**
 * Regenerates content/runs/<id>/run.json from packages/engine. This is the
 * only thing that is allowed to write those files by hand-editing them would
 * defeat the whole point (Spec section 4, decision 1: a run is derived, not
 * authored).
 *
 * `pnpm gen:runs`   writes content/runs/<id>/run.json for every RUN_SPEC.
 * `pnpm check:runs`  (--check) regenerates in memory and diffs against what
 *                     is committed; exits 1 on any drift. This is what CI
 *                     runs -- a run file can only change by someone running
 *                     gen:runs and committing the result, never by hand.
 *
 * Every timestamp, seed and id below is a fixed literal, not `Date.now()` or
 * `Math.random()`: regeneration must be byte-identical or the whole
 * "committed, reviewed like code" model (Spec section 5) breaks.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODELED_TIMING_V1,
  TimingTable,
  execute,
  faultsForScenario,
  parseTopology,
  renderRunFile,
  type ExecuteOptions,
} from '@lrd/engine';
import type { LeadPayload, Scenario } from '@lrd/schema';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_PATH = join(ROOT, 'content/workflow.json');
const PLACEHOLDERS_PATH = join(ROOT, 'content/placeholders.json');
const RUNS_DIR = join(ROOT, 'content/runs');

const CHECK = process.argv.includes('--check');

// Fixed "when this content was produced" stamp. Bump this literal (and
// re-run gen:runs) the day the demo's fictional dates need to move forward;
// it must never be computed at generation time.
const PRODUCED_AT = '2026-08-28T00:00:00.000Z';

const BUSINESS = { name: 'Radiant Aesthetics', fictional: true as const };

// The same fictional lead across every run, matching demo-script.md's own
// walkthrough example ("interested in: lip filler"). 555-01xx is the
// reserved fictional exchange; (512) is Austin, TX -- plausible for a
// business already implied US-market by the AmSpa sourcing in the README.
const PAYLOAD: LeadPayload = {
  name: 'Alex Rivera',
  email: 'alex.rivera@example.com',
  phone: '(512) 555-0134',
  service: 'lip filler',
  source: 'website-form',
};

interface RunSpec {
  id: string;
  scenario: Scenario;
  startedAt: string;
  seed: number;
  priorExecution?: ExecuteOptions['priorExecution'];
}

const RUN_SPECS: readonly RunSpec[] = [
  { id: 'sim-medspa-happy', scenario: 'happy', startedAt: '2026-08-15T21:04:17.000-05:00', seed: 11 },
  { id: 'sim-medspa-slack-revoked', scenario: 'slack-revoked', startedAt: '2026-08-16T09:12:03.000-05:00', seed: 11 },
  { id: 'sim-medspa-ghl-429', scenario: 'ghl-429', startedAt: '2026-08-16T14:41:55.000-05:00', seed: 11 },
  {
    id: 'sim-medspa-duplicate',
    scenario: 'duplicate',
    startedAt: '2026-08-15T21:04:19.100-05:00',
    seed: 11,
    priorExecution: {
      id: 'sim-medspa-happy',
      deliveredAfterMs: 2100,
      cause: 'the visitor tapped submit twice',
    },
  },
  { id: 'sim-medspa-reply-timeout', scenario: 'reply-timeout', startedAt: '2026-08-17T20:03:44.000-05:00', seed: 11 },
];

function loadInputs() {
  const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');
  const workflowJson: unknown = JSON.parse(workflowText);
  const workflowSha256 = createHash('sha256').update(workflowText, 'utf8').digest('hex');
  const topology = parseTopology(workflowJson);
  const placeholders = JSON.parse(readFileSync(PLACEHOLDERS_PATH, 'utf8')) as Record<string, string>;
  const timingTable = TimingTable.parse(MODELED_TIMING_V1);
  return { topology, workflowSha256, placeholders, timingTable };
}

function buildRunText(spec: RunSpec, inputs: ReturnType<typeof loadInputs>): string {
  const opts: ExecuteOptions = {
    id: spec.id,
    scenario: spec.scenario,
    payload: PAYLOAD,
    startedAt: spec.startedAt,
    producedAt: PRODUCED_AT,
    seed: spec.seed,
    faults: faultsForScenario(spec.scenario),
    timingTable: inputs.timingTable,
    topology: inputs.topology,
    workflowSha256: inputs.workflowSha256,
    placeholders: inputs.placeholders,
    business: BUSINESS,
    ...(spec.priorExecution ? { priorExecution: spec.priorExecution } : {}),
  };
  const run = execute(opts);
  return renderRunFile(run);
}

function main(): void {
  const inputs = loadInputs();
  let drift = false;
  let written = 0;

  for (const spec of RUN_SPECS) {
    const text = buildRunText(spec, inputs);
    const dir = join(RUNS_DIR, spec.id);
    const path = join(dir, 'run.json');

    if (CHECK) {
      if (!existsSync(path)) {
        console.error(`MISSING  ${spec.id}: content/runs/${spec.id}/run.json does not exist`);
        drift = true;
        continue;
      }
      const onDisk = readFileSync(path, 'utf8');
      if (onDisk !== text) {
        console.error(`DRIFT    ${spec.id}: committed run.json does not match a fresh regeneration`);
        drift = true;
        continue;
      }
      console.log(`OK       ${spec.id}`);
    } else {
      mkdirSync(dir, { recursive: true });
      const changed = !existsSync(path) || readFileSync(path, 'utf8') !== text;
      writeFileSync(path, text, 'utf8');
      if (changed) written += 1;
      console.log(`${changed ? 'WROTE   ' : 'unchanged'} ${spec.id}`);
    }
  }

  if (CHECK) {
    if (drift) {
      console.error('\ncontent/runs/ has drifted from packages/engine. Run `pnpm gen:runs` and commit the result.');
      process.exit(1);
    }
    console.log(`\n${RUN_SPECS.length} run(s) match a fresh regeneration byte-for-byte.`);
  } else {
    console.log(`\n${written} of ${RUN_SPECS.length} run(s) changed.`);
  }
}

main();
