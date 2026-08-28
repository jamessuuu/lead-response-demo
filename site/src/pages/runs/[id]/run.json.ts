import type { APIRoute, GetStaticPaths } from 'astro';
import { loadRun, readRunRaw } from '../../../lib/runs.ts';

/**
 * Serves the exact committed run.json as a download (Spec section 6:
 * static downloads on Pages; section 16, criterion 16: "downloads work").
 * Only the run(s) actually linked from the site render — /demo links
 * exactly one at M0. Widen this list as more scenarios get pages.
 */
export const getStaticPaths: GetStaticPaths = () => [{ params: { id: 'sim-medspa-happy' } }];

export const GET: APIRoute = ({ params }) => {
  const id = params.id;
  if (!id) return new Response('Not found', { status: 404 });
  // Validates against the schema, throwing (and failing the build) if the
  // committed file is malformed — the same guarantee /demo itself relies on.
  loadRun(id);
  const raw = readRunRaw(id);
  return new Response(raw, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `inline; filename="${id}.run.json"`,
    },
  });
};
