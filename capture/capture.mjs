#!/usr/bin/env node
// capture/capture.mjs — the M1 capture rig entry point.
//
//   pnpm --filter @lrd/capture capture:happy
//   pnpm --filter @lrd/capture capture:slack-401
//   node capture/capture.mjs --scenario=happy --run-id=rec-medspa-happy
//
// What this does, in order (see capture/README.md for the full "exactly
// how" writeup Spec section 5/18 asks for):
//  1. Starts stubhouse in-process (capture/stubhouse/server.mjs).
//  2. Patches the local n8n install's Slack/Sheets node code to call
//     stubhouse instead of the real vendors (capture/patch-n8n.mjs) —
//     idempotent, never touches content/workflow.json.
//  3. Builds a transformed import copy of content/workflow.json (GHL nodes'
//     url parameter repointed, placeholders filled, credential ids wired)
//     and proves its topology is byte-identical to the source
//     (transform-workflow.mjs's verifyTopologyUnchanged — the same
//     nodeSignatures()/parseTopology() drift-check.ts itself uses).
//  4. Spawns `npx n8n@latest start` bound to 127.0.0.1, in a fresh
//     gitignored capture/.n8n/<runId>/ user folder.
//  5. Completes the one-time owner setup (a throwaway local account/
//     password, this capture rig only) and imports the workflow +
//     credentials via `n8n import:*`, then activates the workflow via
//     REST so the PRODUCTION webhook responds.
//  6. Applies the scenario's fault (stubhouse.setFault) before firing.
//  7. POSTs the fictional Radiant Aesthetics lead to the real webhook URL
//     and polls n8n's REST API until the execution finishes — for the
//     happy path this means genuinely waiting out the real 15-minute Wait
//     node; nothing here shortens or fast-forwards it (Spec section 4,
//     decision 2).
//  8. Reads back the raw execution (n8n-core's own `flatted` serialization
//     — see capture/lib/build-run-file.mjs), redacts it, and writes the
//     three files into content/runs/<run-id>/: execution.json (untouched
//     raw export), run.json (schema v1, mapped by build-run-file.mjs),
//     attest.json.
//  9. Deactivates the workflow and stops n8n + stubhouse.
//
// Never touches content/workflow.json. Never writes outside this repo
// except capture/.n8n/<runId>/ (gitignored).

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse as flattedParse } from 'flatted';
import { parseTopology } from '@lrd/engine';
import { validateRunDirectory } from '@lrd/schema';
import { createStubhouse } from './stubhouse/server.mjs';
import { patchN8n } from './patch-n8n.mjs';
import { buildCaptureWorkflow, verifyTopologyUnchanged, CREDENTIAL_ID_BY_TYPE } from './transform-workflow.mjs';
import { createN8nRestClient } from './lib/n8n-rest.mjs';
import { buildRunFile } from './lib/build-run-file.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CAPTURE_DIR = join(ROOT, 'capture');
const STUBHOUSE_PORT = 8788;

const LEAD_PAYLOAD = {
  name: 'Alex Rivera',
  email: 'alex.rivera@example.com',
  phone: '(512) 555-0134',
  service: 'lip filler',
  source: 'website-form',
};

const SCENARIOS = {
  happy: { fault: null, schemaScenario: 'happy' },
  'slack-401': { fault: 'slack401', schemaScenario: 'slack-revoked' },
};

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function log(msg) {
  console.log(`[capture] ${msg}`);
}

function randomPassword() {
  return `Cap-${createHash('sha256').update(String(Math.random()) + Date.now()).digest('hex').slice(0, 24)}-1!`;
}

async function waitFor(predicate, { timeoutMs, intervalMs, label }) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}${lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : lastErr})` : ''}`);
}

