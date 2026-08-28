import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LeadPayload, Scenario } from '@lrd/schema';
import { MODELED_TIMING_V1, TimingTable, faultsForScenario, parseTopology, type ExecuteOptions } from '../src/index.ts';

const root = new URL('../../../', import.meta.url);

export function readRootFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');
}

export const workflowText = readRootFile('content/workflow.json');
export const workflowJson: unknown = JSON.parse(workflowText);
export const workflowSha256 = createHash('sha256').update(workflowText, 'utf8').digest('hex');
export const topology = parseTopology(workflowJson);
export const placeholders = JSON.parse(readRootFile('content/placeholders.json')) as Record<string, string>;
export const timingTable = TimingTable.parse(MODELED_TIMING_V1);

/** A fictional lead; 555-01xx is the reserved fictional number range. */
export const leadPayload: LeadPayload = {
  name: 'Test Lead',
  email: 'Test.Lead@example.com',
  phone: '(512) 555-0199',
  service: 'botox',
  source: 'fixture',
};

export const business = { name: 'Radiant Aesthetics', fictional: true as const };

export function baseOptions(scenario: Scenario, overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  const opts: ExecuteOptions = {
    id: `fixture-${scenario}`,
    scenario,
    payload: leadPayload,
    startedAt: '2026-08-28T21:04:17.000-05:00',
    producedAt: '2026-08-28T12:00:00.000Z',
    seed: 7,
    faults: faultsForScenario(scenario),
    timingTable,
    topology,
    workflowSha256,
    placeholders,
    business,
    ...overrides,
  };
  if (scenario === 'duplicate' && !opts.priorExecution) {
    opts.priorExecution = { id: 'fixture-happy', deliveredAfterMs: 1400, cause: 'form double-submit' };
    opts.startedAt = '2026-08-28T21:04:18.400-05:00';
  }
  return opts;
}
