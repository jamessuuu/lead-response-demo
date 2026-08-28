import { describe, expect, it } from 'vitest';
import app from '../src/index.ts';

describe('GET /api/health', () => {
  it('reports ok with no bindings configured yet (M0)', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      service: '@lrd/worker',
      bindings: { db: false, turnstileSecret: false },
    });
  });
});

describe('no fake routes', () => {
  it('404s POST /api/lead — it does not exist until M2, and never as a stub', async () => {
    const res = await app.request('/api/lead', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('404s an arbitrary unknown route', async () => {
    const res = await app.request('/api/run/anything/stream');
    expect(res.status).toBe(404);
  });
});
