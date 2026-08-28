// capture/patch-n8n.mjs
//
// Redirects n8n's Slack and Google Sheets APP NODES to stubhouse.
//
// GHL's four nodes are plain n8n-nodes-base.httpRequest nodes with a
// literal `url` PARAMETER inside workflow.json — capture/transform-workflow.mjs
// rewrites that parameter value in a transient import copy. Not a topology
// change (drift-check only ever compares {id, name, type, typeVersion} —
// scripts/drift-check.ts, packages/engine/src/workflow.ts nodeSignatures())
// and content/workflow.json itself is never touched.
//
// Slack (n8n-nodes-base.slack) and Google Sheets (n8n-nodes-base.googleSheets)
// are different: they are "app nodes" whose vendor base URL is a JS string
// literal compiled into the installed n8n-nodes-base package, not a workflow
// parameter — there is nothing in workflow.json to point anywhere for them.
// This script finds those literals in the LOCAL npx install (never anything
// under content/ or a system location) and rewrites them to stubhouse's own
// routes. The node TYPE never changes, so this is not a topology edit either
// — it changes where the already-selected node's compiled code happens to
// send its HTTP request, the same way an /etc/hosts entry would, but scoped
// to a handful of known string literals instead of DNS.
//
// The Google Sheets OAuth2 credential's token endpoint does NOT need a
// patch here: `accessTokenUrl` is a plain (if UI-hidden) credential DATA
// field (see n8n-nodes-base's OAuth2Api.credentials.js) that capture.mjs
// sets directly on the imported credential — see capture/README.md.
//
// Idempotent: re-running after an already-patched install is a no-op (the
// search strings won't be found a second time) and is reported as such,
// never double-patched or corrupted.

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Find every local npx install candidate for "n8n" (there can be more than one, from different npx runs/versions). */
function findNpxN8nCandidates() {
  let cacheDir;
  try {
    cacheDir = execSync('npm config get cache', { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`patch-n8n: could not read npm cache dir (\`npm config get cache\`): ${err instanceof Error ? err.message : String(err)}`);
  }
  const npxDir = join(cacheDir, '_npx');
  let hashDirs;
  try {
    hashDirs = readdirSync(npxDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const candidates = [];
  for (const hash of hashDirs) {
    const n8nPkgPath = join(npxDir, hash, 'node_modules', 'n8n', 'package.json');
    const nbDir = join(npxDir, hash, 'node_modules', 'n8n-nodes-base');
    try {
      const pkg = JSON.parse(readFileSync(n8nPkgPath, 'utf8'));
      const nbPkg = JSON.parse(readFileSync(join(nbDir, 'package.json'), 'utf8'));
      candidates.push({
        hash,
        dir: join(npxDir, hash),
        n8nVersion: pkg.version,
        nodesBaseDir: nbDir,
        nodesBaseVersion: nbPkg.version,
        mtimeMs: statSync(join(npxDir, hash)).mtimeMs,
      });
    } catch {
      // not an n8n install, skip
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

/**
 * @param {object} opts
 * @param {string} [opts.n8nVersion] - if given, only consider an install whose n8n package.json matches exactly
 * @param {string} [opts.nodesBaseDir] - explicit override; skips discovery entirely
 * @param {number} opts.stubhousePort
 */
export function resolveN8nNodesBaseDir({ n8nVersion, nodesBaseDir } = {}) {
  if (nodesBaseDir) return nodesBaseDir;
  const candidates = findNpxN8nCandidates();
  if (candidates.length === 0) {
    throw new Error(
      'patch-n8n: no local npx install of n8n found under `npm config get cache`/_npx. Run `npx --yes n8n@latest --version` once first.',
    );
  }
  const matching = n8nVersion ? candidates.filter((c) => c.n8nVersion === n8nVersion) : candidates;
  const chosen = (matching.length > 0 ? matching : candidates)[0];
  return chosen.nodesBaseDir;
}

/** One patch target: a file, the exact substring to find, and its replacement. */
function buildTargets(nodesBaseDir, stubhousePort) {
  const base = `http://127.0.0.1:${stubhousePort}`;
  return [
    {
      file: join(nodesBaseDir, 'dist/nodes/Slack/V2/GenericFunctions.js'),
      replacements: [['https://slack.com/api', `${base}/slack/api`]],
    },
    {
      file: join(nodesBaseDir, 'dist/nodes/Slack/V1/GenericFunctions.js'),
      replacements: [['https://slack.com/api', `${base}/slack/api`]],
    },
    {
      file: join(nodesBaseDir, 'dist/nodes/Google/Sheet/v2/transport/index.js'),
      replacements: [['https://sheets.googleapis.com', `${base}/sheets`]],
    },
    {
      file: join(nodesBaseDir, 'dist/nodes/Google/Sheet/v1/GenericFunctions.js'),
      replacements: [['https://sheets.googleapis.com', `${base}/sheets`]],
    },
  ];
}

/**
 * Apply the patch. Returns a report array: one entry per target file with
 * how many occurrences were changed (0 means either already patched, or the
 * n8n release changed its source — either way, surfaced, never silent).
 */
export function patchN8n({ stubhousePort, n8nVersion, nodesBaseDir: dirOverride }) {
  const nodesBaseDir = resolveN8nNodesBaseDir({ n8nVersion, nodesBaseDir: dirOverride });
  const targets = buildTargets(nodesBaseDir, stubhousePort);
  const report = [];
  for (const target of targets) {
    let text;
    try {
      text = readFileSync(target.file, 'utf8');
    } catch (err) {
      report.push({ file: target.file, status: 'missing', changes: 0, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let changes = 0;
    let already = 0;
    for (const [search, replace] of target.replacements) {
      const count = text.split(search).length - 1;
      if (count > 0) {
        text = text.split(search).join(replace);
        changes += count;
      } else if (text.includes(replace)) {
        already += 1;
      }
    }
    if (changes > 0) writeFileSync(target.file, text, 'utf8');
    report.push({
      file: target.file,
      status: changes > 0 ? 'patched' : already > 0 ? 'already-patched' : 'not-found',
      changes,
    });
  }
  return { nodesBaseDir, report };
}

// CLI entry: node capture/patch-n8n.mjs --stubhouse-port=8788 [--n8n-version=2.36.8] [--dir=<path>]
// (pathToFileURL, not manual string-building: on Windows `file://C:/...` is
// missing the third slash `file:///C:/...` needs, so a naive string compare
// against import.meta.url always fails and this guard silently never runs.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const stubhousePort = Number(arg('stubhouse-port', '8788'));
  const n8nVersion = arg('n8n-version', undefined);
  const nodesBaseDir = arg('dir', undefined);
  const { nodesBaseDir: usedDir, report } = patchN8n({ stubhousePort, n8nVersion, nodesBaseDir });
  console.log(`[patch-n8n] n8n-nodes-base: ${usedDir}`);
  for (const r of report) {
    console.log(`[patch-n8n] ${r.status.padEnd(15)} (${r.changes} change(s))  ${r.file}`);
  }
  const anyMissingOrNotFound = report.some((r) => r.status === 'missing' || r.status === 'not-found');
  if (anyMissingOrNotFound) {
    console.error('[patch-n8n] one or more targets were missing or did not match — the installed n8n release may have changed its source. Inspect before trusting a capture made against this install.');
    process.exit(1);
  }
}
