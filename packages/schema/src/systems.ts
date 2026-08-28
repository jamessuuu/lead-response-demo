/**
 * The system vocabulary. Every on-page label about what was real, stubbed or
 * simulated is rendered from a run file's `real[]`, `stubbed[]` and
 * `simulated[]` arrays, and those arrays may only contain these ids.
 */
export const SYSTEM_IDS = [
  'n8n',
  'webhook',
  'normalize',
  'wait',
  'branch',
  'gohighlevel',
  'slack',
  'google-sheets',
  'voice-ai',
] as const;

export type SystemId = (typeof SYSTEM_IDS)[number];

export type SystemStatus = 'real' | 'stubbed' | 'simulated';

export interface SystemInfo {
  id: SystemId;
  /** Short display name. */
  name: string;
  /** What this system does in the topology. */
  role: string;
  /** Copy per status, written once here and rendered everywhere. */
  when: Record<SystemStatus, string>;
}

export const SYSTEMS: Record<SystemId, SystemInfo> = {
  n8n: {
    id: 'n8n',
    name: 'n8n',
    role: 'the workflow engine that executes the topology',
    when: {
      real: 'A real n8n instance executed this run; the raw execution export is beside the run file.',
      stubbed: 'n8n was replaced by a stand-in.',
      simulated:
        'n8n did not run. A deterministic engine (packages/engine) walked the same node list, in the same order, with the same templates.',
    },
  },
  webhook: {
    id: 'webhook',
    name: 'Webhook receipt',
    role: 'receives the form or ad-lead POST',
    when: {
      real: 'A real HTTP POST hit a real n8n webhook.',
      stubbed: 'The webhook receipt was a stand-in.',
      simulated: 'The payload was handed to the engine directly; no HTTP request existed.',
    },
  },
  normalize: {
    id: 'normalize',
    name: 'Normalize step',
    role: 'the Code node that turns inconsistent payloads into one lead shape',
    when: {
      real: 'The Code node ran inside n8n.',
      stubbed: 'The normalize step was a stand-in.',
      simulated:
        'The Code node rules were ported line for line into the engine; a test pins them to the workflow file by hash.',
    },
  },
  wait: {
    id: 'wait',
    name: '15-minute wait',
    role: 'holds the execution before the reply check',
    when: {
      real: 'n8n genuinely waited; the raw timestamps show it.',
      stubbed: 'The wait was a stand-in.',
      simulated: 'The engine advanced its clock by the configured 15 minutes; no time passed.',
    },
  },
  branch: {
    id: 'branch',
    name: 'Replied? branch',
    role: 'routes to human takeover or escalation',
    when: {
      real: 'The If node evaluated inside n8n.',
      stubbed: 'The branch was a stand-in.',
      simulated: 'The engine evaluated a mirror of the If condition (pinned to the workflow file by a test).',
    },
  },
  gohighlevel: {
    id: 'gohighlevel',
    name: 'GoHighLevel (LeadConnector API)',
    role: 'contact upsert, SMS, email, reply check',
    when: {
      real: 'Real API calls were made to a real sub-account.',
      stubbed:
        'Every call was answered by a stand-in. No contact was written, no SMS and no email left this machine.',
      simulated: 'Every call was answered by a stand-in inside the engine.',
    },
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    role: 'owner notification and escalation',
    when: {
      real: 'Messages were posted to a real workspace.',
      stubbed: 'chat.postMessage was answered by a stand-in. Nothing was posted anywhere.',
      simulated: 'chat.postMessage was answered by a stand-in inside the engine.',
    },
  },
  'google-sheets': {
    id: 'google-sheets',
    name: 'Google Sheets',
    role: 'the plain-English audit log',
    when: {
      real: 'A row was appended to a real spreadsheet.',
      stubbed: 'The append was answered by a stand-in. No spreadsheet exists.',
      simulated: 'The append was answered by a stand-in inside the engine.',
    },
  },
  'voice-ai': {
    id: 'voice-ai',
    name: 'Voice AI callback',
    role: 'the no-reply escalation call',
    when: {
      real: 'A real Voice AI agent placed a call.',
      stubbed:
        'Never built in n8n by design: the workflow marks a handoff point (a NoOp node) and the agent is configured inside GoHighLevel. No call happened.',
      simulated: 'The handoff NoOp was walked; no call happened.',
    },
  },
};

export function systemName(id: SystemId): string {
  return SYSTEMS[id].name;
}
