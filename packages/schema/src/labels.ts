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
  // Not "because no n8n recording exists yet" -- that claim went false the
  // moment M1 committed rec-medspa-happy/rec-medspa-slack-401 (this exact
  // sentence, sitting on the Simulator tab right next to the Recording tab,
  // was the bug: docs/PROGRESS.md's M1 session note). Stated instead as a
  // fact about this run's own basis, which stays true regardless of how
  // many recordings exist elsewhere -- nothing here can go stale again the
  // way a world-state claim can.
  const timings =
    sim.timingTable.basis === 'recording'
      ? `per-node timings taken from recording ${sim.timingTable.recordingId}`
      : 'per-node timings from a modeled timing table -- assumed, not measured against a real n8n execution';
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

/**
 * The flag that travels with the headline number wherever it appears
 * (dispatcher-added M1 requirement, blocking: firstTouchDispatchMs is
 * 114-115ms *because the integrations are local stubs* -- every surface
 * that renders the number must carry that condition on the same surface,
 * never a bare "0.1 s" beside the 42-hour HBR benchmark). A recording's
 * number is real wall-clock time, but everything downstream of the
 * webhook/normalize/wait/branch nodes that actually happened -- the GHL
 * SMS call itself -- was answered by a local stub with no network in the
 * loop; this states that plainly every time, not just once in a footnote.
 */
export function numberFlag(run: RunFile): string {
  if (run.mode === 'recording') {
    return (
      `measured · recording of n8n ${run.n8n?.version ?? ''} · against local stubs -- ` +
      'a real GoHighLevel round trip would add network time this number does not include'
    ).trim();
  }
  const basis = run.simulator?.timingTable.basis;
  return basis === 'recording'
    ? `simulator · timings from recording ${run.simulator?.timingTable.recordingId ?? ''} · modeled, not a measurement of any real network call`.trim()
    : 'modeled · simulator run · no real network call of any kind happened';
}
