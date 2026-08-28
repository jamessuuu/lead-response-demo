import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunDirectory, type RunFile as RunFileType } from '@lrd/schema';

/**
 * Loads and validates a committed run.json directly (Node fs + Zod), rather
 * than through Astro's content.config.ts collection API. This deliberately
 * sidesteps coupling this repo's zod v4 schema to whichever zod version
 * Astro's Content Layer re-exports internally — the behavior the spec
 * actually asks for (content collections + Zod validate the run files at
 * build so a malformed recording cannot deploy) is identical either way:
 * `.astro` frontmatter runs in Node at build time for `output: 'static'`,
 * so a thrown Zod error here fails the build exactly the same. Recorded as
 * a deliberate implementation choice in docs/DEVIATIONS.md.
 *
 * Resolved from process.cwd(), not import.meta.url: Astro/Vite bundles this
 * module into dist/.prerender/chunks/ before it runs, so an import.meta.url
 * -relative path would resolve against that OUTPUT location instead of this
 * source file — cwd is a process-level property bundling can't move.
 * `astro build`/`astro dev` always run with cwd = site/ (pnpm's --filter
 * and package-script invocation both cd into the package first).
 */
const RUNS_DIR = join(process.cwd(), '..', 'content', 'runs');

/** The exact committed bytes of content/runs/<id>/run.json. */
export function readRunRaw(id: string): string {
  return readFileSync(join(RUNS_DIR, id, 'run.json'), 'utf8');
}

/** The exact committed bytes of content/runs/<id>/execution.json — recordings only. */
export function readExecutionRaw(id: string): string {
  return readFileSync(join(RUNS_DIR, id, 'execution.json'), 'utf8');
}

/**
 * Loads run.json AND checks it against its own directory listing via
 * validateRunDirectory — not a bare RunFile.safeParse. A recording missing
 * execution.json/attest.json is a schema-legal run.json on its own (the
 * REQUIRED_SIBLINGS check only exists at the directory level); skipping
 * that check here would mean the one place this repo enforces "a
 * recording without its siblings is not a recording" is drift-check.ts,
 * not the site build itself — this closes that gap rather than relying on
 * drift-check always running first.
 */
export function loadRun(id: string): RunFileType {
  const dir = join(RUNS_DIR, id);
  const path = join(dir, 'run.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readRunRaw(id));
  } catch (err) {
    throw new Error(`site/src/lib/runs.ts: could not read or parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    throw new Error(`site/src/lib/runs.ts: could not list ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return validateRunDirectory({ run: raw, files });
  } catch (err) {
    throw new Error(
      `site/src/lib/runs.ts: content/runs/${id}/run.json failed validation — the build must not ship a malformed or incomplete run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
