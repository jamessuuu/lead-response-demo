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
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.astro',
  '.wrangler',
  'test-results',
  'playwright-report',
  // capture/.n8n/<run-id>/ is n8n's own local instance data (gitignored,
  // ephemeral, deleted and rebuilt by every capture run) — it can contain
  // the inert placeholder credential strings capture.mjs generates
  // (non-secret by construction: stubhouse never validates them, nothing
  // outside 127.0.0.1 ever sees them), which happen to be shaped enough
  // like a real Bearer token to trip the generic pattern below. Equivalent
  // to excluding dist/.astro/.wrangler above, not a weakening of this scan.
  '.n8n',
]);
const EXCLUDED_FILES = new Set(['scripts/check-secrets.mjs', 'pnpm-lock.yaml']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.gif', '.pdf']);

/**
 * Each pattern names the shape it catches, for a readable failure message.
 * Exported (along with `walk` and `scanText` below) so
 * scripts/check-secrets.test.mjs can assert this exact scan finds nothing
 * under content/runs/** specifically, without re-implementing or drifting
 * from the vocabulary this CLI actually runs in CI.
 */
export const PATTERNS = [
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

/**
 * Recursively lists every file under dir, skipping EXCLUDED_DIRS (or a
 * caller-supplied set — scripts/check-secrets.test.mjs walks
 * content/runs/ directly, where none of these exclusions are reachable
 * anyway, but the parameter keeps this genuinely reusable rather than
 * ROOT-shaped).
 * @param {string} dir @param {Set<string>} excludedDirs @returns {string[]}
 */
export function walk(dir, excludedDirs = EXCLUDED_DIRS) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (excludedDirs.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, excludedDirs));
    else out.push(full);
  }
  return out;
}

/**
 * Scans one file's already-read text against every PATTERN. `rel` is used
 * only inside the returned hit messages (a display path, not a filesystem
 * lookup), so callers are free to pass whatever relative form makes sense
 * for their own root.
 * @param {string} rel @param {string} text @returns {string[]}
 */
export function scanText(rel, text) {
  const hits = [];
  for (const [label, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${rel}:${line}: looks like a ${label} — "${m[0].slice(0, 60)}${m[0].length > 60 ? '…' : ''}"`);
    }
  }
  return hits;
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
    hits.push(...scanText(rel, text));
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

// Only run the CLI (including its process.exit(1) on a hit) when this file
// is executed directly (`node scripts/check-secrets.mjs`) — not when
// imported for PATTERNS/walk/scanText, as scripts/check-secrets.test.mjs
// now does. Without this guard, importing this module for its exports
// would also re-run the full-tree scan as an import side effect and could
// exit the whole test process mid-import on a genuine hit, instead of
// failing that one test normally.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
