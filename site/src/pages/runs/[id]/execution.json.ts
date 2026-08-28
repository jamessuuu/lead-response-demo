import type { APIRoute, GetStaticPaths } from 'astro';
import { loadRun, readExecutionRaw } from '../../../lib/runs.ts';

/**
 * Serves the raw, untouched n8n execution export beside a recording (Spec
 * section 4's three-file shape; section 6's static downloads;
 * section 16, criterion 16: "downloads work: ... raw execution export").
 * Only recordings have this file — validateRunDirectory (via loadRun,
 * through the schema's REQUIRED_SIBLINGS) refuses a "recording" mode run
 * missing it, so listing a simulator id here would fail the build loudly
 * rather than serve a lie.
 */
export const getStaticPaths: GetStaticPaths = () => [
  { params: { id: 'rec-medspa-happy' } },
  { params: { id: 'rec-medspa-slack-401' } },
];

export const GET: APIRoute = ({ params }) => {
  const id = params.id;
  if (!id) return new Response('Not found', { status: 404 });
  const run = loadRun(id);
  if (run.mode !== 'recording') return new Response('Not found — this run has no execution export.', { status: 404 });
  const raw = readExecutionRaw(id);
  return new Response(raw, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `inline; filename="${id}.execution.json"`,
    },
  });
};
