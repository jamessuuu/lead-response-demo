// capture/lib/n8n-rest.mjs
//
// Minimal client for n8n's internal /rest/* API (the same API the Editor UI
// itself calls), used only for: completing the one-time owner setup on a
// fresh instance, logging in, and reading back a finished execution's raw
// data. Workflow/credential *creation* goes through `n8n import:workflow` /
// `n8n import:credentials` (capture/capture.mjs) instead — CLI import writes
// straight to the DB and needs no session, which is simpler and is also how
// the base sample's own README already verified this repo's workflow.json
// imports cleanly (service-samples/automations/speed-to-lead/README.md).
//
// Session auth: n8n sets an httpOnly cookie (name has varied by version —
// this client doesn't hardcode it, it just replays whatever Set-Cookie it
// receives) on a successful /rest/login or /rest/owner/setup call.

function firstCookiePair(setCookieHeader) {
  // Node's fetch exposes multiple Set-Cookie values joined; take each
  // "name=value" before its first ";" and rejoin with "; " for the Cookie header.
  return setCookieHeader
    .split(/,(?=[^;]+?=)/) // split on commas that start a new cookie, not inside a date
    .map((c) => c.trim().split(';')[0])
    .join('; ');
}

export function createN8nRestClient(baseUrl) {
  let cookie = '';

  async function call(path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = firstCookiePair(setCookie);
    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return { ok: res.ok, status: res.status, json };
  }

  return {
    call,

    /** GET /rest/settings — tells us whether owner setup is still pending. */
    async settings() {
      return call('/rest/settings');
    },

    /** POST /rest/owner/setup — one-time; fails once an owner already exists. */
    async ownerSetup({ email, firstName, lastName, password }) {
      return call('/rest/owner/setup', { method: 'POST', body: { email, firstName, lastName, password } });
    },

    /** POST /rest/login */
    async login({ email, password }) {
      return call('/rest/login', { method: 'POST', body: { emailOrLdapLoginId: email, password } });
    },

    /** GET /rest/login — "who am I", also a good session-alive probe. */
    async me() {
      return call('/rest/login');
    },

    /** GET /rest/executions?filter={"workflowId":"..."} */
    async listExecutions({ workflowId, limit = 5 } = {}) {
      const filter = encodeURIComponent(JSON.stringify(workflowId ? { workflowId } : {}));
      return call(`/rest/executions?filter=${filter}&limit=${limit}`);
    },

    /** GET /rest/executions/:id */
    async getExecution(id) {
      return call(`/rest/executions/${id}`);
    },

    /** PATCH /rest/workflows/:id */
    async patchWorkflow(id, patch) {
      return call(`/rest/workflows/${id}`, { method: 'PATCH', body: patch });
    },

    async getWorkflow(id) {
      return call(`/rest/workflows/${id}`);
    },
  };
}

/** Poll listExecutions/getExecution until the newest execution for workflowId is finished. */
export async function waitForExecution(client, { workflowId, sinceMs, timeoutMs = 60_000, pollMs = 500 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await client.listExecutions({ workflowId, limit: 5 });
    const rows = list.json?.data?.results ?? list.json?.data ?? [];
    const candidate = Array.isArray(rows)
      ? rows.find((r) => new Date(r.startedAt ?? r.createdAt).getTime() >= sinceMs - 2000)
      : undefined;
    if (candidate) {
      const full = await client.getExecution(candidate.id);
      const status = full.json?.data?.status ?? full.json?.status;
      const finished = full.json?.data?.finished ?? full.json?.finished;
      if (finished || status === 'success' || status === 'error' || status === 'crashed') {
        return full.json?.data ?? full.json;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForExecution: timed out after ${timeoutMs}ms waiting for a finished execution of workflow ${workflowId}`);
}
