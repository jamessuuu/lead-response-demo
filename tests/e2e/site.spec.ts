import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { RunFile, SYSTEMS, formatSeconds } from '@lrd/schema';

const ROOT = join(import.meta.dirname, '..', '..');
const HAPPY_RUN = RunFile.parse(JSON.parse(readFileSync(join(ROOT, 'content/runs/sim-medspa-happy/run.json'), 'utf8')));

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

  test('/demo: the node ledger scrolls inside its own container, not the page', async ({ page }) => {
    await page.goto('/demo');
    const box = page.locator('.ledger-scroll');
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
});

test.describe('works with JavaScript disabled (Spec section 8/16, criterion 3)', () => {
  test.use({ javaScriptEnabled: false });

  test('/ delivers the headline number, its provenance flag, and the try link', async ({ page }) => {
    await page.goto('/');
    const dispatchMs = HAPPY_RUN.metrics.firstTouchDispatchMs;
    expect(dispatchMs).not.toBeNull();
    const headline = formatSeconds(dispatchMs as number);

    // Acceptance criterion 8: the number on the page equals the committed run file.
    await expect(page.locator('.hero__number')).toContainText(headline);
    await expect(page.locator('.hero__number')).toContainText('first touch');
    await expect(page.locator('.hero__flag')).toContainText('simulator run');

    const cta = page.getByRole('link', { name: /walk through the run/i });
    await expect(cta).toHaveAttribute('href', '/demo');
  });

  test('/demo delivers the mode chip, the full 14-node ledger, and every artifact', async ({ page }) => {
    await page.goto('/demo');

    const chip = page.locator('.mode-chip');
    await expect(chip).toContainText('Simulator');
    await expect(chip).toContainText('this is not n8n');

    const panel = page.locator('.panel');
    await expect(panel).toContainText('What this run is not');

    const rows = page.locator('table.ledger tbody tr');
    await expect(rows).toHaveCount(HAPPY_RUN.nodes.length);

    // Every node name from the run file actually renders somewhere in the table.
    for (const node of HAPPY_RUN.nodes) {
      await expect(page.locator('table.ledger')).toContainText(node.name);
    }

    await expect(page.getByText(/composed the first-touch sms/i)).toBeVisible();
    const artifacts = page.locator('.artifacts .artifact');
    await expect(artifacts).toHaveCount(4);
    await expect(page.locator('.artifacts .artifact--empty')).toHaveCount(0); // every artifact composed on the happy path

    await expect(page.locator('.sheet-row')).toBeVisible();
  });

  test('the run.json download link resolves and matches the committed file', async ({ page, request }) => {
    await page.goto('/demo');
    const href = await page.locator(`a[href$="/runs/${HAPPY_RUN.id}/run.json"]`).getAttribute('href');
    expect(href).toBeTruthy();
    const res = await request.get(href as string);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(HAPPY_RUN.id);
    expect(body.metrics.firstTouchDispatchMs).toBe(HAPPY_RUN.metrics.firstTouchDispatchMs);
  });

  test('/limits names every stubbed system and states that no SMS or email was ever sent (Spec section 16, criterion 2)', async ({
    page,
  }) => {
    await page.goto('/limits');
    const body = page.locator('main');
    for (const id of HAPPY_RUN.stubbed) {
      await expect(body).toContainText(SYSTEMS[id].name);
    }
    for (const id of HAPPY_RUN.simulated) {
      await expect(body).toContainText(SYSTEMS[id].name);
    }
    await expect(body).toContainText(/no sms or email was ever sent/i);
  });
});
