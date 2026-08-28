import { Hono } from 'hono';

/**
 * M0 scaffold. Only GET /api/health exists.
 *
 * Per Spec section 6, the full surface (POST /api/lead, GET
 * /api/run/:token/stream, GET /api/quota) arrives at M2 together with the
 * D1 binding and Turnstile secret this Env does not yet declare. Building
 * a fake /api/lead now — one that accepts a POST and does nothing real —
 * is exactly the kind of placeholder the honesty architecture (Spec
 * section 2) exists to refuse: absent features stay absent, not faked.
 * worker/test/health.test.ts asserts the 404 directly.
 */

export interface Env {
  // Intentionally empty at M0. M2 adds exactly `DB: D1Database` and
  // `TURNSTILE_SECRET: string` and nothing else — see Spec section 7 and
  // scripts/check-bindings.mjs, which fails the build on anything wider.
}

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: '@lrd/worker',
    milestone: 'M0',
    bindings: { db: false, turnstileSecret: false },
    note: 'D1 and Turnstile arrive at M2. This route is a scaffold, not a stub for them.',
  }),
);

export default app;
