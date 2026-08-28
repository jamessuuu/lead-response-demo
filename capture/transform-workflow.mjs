// capture/transform-workflow.mjs
//
// Produces the workflow JSON capture.mjs hands to `n8n import:workflow` —
// content/workflow.json with every REPLACE_* placeholder filled in (from
// content/placeholders.json, same values the simulator uses), the four GHL
// HTTP Request nodes' `url` parameter repointed at stubhouse, each node's
// credential id assigned to the credential capture.mjs imports for it, and
// `active: true` so `--activeState=fromJson` arms the production webhook.
//
// NOT a topology edit: id/name/type/typeVersion/connections are byte-
// identical to content/workflow.json — verifyTopologyUnchanged() (called by
// capture.mjs before anything is imported) proves this with the same
// nodeSignatures()/parseTopology() the real drift-check uses, not a
// separate hand-rolled comparison that could quietly diverge from it.

import { parseTopology, nodeSignatures } from '@lrd/engine';

const REPLACE_RE = /REPLACE_[A-Z0-9_]+/g;
const GHL_NODE_IDS = new Set(['node-ghl-upsert', 'node-ghl-sms', 'node-ghl-email', 'node-ghl-checkreply']);
const GHL_REAL_ORIGIN = 'https://services.leadconnectorhq.com';

/** Credential type (as it appears in a node's `credentials` block) -> the id capture.mjs imports it under. */
export const CREDENTIAL_ID_BY_TYPE = {
  httpHeaderAuth: 'cred_ghl_header_capture',
  slackApi: 'cred_slack_capture',
  googleSheetsOAuth2Api: 'cred_sheets_capture',
};

function substitutePlaceholders(value, placeholders) {
  if (typeof value === 'string') {
    return value.replace(REPLACE_RE, (token) => {
      if (!(token in placeholders)) throw new Error(`transform-workflow: no placeholder value for ${token}`);
      return placeholders[token];
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitutePlaceholders(v, placeholders));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitutePlaceholders(v, placeholders);
    return out;
  }
  return value;
}

function rewriteCredentials(node) {
  if (!node.credentials) return undefined;
  const credentials = {};
  for (const [type, ref] of Object.entries(node.credentials)) {
    const id = CREDENTIAL_ID_BY_TYPE[type];
    credentials[type] = id ? { id, name: ref.name } : ref;
  }
  return credentials;
}

/**
 * @param {object} opts
 * @param {unknown} opts.workflow - parsed content/workflow.json
 * @param {Record<string,string>} opts.placeholders - parsed content/placeholders.json (minus the $comment key)
 * @param {number} opts.stubhousePort
 * @param {string} [opts.workflowId] - id to import under; defaults to the source file's own id
 */
export function buildCaptureWorkflow({ workflow, placeholders, stubhousePort, workflowId }) {
  const ghlBase = `http://127.0.0.1:${stubhousePort}/ghl`;
  const wf = JSON.parse(JSON.stringify(workflow));

  wf.nodes = wf.nodes.map((node) => {
    // A disabled node's parameters are never evaluated by n8n (it passes
    // data through untouched) — mirrors packages/engine/src/execute.ts's
    // own disabled-node handling. Its placeholder-looking text (the
    // enrichment stub's REPLACE_ME_ URL) is display-only and left alone.
    const parameters = node.disabled ? (node.parameters ?? {}) : substitutePlaceholders(node.parameters ?? {}, placeholders);
    if (GHL_NODE_IDS.has(node.id) && typeof parameters.url === 'string') {
      parameters.url = parameters.url.split(GHL_REAL_ORIGIN).join(ghlBase);
    }
    const next = { ...node, parameters };
    const credentials = rewriteCredentials(node);
    if (credentials) next.credentials = credentials;
    return next;
  });

  if (workflowId) wf.id = workflowId;
  wf.active = true;
  return wf;
}

/**
 * Proves the transform above touched only `parameters`/`credentials`/`id`/
 * `active` — every node's {id, name, type, typeVersion} and every
 * connection are unchanged from the source workflow. Throws (capture.mjs
 * treats this as fatal — never import a workflow this check hasn't passed)
 * rather than returning a boolean, so a caller can't accidentally ignore it.
 */
export function verifyTopologyUnchanged(sourceWorkflow, transformedWorkflow) {
  const sourceSig = JSON.stringify(nodeSignatures(parseTopology(sourceWorkflow)));
  const transformedSig = JSON.stringify(nodeSignatures(parseTopology(transformedWorkflow)));
  if (sourceSig !== transformedSig) {
    throw new Error(
      'transform-workflow: the capture-import copy has a different node topology than content/workflow.json. ' +
        'This must never happen — refusing to import a workflow that would fail the drift check.',
    );
  }
}