/** Best-effort: kill whatever is bound to a TCP port right now (Windows-reliable port-owner kill, matching scripts/e2e.mjs's own documented approach). */
async function killPortOwner(port) {
  const out = execSync(
    `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
    { encoding: 'utf8' },
  ).trim();
  const pids = [...new Set(out.split(/\s+/).filter((s) => /^\d+$/.test(s)))];
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}

async function main() {
  const scenarioName = arg('scenario', 'happy');
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`Unknown --scenario=${scenarioName}. Expected one of: ${Object.keys(SCENARIOS).join(', ')}`);

  const runId = arg('run-id', `rec-medspa-${scenarioName}`);
  const outDir = arg('out', join(ROOT, 'content', 'runs', runId));
  const n8nPort = Number(arg('n8n-port', '5680'));
  const n8nBase = `http://127.0.0.1:${n8nPort}`;
  const userFolder = join(CAPTURE_DIR, '.n8n', runId);
  const logPath = join(CAPTURE_DIR, `n8n-${runId}.log`);

  log(`scenario=${scenarioName} runId=${runId} out=${outDir}`);

  // --- 0. Clean slate for this run id.
  if (existsSync(userFolder)) rmSync(userFolder, { recursive: true, force: true });
  mkdirSync(userFolder, { recursive: true });
  await killPortOwner(n8nPort).catch(() => {});

  // --- 1. Stubhouse, in-process.
  const stubhouse = createStubhouse({ port: STUBHOUSE_PORT, locationId: 'loc_demo_radiant' });
  await stubhouse.start();
  log(`stubhouse listening on http://127.0.0.1:${STUBHOUSE_PORT}`);

  // --- 2. Patch the local n8n install (idempotent).
  const patchResult = patchN8n({ stubhousePort: STUBHOUSE_PORT });
  log(`n8n patched: ${patchResult.report.map((r) => r.status).join(', ')} (${patchResult.nodesBaseDir})`);
  if (patchResult.report.some((r) => r.status === 'missing' || r.status === 'not-found')) {
    throw new Error('capture: patch-n8n could not confirm the Slack/Sheets redirect — refusing to capture against an unpatched install. See the patch report above.');
  }

  // --- 3. Build + verify the capture-import workflow.
  const workflowPath = join(ROOT, 'content', 'workflow.json');
  const workflowText = readFileSync(workflowPath, 'utf8');
  const workflowSha256 = createHash('sha256').update(workflowText, 'utf8').digest('hex');
  const sourceWorkflow = JSON.parse(workflowText);
  const topology = parseTopology(sourceWorkflow);
  const placeholdersRaw = JSON.parse(readFileSync(join(ROOT, 'content', 'placeholders.json'), 'utf8'));
  const { $comment, ...placeholders } = placeholdersRaw;
  const importWorkflowId = `capture-${runId}`;
  const transformed = buildCaptureWorkflow({ workflow: sourceWorkflow, placeholders, stubhousePort: STUBHOUSE_PORT, workflowId: importWorkflowId });
  verifyTopologyUnchanged(sourceWorkflow, transformed);
  const importWorkflowPath = join(userFolder, 'import-workflow.json');
  writeFileSync(importWorkflowPath, JSON.stringify(transformed, null, 2));

  const webhookNode = sourceWorkflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  const webhookPath = webhookNode.parameters.path;

  const notARealToken = ['local', 'capture', 'rig', 'placeholder', 'value'].join('.');
  const credentials = [
    { id: CREDENTIAL_ID_BY_TYPE.httpHeaderAuth, name: 'GHL Private Integration (Header Auth)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${notARealToken}` } },
    { id: CREDENTIAL_ID_BY_TYPE.slackApi, name: 'Slack account', type: 'slackApi', data: { accessToken: notARealToken } },
    {
      id: CREDENTIAL_ID_BY_TYPE.googleSheetsOAuth2Api,
      name: 'Google Sheets account',
      type: 'googleSheetsOAuth2Api',
      data: {
        clientId: 'demo-client-id.apps.googleusercontent.com',
        clientSecret: notARealToken,
        accessTokenUrl: `http://127.0.0.1:${STUBHOUSE_PORT}/oauth/token`,
        authUrl: `http://127.0.0.1:${STUBHOUSE_PORT}/oauth/authorize`,
        oauthTokenData: {
          access_token: 'stub-google-access-token',
          token_type: 'Bearer',
          expires_in: 3599,
          refresh_token: notARealToken,
          scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
        },
      },
    },
  ];
  const importCredentialsPath = join(userFolder, 'import-credentials.json');
  writeFileSync(importCredentialsPath, JSON.stringify(credentials, null, 2));

  // --- 4. Spawn n8n.
  const env = {
    ...process.env,
    N8N_USER_FOLDER: userFolder,
    N8N_HOST: '127.0.0.1',
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_PORT: String(n8nPort),
    N8N_PROTOCOL: 'http',
    N8N_EDITOR_BASE_URL: `${n8nBase}/`,
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_ONBOARDING_FLOW_DISABLED: 'true',
    N8N_HIRING_BANNER_ENABLED: 'false',
    N8N_PUBLIC_API_DISABLED: 'true',
    EXECUTIONS_MODE: 'regular',
    N8N_LOG_LEVEL: 'info',
    DB_TYPE: 'sqlite',
  };
  writeFileSync(logPath, ''); // truncate/create
  const n8nProc = spawn('npx', ['--yes', 'n8n@latest', 'start'], {
    cwd: CAPTURE_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const appendLog = (chunk) => {
    try {
      writeFileSync(logPath, chunk, { flag: 'a' });
    } catch {
      /* best-effort */
    }
  };
  n8nProc.stdout.on('data', appendLog);
  n8nProc.stderr.on('data', appendLog);

  let n8nVersion = '';
  try {
    // --- 5. Wait for readiness, then owner setup + import + activate + fire + wait + fetch.
    await waitFor(
      async () => {
        const res = await fetch(`${n8nBase}/rest/settings`).catch(() => null);
        return res && res.ok ? true : false;
      },
      { timeoutMs: 120_000, intervalMs: 1000, label: `n8n REST API up at ${n8nBase}` },
    );
    log('n8n REST API is up.');

    const client = createN8nRestClient(n8nBase);
    const settings = await client.settings();
    const email = 'dispatcher@lead-response-demo.local';
    const password = randomPassword();
    let userId;
    if (settings.json?.data?.showSetupOnFirstLoad !== false) {
      const setup = await client.ownerSetup({ email, firstName: 'Dispatcher', lastName: 'Agent', password });
      if (!setup.ok) throw new Error(`owner setup failed: ${JSON.stringify(setup.json)}`);
      userId = setup.json.data.id;
    } else {
      const loginRes = await client.login({ email, password });
      if (!loginRes.ok) throw new Error('owner already set up under a different password than this fresh run generated — this should not happen with a clean user folder.');
      userId = loginRes.json.data.id;
    }
    log(`owner ready: userId=${userId}`);

    // --- CLI imports (direct DB writes, no session needed).
    const runN8nCli = (args) =>
      new Promise((resolve, reject) => {
        const p = spawn('npx', ['--yes', 'n8n@latest', ...args], { cwd: CAPTURE_DIR, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.stderr.on('data', (d) => (out += d.toString()));
        p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`n8n ${args.join(' ')} exited ${code}:\n${out}`))));
        p.on('error', reject);
      });

    await runN8nCli(['import:credentials', `--input=${importCredentialsPath}`, `--userId=${userId}`]);
    log('credentials imported.');
    await runN8nCli(['import:workflow', `--input=${importWorkflowPath}`, `--userId=${userId}`]);
    log('workflow imported (inactive).');

    const wf = await client.getWorkflow(importWorkflowId);
    if (!wf.ok) throw new Error(`could not read back imported workflow: ${JSON.stringify(wf.json)}`);
    n8nVersion = await getN8nVersion();
    const activate = await client.call(`/rest/workflows/${importWorkflowId}/activate`, { method: 'POST', body: { versionId: wf.json.data.versionId } });
    if (!activate.ok || activate.json?.data?.active !== true) throw new Error(`could not activate workflow: ${JSON.stringify(activate.json)}`);
    log('workflow active.');

    // --- 6. Fault, if this scenario needs one.
    if (scenario.fault) {
      stubhouse.setFault(scenario.fault);
      log(`stubhouse fault armed: ${scenario.fault}`);
    }

    // --- 7. Fire the real webhook.
    const firedAt = Date.now();
    const fireRes = await fetch(`${n8nBase}/webhook/${webhookPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LEAD_PAYLOAD),
    });
    if (!fireRes.ok) throw new Error(`webhook POST failed: ${fireRes.status} ${await fireRes.text()}`);
    log(`webhook fired (${fireRes.status}); waiting for the execution to finish (this genuinely waits out the real Wait node on the happy path) ...`);

    const execRow = await waitFor(
      async () => {
        const list = await client.listExecutions({ workflowId: importWorkflowId, limit: 5 });
        const rows = list.json?.data?.results ?? [];
        return rows.find((r) => new Date(r.startedAt).getTime() >= firedAt - 2000);
      },
      { timeoutMs: 20_000, intervalMs: 1000, label: 'execution to appear in the executions list' },
    );
    const finished = await waitFor(
      async () => {
        const res = await client.getExecution(execRow.id);
        const status = res.json?.data?.status ?? res.json?.status;
        if (status === 'waiting' || status === 'running' || status === 'new') return false;
        return res.json?.data ?? res.json;
      },
      { timeoutMs: 25 * 60_000, intervalMs: 8000, label: `execution ${execRow.id} to leave waiting/running` },
    );
    log(`execution ${execRow.id} finished: status=${finished.status}`);

    // --- 8. Map + write.
    const executionData = flattedParse(finished.data);
    const stubhouseLog = stubhouse.getLog();
    const producedAt = new Date().toISOString();
    const runFile = buildRunFile({
      topology,
      executionData,
      stubhouseLog,
      runId,
      scenario: scenario.schemaScenario,
      workflowSha256,
      producedAt,
      n8nInfo: { version: n8nVersion, executionId: String(execRow.id), mode: 'webhook' },
    });

    const commitSha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    const attest = {
      schema: 1,
      runId,
      capturedAt: producedAt,
      n8n: { version: n8nVersion, executionId: String(execRow.id), mode: 'webhook' },
      os: `${process.platform} ${process.version}`,
      captureCommand: `node capture/capture.mjs --scenario=${scenarioName} --run-id=${runId}`,
      stubhouseCommit: commitSha,
      stubbed: runFile.stubbed,
      operator: 'dispatcher-agent',
      redaction: { authHeadersStripped: true, phoneMasked: true },
    };

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'run.json'), `${JSON.stringify(runFile, null, 2)}\n`);
    writeFileSync(join(outDir, 'execution.json'), `${JSON.stringify(executionData, null, 2)}\n`);
    writeFileSync(join(outDir, 'attest.json'), `${JSON.stringify(attest, null, 2)}\n`);
    log(`wrote ${outDir}`);

    // Validate immediately — never leave a written recording unvalidated.
    validateRunDirectory({ run: JSON.parse(readFileSync(join(outDir, 'run.json'), 'utf8')), files: ['run.json', 'execution.json', 'attest.json'] });
    log('run.json validated against the schema.');

    await client.patchWorkflow(importWorkflowId, { active: false }).catch(() => {});
  } finally {
    log('shutting down n8n + stubhouse...');
    n8nProc.kill();
    await killPortOwner(n8nPort).catch(() => {});
    await stubhouse.stop();
  }
}

async function getN8nVersion() {
  // The n8n CLI itself doesn't print its version without a subcommand in a
  // clean way we want to depend on here; read it from the same local npx
  // install patch-n8n.mjs already resolved (package.json is ground truth).
  const cacheDir = execSync('npm config get cache', { encoding: 'utf8' }).trim();
  const npxDir = join(cacheDir, '_npx');
  let best = null;
  for (const hash of readdirSync(npxDir)) {
    const pkgPath = join(npxDir, hash, 'node_modules', 'n8n', 'package.json');
    if (!existsSync(pkgPath)) continue;
    const mtime = statSync(join(npxDir, hash)).mtimeMs;
    if (!best || mtime > best.mtime) best = { mtime, pkgPath };
  }
  if (!best) return 'unknown';
  return JSON.parse(readFileSync(best.pkgPath, 'utf8')).version;
}

main().catch((err) => {
  console.error('[capture] FAILED:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
