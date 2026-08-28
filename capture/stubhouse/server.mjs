// capture/stubhouse/server.mjs
//
// The stubhouse: a plain local HTTP server presenting the response SHAPES of
// GoHighLevel (contacts/upsert, conversations/messages, conversations/search),
// Slack (chat.postMessage) and Google Sheets (values.append), plus a minimal
// Google OAuth2 token-refresh stub so the Google Sheets node's OAuth2
// credential never has to reach a real Google endpoint.
//
// The shapes themselves are NOT reimplemented here — every response body
// comes from `answer()` in @lrd/engine's stubs.ts, the same function the
// simulator calls. Real n8n and the simulator therefore agree by
// construction: one generator, two callers (see capture/README.md).
//
// How real node types get pointed here without editing workflow topology:
// GHL's four HTTP Request nodes carry a literal `url` PARAMETER
// (`https://services.leadconnectorhq.com/...`) inside content/workflow.json.
// A node's `parameters` are not part of its topology signature — drift-check
// (scripts/drift-check.ts) only ever compares {id, name, type, typeVersion}
// — so capture.mjs writes a transformed COPY of workflow.json for n8n import
// with those four `url` values pointed at this server's /ghl/* routes, and
// leaves content/workflow.json itself completely untouched.
//
// The Slack node (n8n-nodes-base.slack) and Google Sheets node
// (n8n-nodes-base.googleSheets) are "app nodes": their vendor base URL is a
// string literal compiled into the installed n8n-nodes-base package, not a
// workflow parameter, so there is nothing in workflow.json to edit for them
// either way. capture/patch-n8n.mjs patches those literals (inside the
// LOCAL, gitignored capture/.n8n-install/ package install only — see that
// script's own header) from the real vendor hosts to this server's
// /slack/* and /sheets/* routes. Topology is untouched either way: the node
// TYPE (n8n-nodes-base.slack / n8n-nodes-base.googleSheets) never changes,
// only where the installed node code happens to send its HTTP request.
//
// Fault switch: POST /_stubhouse/fault?set=slack401 makes every subsequent
// chat.postMessage answer 401 invalid_auth (Spec section 11's recorded
// seam), until /_stubhouse/fault?clear=1 or /_stubhouse/reset.

import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { answer, classifyEndpoint, FAULT_BODIES } from '@lrd/engine';

/** Real vendor origins, keyed by the first path segment stubhouse routes on. */
const REAL_ORIGIN = {
  ghl: 'https://services.leadconnectorhq.com',
  slack: 'https://slack.com',
  sheets: 'https://sheets.googleapis.com',
};

/**
 * A genuinely random Prng (not seeded) satisfying @lrd/engine's Prng
 * interface. Deterministic PRNGs are a simulator concept (Spec: the engine
 * is "deterministic given (payload, faults, seed, timingTable)"); a live
 * HTTP server answering a real process has no seed to be deterministic
 * from, and shouldn't pretend to.
 */
