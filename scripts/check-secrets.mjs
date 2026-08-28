#!/usr/bin/env node
/**
 * Secret-shaped-string scan (Spec section 4, decision 3): "redaction at
 * capture, never at render... CI greps committed runs for secret-shaped
 * strings (the harness secret guard is the second net)." This is the first
 * net, specific to this repo: it does not know about ~/.claude's secret
 * guard and does not rely on it.
 *
 * Scoped to the whole tracked tree (excluding node_modules/.git/build
 * output and this script itself, which necessarily contains the detection
 * vocabulary). content/runs/** matters most — a run file is the one place
 * real capture data could ever land — but source and docs are scanned too;
 * a credential typed into a comment is just as real a leak.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.astro',
  '.wrangler',
  'test-results',
  'playwright-report',
]);
const EXCLUDED_FILES = new Set(['scripts/check-secrets.mjs', 'pnpm-lock.yaml']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.gif', '.pdf']);

/** Each pattern names the shape it catches, for a readable failure message. */
const PATTERNS = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['generic Bearer token', /\bBearer\s+[A-Za-z0-9\-_.=]{20,}\b/g],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g],
  ['PEM private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  [
    'assignment to a key/secret/token/password-named field with a long opaque value',
    /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9+/_\-]{16,}['"]/gi,
  ],
  ['un-redacted Authorization header value', /"authorization"\s*:\s*"(?!REDACTED|<)[^"]{8,}"/gi],
];

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

function main() {
  const hits = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (EXCLUDED_FILES.has(rel)) continue;
    if (BINARY_EXT.has(rel.slice(rel.lastIndexOf('.')))) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [label, pattern] of PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${rel}:${line}: looks like a ${label} — "${m[0].slice(0, 60)}${m[0].length > 60 ? '…' : ''}"`);
      }
    }
  }

  if (hits.length > 0) {
    console.error('Secret scan FAILED — the following look secret-shaped:\n');
    for (const h of hits) console.error(`  - ${h}`);
    console.error(
      '\nIf this is a genuine false positive (a masked/fixture value that happens to match), narrow the ' +
        'pattern in scripts/check-secrets.mjs rather than deleting the check.',
    );
    process.exit(1);
  }

  console.log('Secret scan passed: no secret-shaped strings found in the tracked tree.');
}

main();
