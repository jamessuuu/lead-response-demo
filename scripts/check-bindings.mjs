#!/usr/bin/env node
/**
 * Binding allow-list (Spec section 7 — "no cost ceiling, no ship"):
 * the Worker's entire binding list may only ever be `DB` (D1) and
 * `TURNSTILE_SECRET`. No LLM key, no SMS/email provider key, no GHL key —
 * there is no metered key in this repo, on purpose, by construction. This
 * script is the CI check that keeps that true.
 *
 * Three nets, deliberately overlapping:
 *  1. Parse worker/wrangler.jsonc (if it exists yet) and collect every
 *     declared binding name (d1_databases, kv_namespaces, r2_buckets, vars,
 *     durable_objects, queues, services, ai, hyperdrive, vectorize).
 *  2. Grep worker/src for `env.<NAME>` / `env['NAME']` access and collect
 *     every referenced name — secrets (like TURNSTILE_SECRET) are never
 *     declared in wrangler.jsonc, only read from `env` in code, so net 1
 *     alone would miss them.
 *  3. Grep the whole repo (excluding node_modules/.git/build output) for
 *     any identifier matching *_API_KEY — the blunter, broader net that
 *     catches a key typed into docs, .env.example, or a stray constant
 *     even before it becomes a real binding.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_BINDINGS = new Set(['DB', 'TURNSTILE_SECRET']);
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.astro',
  '.wrangler',
  'test-results',
  'playwright-report',
]);
// This script's own comments and variable names necessarily say "API_KEY";
// exclude both binding-check scripts from the repo-wide scan.
const EXCLUDED_FILES = new Set(['scripts/check-bindings.mjs', 'scripts/check-secrets.mjs']);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Strip `//` line comments from JSONC well enough for our own simple config. */
function stripJsonComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

function bindingNamesFromWrangler(path) {
  let json;
  try {
    json = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
  } catch (err) {
    return { error: `could not parse ${path} as JSONC: ${err instanceof Error ? err.message : String(err)}` };
  }
  const names = new Set();
  const collect = (arr, key) => {
    for (const item of arr ?? []) if (item && typeof item[key] === 'string') names.add(item[key]);
  };
  collect(json.d1_databases, 'binding');
  collect(json.kv_namespaces, 'binding');
  collect(json.r2_buckets, 'binding');
  collect(json.queues?.producers, 'binding');
  collect(json.queues?.consumers, 'binding');
  collect(json.services, 'binding');
  collect(json.durable_objects?.bindings, 'name');
  collect(json.vectorize, 'binding');
  if (json.ai?.binding) names.add(json.ai.binding);
  if (json.vars && typeof json.vars === 'object') for (const k of Object.keys(json.vars)) names.add(k);
  return { names };
}

function envAccessNamesFromSource(files) {
  const names = new Set();
  const pattern = /\benv(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])/g;
  for (const file of files) {
    if (!/\.(ts|tsx|mjs|js)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(pattern)) names.add(m[1] ?? m[2]);
  }
  return names;
}

function apiKeyMentions(files) {
  const hits = [];
  const pattern = /\b[A-Z][A-Z0-9]*_API_KEY\b/g;
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (EXCLUDED_FILES.has(rel)) continue;
    if (rel.endsWith('pnpm-lock.yaml')) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable; not a text secret carrier we can grep
    }
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${rel}:${line}: ${m[0]}`);
    }
  }
  return hits;
}

function main() {
  const problems = [];

  const wranglerPath = join(ROOT, 'worker/wrangler.jsonc');
  try {
    statSync(wranglerPath);
    const result = bindingNamesFromWrangler(wranglerPath);
    if (result.error) {
      problems.push(result.error);
    } else {
      for (const name of result.names) {
        if (!ALLOWED_BINDINGS.has(name)) {
          problems.push(`worker/wrangler.jsonc declares binding "${name}", which is not in the allow-list (${[...ALLOWED_BINDINGS].join(', ')}).`);
        }
      }
    }
  } catch {
    console.log('worker/wrangler.jsonc does not exist yet — skipping declared-binding check.');
  }

  const workerSrc = join(ROOT, 'worker/src');
  try {
    statSync(workerSrc);
    const files = walk(workerSrc);
    for (const name of envAccessNamesFromSource(files)) {
      if (!ALLOWED_BINDINGS.has(name)) {
        problems.push(`worker/src reads env.${name}, which is not in the allow-list (${[...ALLOWED_BINDINGS].join(', ')}).`);
      }
    }
  } catch {
    console.log('worker/src does not exist yet — skipping env-access check.');
  }

  const allFiles = walk(ROOT);
  const hits = apiKeyMentions(allFiles);
  for (const hit of hits) problems.push(`*_API_KEY mention: ${hit}`);

  if (problems.length > 0) {
    console.error('Binding allow-list check FAILED:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nOnly ${[...ALLOWED_BINDINGS].join(' and ')} are allowed. See Spec section 7.`);
    process.exit(1);
  }

  console.log(`Binding allow-list check passed: nothing outside {${[...ALLOWED_BINDINGS].join(', ')}}, no *_API_KEY anywhere in the repo.`);
}

main();