function realPrng() {
  return {
    next: () => Math.random(),
    int: (max) => (max <= 0 ? 0 : randomInt(max)),
    hex: (length) => {
      let s = '';
      while (s.length < length) s += randomBytes(8).toString('hex');
      return s.slice(0, length);
    },
    digits: (length) => {
      let s = '';
      for (let i = 0; i < length; i++) s += String(randomInt(10));
      return s;
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.locationId - fictional GHL location id (matches content/placeholders.json)
 * @param {string} [opts.host] - bind address; defaults to 127.0.0.1 (private capture rig, never public)
 * @param {string[]} [opts.sheetTitles] - sheet tab names the fake spreadsheet answers metadata lookups with
 */
export function createStubhouse({ port, locationId, host = '127.0.0.1', sheetTitles = ['Leads'] }) {
  const state = {
    fault: /** @type {string | null} */ (null),
    knownContacts: new Set(),
    replyDirection: /** @type {'inbound' | 'outbound'} */ ('outbound'),
    locationId,
  };
  const prng = realPrng();
  /**
   * Every call answered, including the exact request body — this is the
   * ground truth capture.mjs reads to compose run.json's `artifacts`
   * (the real SMS/email/Slack text and sheet row n8n actually sent), not
   * a second guess at what n8n "should" have rendered from its templates.
   * @type {Array<{ts: string, method: string, path: string, endpoint: string | null, status: number, fault: string | null, requestBody?: unknown}>}
   */
  const log = [];

  function recordLog(entry) {
    log.push({ ts: new Date().toISOString(), ...entry });
  }

  async function handleAdmin(req, res, url) {
    const segments = url.pathname.split('/').filter(Boolean).slice(1); // drop "_stubhouse"
    const route = segments[0];
    if (route === 'health') {
      return sendJson(res, 200, { ok: true, fault: state.fault, knownContacts: state.knownContacts.size, calls: log.length });
    }
    if (route === 'fault') {
      const set = url.searchParams.get('set');
      const clear = url.searchParams.get('clear');
      if (set) state.fault = set;
      if (clear) state.fault = null;
      return sendJson(res, 200, { fault: state.fault });
    }
    if (route === 'reset') {
      state.knownContacts.clear();
      state.fault = null;
      state.replyDirection = 'outbound';
      log.length = 0;
      return sendJson(res, 200, { reset: true });
    }
    if (route === 'reply-direction') {
      const value = url.searchParams.get('value');
      if (value === 'inbound' || value === 'outbound') state.replyDirection = value;
      return sendJson(res, 200, { replyDirection: state.replyDirection });
    }
    if (route === 'log') {
      return sendJson(res, 200, { calls: log });
    }
    return sendJson(res, 404, { error: `no admin route /_stubhouse/${segments.join('/')}` });
  }

  async function handleOAuthToken(req, res) {
    // Fallback safety net for the Google Sheets OAuth2 credential: if n8n
    // ever decides the pre-seeded token needs a refresh, this answers it
    // rather than reaching a real Google endpoint. See capture/README.md.
    await readBody(req).catch(() => '');
    recordLog({ method: req.method, path: '/oauth/token', endpoint: 'oauth.token', status: 200, fault: null });
    return sendJson(res, 200, { access_token: 'stub-google-access-token', token_type: 'Bearer', expires_in: 3599 });
  }

  /**
   * The Google Sheets node resolves a sheet NAME to its numeric sheetId
   * before it can append (GoogleSheet.js's spreadsheetGetSheet /
   * spreadsheetGetSheets, called via `GET /v4/spreadsheets/{id}
   * ?fields=sheets.properties`) — a real lookup call @lrd/engine's stubs.ts
   * has no shape for, because the simulator never needs it (it renders the
   * append artifact directly). Answered here, not in @lrd/engine, because
   * it exists only to make a REAL n8n Sheets node runnable, not because the
   * simulator and the recording disagree about what Sheets does.
   */
  const SPREADSHEET_META_RE = /^\/v4\/spreadsheets\/[^/]+$/;
  const BATCH_UPDATE_RE = /^\/v4\/spreadsheets\/[^/]+:batchUpdate$/;
  const VALUES_RANGE_RE = /^\/v4\/spreadsheets\/[^/]+\/values\/[^/]+$/; // no :append suffix — plain get/update
  function handleSpreadsheetMeta(req, res, url) {
    const sheets = sheetTitles.map((title, i) => ({
      properties: { sheetId: i, title, index: i, sheetType: 'GRID', gridProperties: { rowCount: 1000, columnCount: 26 } },
    }));
    const body = { sheets };
    recordLog({ method: req.method, path: url.pathname, endpoint: 'sheets.spreadsheets.get', status: 200, fault: null, responseBody: body });
    return sendJson(res, 200, body);
  }

  /**
   * The rest of what a REAL append needs beyond the values.append call
   * @lrd/engine already models (GoogleSheet.js's append.operation.js):
   * read the current values to decide auto-map-vs-defined columns (the
   * fictional Radiant Aesthetics sheet is always answered as genuinely
   * empty — a real fresh demo spreadsheet would be, and n8n's own
   * auto-map fallback for an empty sheet is the accurate behaviour, not a
   * shortcut), reserve a trailing row (:batchUpdate), then write the row
   * with a plain PUT (n8n only uses POST .../values/{range}:append when
   * the node's "Use Append" option is on, which this workflow leaves off —
   * see the sticky note comment in append.operation.js: without it n8n
   * computes the exact target range itself and PUTs).
   */
  async function handleSheetsPlumbing(req, res, url, restPath) {
    if (req.method === 'GET' && SPREADSHEET_META_RE.test(restPath)) {
      handleSpreadsheetMeta(req, res, url);
      return true;
    }
    if (req.method === 'POST' && BATCH_UPDATE_RE.test(restPath)) {
      const raw = await readBody(req);
      let requests = [];
      try {
        requests = JSON.parse(raw || '{}').requests ?? [];
      } catch {
        requests = [];
      }
      const body = { spreadsheetId: url.pathname.split('/')[3] ?? '', replies: requests.map(() => ({})) };
      recordLog({ method: req.method, path: url.pathname, endpoint: 'sheets.spreadsheets.batchUpdate', status: 200, fault: null, requestBody: { requests }, responseBody: body });
      sendJson(res, 200, body);
      return true;
    }
    if (req.method === 'GET' && VALUES_RANGE_RE.test(restPath)) {
      // Always answered as empty: see the doc comment above.
      const body = { range: decodeURIComponent(restPath.split('/values/')[1] ?? ''), majorDimension: 'ROWS' };
      recordLog({ method: req.method, path: url.pathname, endpoint: 'sheets.values.get', status: 200, fault: null, responseBody: body });
      sendJson(res, 200, body);
      return true;
    }
    if (req.method === 'PUT' && VALUES_RANGE_RE.test(restPath)) {
      const raw = await readBody(req);
      let values = [[]];
      try {
        values = JSON.parse(raw || '{}').values ?? [[]];
      } catch {
        values = [[]];
      }
      const range = decodeURIComponent(restPath.split('/values/')[1] ?? '');
      const cols = values[0]?.length ?? 0;
      const body = {
        spreadsheetId: url.pathname.split('/')[3] ?? '',
        updatedRange: range,
        updatedRows: values.length,
        updatedColumns: cols,
        updatedCells: values.length * cols,
      };
      recordLog({ method: req.method, path: url.pathname, endpoint: 'sheets.values.update', status: 200, fault: null, requestBody: { values }, responseBody: body });
      sendJson(res, 200, body);
      return true;
    }
    return false; // not a plumbing route — fall through to the modeled endpoints below
  }

  async function handleVendor(req, res, url, service, restPath) {
    if (service === 'sheets') {
      const handled = await handleSheetsPlumbing(req, res, url, restPath);
      if (handled) return;
    }
    const origin = REAL_ORIGIN[service];
    const fullUrl = `${origin}${restPath}${url.search}`;
    let endpoint;
    try {
      endpoint = classifyEndpoint(req.method, fullUrl);
    } catch {
      recordLog({ method: req.method, path: url.pathname, endpoint: null, status: 404, fault: state.fault });
      return sendJson(res, 404, { error: `stubhouse has no stub for ${req.method} ${fullUrl}` });
    }

    let bodyJson;
    if (req.method === 'GET') {
      bodyJson = { contactId: url.searchParams.get('contactId') ?? '', locationId: url.searchParams.get('locationId') ?? '' };
    } else {
      const raw = await readBody(req);
      try {
        bodyJson = raw ? JSON.parse(raw) : {};
      } catch {
        recordLog({ method: req.method, path: url.pathname, endpoint, status: 400, fault: state.fault });
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
    }

    if (state.fault === 'slack401' && endpoint === 'slack.chat.postMessage') {
      recordLog({ method: req.method, path: url.pathname, endpoint, status: 401, fault: 'slack401', requestBody: bodyJson, responseBody: FAULT_BODIES.slack401 });
      return sendJson(res, 401, FAULT_BODIES.slack401);
    }

    const result = answer({ endpoint, body: bodyJson, completedAtMs: Date.now() }, state, prng);
    recordLog({ method: req.method, path: url.pathname, endpoint, status: result.status, fault: null, requestBody: bodyJson, responseBody: result.body });
    return sendJson(res, result.status, result.body);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const service = segments[0];

    const done = (promise) =>
      promise.catch((err) => {
        recordLog({ method: req.method ?? '', path: url.pathname, endpoint: null, status: 500, fault: state.fault });
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });

    if (service === '_stubhouse') return done(handleAdmin(req, res, url));
    if (service === 'oauth' && segments[1] === 'token') return done(handleOAuthToken(req, res));
    if (service && REAL_ORIGIN[service]) {
      const restPath = `/${segments.slice(1).join('/')}`;
      return done(handleVendor(req, res, url, service, restPath));
    }
    recordLog({ method: req.method ?? '', path: url.pathname, endpoint: null, status: 404, fault: state.fault });
    return sendJson(res, 404, { error: `unknown stubhouse route ${url.pathname}` });
  });

  return {
    server,
    state,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(`http://${host}:${port}`));
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
    setFault(name) {
      state.fault = name;
    },
    getLog() {
      return log.slice();
    },
    reset() {
      state.knownContacts.clear();
      state.fault = null;
      log.length = 0;
    },
  };
}
