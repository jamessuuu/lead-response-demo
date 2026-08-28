import type { RunFile } from './run.ts';
import { SYSTEMS, type SystemId, type SystemStatus } from './systems.ts';

/**
 * Every mode label on screen is composed here, from run-file fields, and
 * rendered verbatim. No template types these sentences.
 */

export interface ModeChip {
  kind: RunFile['mode'];
  title: 'Simulator' | 'Recording';
  text: string;
}

function names(ids: readonly SystemId[]): string {
  return ids.map((id) => SYSTEMS[id].name).join(', ');
}

export function modeChip(run: RunFile): ModeChip {
  if (run.mode === 'recording') {
    const n8n = run.n8n;
    if (!n8n) throw new Error('recording without n8n block');
    const date = run.producedAt.slice(0, 10);
    const real = run.real.filter((id) => id !== 'n8n');
    return {
      kind: 'recording',
      title: 'Recording',
      text:
        `Recording — real n8n ${n8n.version} execution #${n8n.executionId}, captured ${date}. ` +
        `Real: ${names(real)}. Stubbed: ${names(run.stubbed)}. Nothing was sent to anyone.`,
    };
  }
  const sim = run.simulator;
  if (!sim) throw new Error('simulator run without simulator block');
  const timings =
    sim.timingTable.basis === 'recording'
      ? `per-node timings taken from recording ${sim.timingTable.recordingId}`
      : 'per-node timings from a modeled timing table, because no n8n recording exists yet';
  return {
    kind: 'simulator',
    title: 'Simulator',
    text:
      `Simulator — this is not n8n. The same topology (${run.nodes.length} nodes from workflow.json) ` +
      `runs in a deterministic engine, with ${timings}. Nothing is sent; no CRM is written.`,
  };
}

export function modeLabel(run: RunFile): string {
  return modeChip(run).text;
}

export interface SystemLine {
  id: SystemId;
  name: string;
  role: string;
  status: SystemStatus;
  text: string;
}

function lines(run: RunFile, status: SystemStatus): SystemLine[] {
  const ids = status === 'real' ? run.real : status === 'stubbed' ? run.stubbed : run.simulated;
  return ids.map((id) => ({
    id,
    name: SYSTEMS[id].name,
    role: SYSTEMS[id].role,
    status,
    text: SYSTEMS[id].when[status],
  }));
}

/** The what-this-is-not panel: simulated first, then stubbed. */
export function whatThisIsNot(run: RunFile): SystemLine[] {
  return [...lines(run, 'simulated'), ...lines(run, 'stubbed')];
}

export function whatWasReal(run: RunFile): SystemLine[] {
  return lines(run, 'real');
}

/**
 * The sentence /limits must carry (Spec section 16, criterion 2). It is only
 * true when GoHighLevel, the one channel the workflow sends through, was not
 * real; the function returns null otherwise so the page cannot claim it.
 */
export function neverSentStatement(run: RunFile): string | null {
  if (run.real.includes('gohighlevel')) return null;
  return (
    'No SMS or email was ever sent. GoHighLevel is the only channel this workflow sends through, ' +
    `and in this run it was ${run.stubbed.includes('gohighlevel') ? 'stubbed' : 'simulated'}: ` +
    'the messages were composed, and then went nowhere.'
  );
}

/** The flag that travels with the headline number wherever it appears. */
export function numberFlag(run: RunFile): string {
  if (run.mode === 'recording') return `measured · recording of n8n ${run.n8n?.version ?? ''}`.trim();
  const basis = run.simulator?.timingTable.basis;
  return basis === 'recording'
    ? `simulator · timings from recording ${run.simulator?.timingTable.recordingId ?? ''}`.trim()
    : 'modeled · simulator run · no recording yet';
}
