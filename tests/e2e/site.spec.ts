import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { RunFile, SYSTEMS, formatSeconds } from '@lrd/schema';

const ROOT = join(import.meta.dirname, '..', '..');
function loadRun(id: string) {
  return RunFile.parse(JSON.parse(readFileSync(join(ROOT, `content/runs/${id}/run.json`), 'utf8')));
}

const RECORDING_RUN = loadRun('rec-medspa-happy'); // /demo's default tab, and / 's hero source (M1)
const SIM_RUN = loadRun('sim-medspa-happy'); // /demo's Simulator tab, and /limits' source
const SEAM_RUN = loadRun('rec-medspa-slack-401');

test.describe('320px — no horizontal scroll (Spec section 13, criterion 10)', () => {
  test.use({ viewport: { width: 320, height: 800 } });

  for (const path of ['/', '/demo', '/limits']) {
    test(`${path} has zero horizontal overflow at 320px`, async ({ page }) => {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    });
  }

  test('/demo: the visible ledger scrolls inside its own container, not the page', async ({ page }) => {
    await page.goto('/demo');
    const box = page.locator('#panel-recording .ledger-scroll');
    const { scrollW, clientW } = await box.evaluate((el) => ({ scrollW: el.scrollWidth, clientW: el.clientWidth }));
    // The table genuinely is wider than a 320px viewport (7 columns of real
    // data) — this asserts that width lives inside .ledger-scroll, not that
    // the table happens to fit.
    expect(scrollW).toBeGreaterThan(clientW);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBe(0);
  });
});

test.describe('zero JS on / (Spec section 13)', () => {
  test('/ ships no <script> tag at all', async ({ page }) => {
    const response = await page.goto('/');
    const html = await response!.text();
    expect(html.toLowerCase()).not.toContain('<script');
  });

  test('/demo ships no <script> tag either — the tab switcher is CSS-only', async ({ page }) => {
    const response = await page.goto('/demo');
    const html = await response!.text();
    expect(html.toLowerCase()).not.toContain('<script');
  });
});

test.describe('works with JavaScript disabled (Spec section 8/16, criterion 3)', () => {
  test.use({ javaScriptEnabled: false });

  test('/ delivers the headline number (from the real recording), its provenance flag, and the try link', async ({ page }) => {
    await page.goto('/');
    const dispatchMs = RECORDING_RUN.metrics.firstTouchDispatchMs;
    expect(dispatchMs).not.toBeNull();
    const headline = formatSeconds(dispatchMs as number);

    // Acceptance criterion 8: the number on the page equals the committed run file.
    await expect(page.locator('.hero__number')).toContainText(headline);
    await expect(page.locator('.hero__number')).toContainText('first touch');
    await expect(page.locator('.hero__flag')).toContainText('measured');

    const cta = page.getByRole('link', { name: /walk through the run/i });
    await expect(cta).toHaveAttribute('href', '/demo');
  });

  test('/ states the dispatch number\'s local-stub condition on the same surface as the number itself (dispatcher-added M1 honesty requirement)', async ({
    page,
  }) => {
    // firstTouchDispatchMs is 114-115ms *because the integrations are local
    // stubs* — nowhere may that render as a bare "0.1 s" beside the 42-hour
    // HBR benchmark without saying so on the same surface. See
    // packages/schema/src/labels.ts's numberFlag() and
    // packages/schema/test/labels.test.ts for the unit-level pin; this is
    // the rendered-HTML proof.
    await page.goto('/');
    const flag = page.locator('.hero__flag');
    await expect(flag).toContainText(/stub/i);
    await expect(flag).toContainText(/gohighlevel/i);

    // The number and its condition must sit together, not in different
    // sections of the page — assert they share the hero, not just that
    // both strings exist somewhere on the page.
    const hero = page.locator('.hero');
    await expect(hero.locator('.hero__number')).toBeVisible();
    await expect(hero.locator('.hero__flag')).toContainText(/stub/i);
  });

  test('/demo: the Recording tab is the default view — mode chip, full ledger, every artifact', async ({ page }) => {
    await page.goto('/demo');

    const recording = page.locator('#panel-recording');
    await expect(recording).toBeVisible();
    await expect(page.locator('#panel-simulator')).not.toBeVisible();

    const chip = recording.locator('.mode-chip');
    await expect(chip).toContainText('Recording');
    await expect(chip).toContainText(`n8n ${RECORDING_RUN.n8n?.version}`);
    await expect(chip).toContainText('Nothing was sent to anyone');

    const rows = recording.locator('table.ledger tbody tr');
    await expect(rows).toHaveCount(RECORDING_RUN.nodes.length);
    for (const node of RECORDING_RUN.nodes) {
      await expect(recording.locator('table.ledger')).toContainText(node.name);
    }

    await expect(recording.getByText(/composed the first-touch sms/i)).toBeVisible();
    const artifacts = recording.locator('.artifacts .artifact');
    await expect(artifacts).toHaveCount(4);
    await expect(recording.locator('.artifacts .artifact--empty')).toHaveCount(0);
    await expect(recording.locator('.sheet-row')).toBeVisible();
  });

  test('/demo: clicking the Simulator label switches tabs with no JavaScript at all', async ({ page }) => {
    await page.goto('/demo');
    await page.locator('label[for="tab-simulator"]').click();

    const simulator = page.locator('#panel-simulator');
    await expect(simulator).toBeVisible();
    await expect(page.locator('#panel-recording')).not.toBeVisible();

    const chip = simulator.locator('.mode-chip');
    await expect(chip).toContainText('Simulator');
    await expect(chip).toContainText('this is not n8n');

    const rows = simulator.locator('table.ledger tbody tr');
    await expect(rows).toHaveCount(SIM_RUN.nodes.length);
  });

  test('the recording tab links both run.json and execution.json, and both resolve to the committed files', async ({ page, request }) => {
    await page.goto('/demo');
    const recording = page.locator('#panel-recording');

    const runHref = await recording.locator(`a[href$="/runs/${RECORDING_RUN.id}/run.json"]`).getAttribute('href');
    expect(runHref).toBeTruthy();
    const runRes = await request.get(runHref as string);
    expect(runRes.status()).toBe(200);
    const runBody = await runRes.json();
    expect(runBody.id).toBe(RECORDING_RUN.id);
    expect(runBody.metrics.firstTouchDispatchMs).toBe(RECORDING_RUN.metrics.firstTouchDispatchMs);

    const execHref = await recording.locator(`a[href$="/runs/${RECORDING_RUN.id}/execution.json"]`).getAttribute('href');
    expect(execHref).toBeTruthy();
    const execRes = await request.get(execHref as string);
    expect(execRes.status()).toBe(200);
    const execBody = await execRes.json();
    expect(execBody).toBeTruthy(); // the raw n8n export — shape is n8n's, not ours; just prove it's really there

    // The seam recording's downloads are linked directly (no ledger page for it yet — M2).
    const seamRunHref = await page.locator(`a[href$="/runs/${SEAM_RUN.id}/run.json"]`).getAttribute('href');
    expect(seamRunHref).toBeTruthy();
  });

  test('/limits names every stubbed system and states that no SMS or email was ever sent (Spec section 16, criterion 2)', async ({
    page,
  }) => {
    await page.goto('/limits');
    const body = page.locator('main');
    for (const id of SIM_RUN.stubbed) {
      await expect(body).toContainText(SYSTEMS[id].name);
    }
    for (const id of SIM_RUN.simulated) {
      await expect(body).toContainText(SYSTEMS[id].name);
    }
    await expect(body).toContainText(/no sms or email was ever sent/i);
  });
});
