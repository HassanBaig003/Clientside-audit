/**
 * End-to-end verification against the controlled fixture sites (FIXTURE / DEMO mode):
 * starts the fixtures and the built app, drives the real UI in Chromium, captures screenshots,
 * exports the audit JSON and downloads the PDF. Output goes to ./verification.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../server/src/config';
import { buildApp } from '../server/src/api/server';
import { startFixtures } from '../server/test/fixtures/server';
import { testEnv, TOKEN_A } from '../server/test/harness';

const out = path.resolve('verification');
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-demo-'));
const cfg = loadConfig({
  ...testEnv(dataDir, { CRUX_API_KEY: 'fixture', CRUX_API_BASE: 'http://127.0.0.1:18080/__crux', BUDGET_MAX_LAB_PERFORMANCE_PAGES: '3', BUDGET_MINIMUM_REQUEST_SPACING_MS: '120' }),
  WEB_DIR: path.resolve('dist/web'), PORT: '18090', HOST: '127.0.0.1',
});
const fx = await startFixtures(cfg.fixture.httpPort, cfg.fixture.httpsPort);
const app = await buildApp(cfg);
await app.fastify.listen({ host: cfg.host, port: cfg.port });
const base = `http://127.0.0.1:${cfg.port}`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const shot = async (name: string, fullPage = true) => {
  await page.screenshot({ path: path.join(out, 'screenshots', `${name}.png`), fullPage });
  console.log('screenshot', name);
};

try {
  // Sign in
  await page.goto(base);
  await page.getByLabel('Access token').fill(TOKEN_A);
  await shot('00-sign-in');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'New initial audit' }).waitFor();

  // Screen 1: setup with the optional page review switched on
  await page.getByLabel('Client or project name').fill('Harbor Bikes (fixture client)');
  await page.getByLabel('Website URL').fill('demo.test');
  await page.getByText('Review the proposed pages before the audit runs').click();
  await page.locator('summary', { hasText: 'Advanced options' }).click();
  await page.getByLabel('Prepared by').fill('Wellows audit team');
  await shot('01-setup');
  // inline validation state
  await page.getByLabel('Website URL').fill('ftp://demo.test');
  await page.getByLabel('Website URL').blur();
  await shot('01b-setup-invalid-input');
  await page.getByLabel('Website URL').fill('demo.test');
  await page.getByRole('button', { name: 'Discover pages' }).click();

  // Discovery -> selection review
  await page.getByRole('heading', { name: /Proposed pages for demo\.test/ }).waitFor({ timeout: 60000 });
  await shot('02-page-selection');
  await page.getByLabel('Include https://demo.test/bikes/harbour-8').check();
  await page.getByRole('button', { name: /Run audit with 10 pages/ }).click();

  // Screen 2: live audit
  await page.getByRole('heading', { name: 'Audit in progress' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(3500);
  await shot('03-live-audit');

  // Screen 3: results overview
  await page.getByRole('tab', { name: 'Overview' }).waitFor({ timeout: 180000 });
  await page.waitForTimeout(600);
  await shot('04-results-overview');
  const auditId = page.url().split('/audit/')[1].split('/')[0];
  const uiStats = await page.locator('.stat .value').allInnerTexts();
  const uiTabs = await page.getByRole('tab').allInnerTexts();

  // Screen 4: pages and page detail
  await page.getByRole('tab', { name: /^Pages/ }).click();
  await shot('05-pages');
  await page.getByRole('button', { name: 'Details' }).first().click();
  await page.locator('dialog img.shot').waitFor();
  await page.waitForTimeout(500);
  await shot('06-page-detail', false);
  await page.getByRole('button', { name: 'Close' }).click();

  // Screen 5: findings and evidence
  await page.getByRole('tab', { name: /^Findings/ }).click();
  await page.locator('summary', { hasText: 'Observed evidence' }).first().click();
  await shot('07-findings');
  await page.getByLabel('Severity').selectOption('OPP');
  await page.locator('summary', { hasText: 'Template: requires verified values' }).first().click();
  await shot('07b-findings-template-code');
  await page.getByRole('tab', { name: 'Evidence' }).click();
  await page.waitForTimeout(400);
  await shot('08-evidence', false);

  // Screen 6: report preview and history
  await page.getByRole('tab', { name: 'Report' }).click();
  await page.locator('iframe.pdf-frame').waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot('09-report-preview', false);
  await page.goto(`${base}/#/`);
  await page.getByRole('heading', { name: 'Audit history' }).waitFor();
  await page.waitForTimeout(800);
  await shot('10-history');

  // Mobile width check of the overview
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#/audit/${auditId}`);
  await page.getByRole('tab', { name: 'Overview' }).waitFor();
  await page.waitForTimeout(500);
  await shot('11-overview-mobile');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('mobile horizontal overflow px:', overflow);

  // A blocked site state (challenge) through the same UI
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`${base}/#/`);
  await page.getByLabel('Website URL').fill('challenge.test');
  await page.getByRole('button', { name: 'Run audit' }).click();
  await page.getByRole('tab', { name: 'Overview' }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(500);
  await shot('12-blocked-site-state');

  // Exports through the authenticated API
  const pdf = await ctx.request.get(`${base}/api/v1/audits/${auditId}/report/download`);
  fs.writeFileSync(path.join(out, 'sample-report-fixture-demo.pdf'), await pdf.body());
  const json = await ctx.request.get(`${base}/api/v1/audits/${auditId}/export`);
  fs.writeFileSync(path.join(out, 'sample-audit-fixture-demo.json'), await json.body());
  // UI / PDF / JSON parity: the same stored counts, scores and affected pages must appear in all three.
  const a = JSON.parse((await json.body()).toString());
  const { execFileSync } = await import('node:child_process');
  const pdfText = execFileSync('pdftotext', ['-layout', path.join(out, 'sample-report-fixture-demo.pdf'), '-']).toString().replace(/\s+/g, ' ');
  // Reading-order extraction keeps a wrapped table cell contiguous, which the layout mode does not.
  const pdfFlow = execFileSync('pdftotext', [path.join(out, 'sample-report-fixture-demo.pdf'), '-']).toString().replace(/\s+/g, ' ');
  const th = a.scores.technical_health;
  const ai = a.scores.ai_accessibility;
  const checks: [string, boolean][] = [
    ['UI technical health equals JSON', uiStats[0].startsWith(String(th.value))],
    ['UI AI accessibility equals JSON', uiStats[1].startsWith(String(ai.value))],
    ['UI critical+high equals JSON', uiStats[2].trim() === String(a.summary.counts.critical + a.summary.counts.high)],
    ['UI valid pages equals JSON', uiStats[3].startsWith(String(a.coverage.pages.valid))],
    ['UI findings tab count equals JSON', uiTabs.some((t: string) => t === `Findings (${a.root_issues.length})`)],
    ['PDF technical health equals JSON', pdfText.includes(`INITIAL TECHNICAL HEALTH ${th.value} / 100`) || new RegExp(`${th.value} / 100 +${ai.value} / 100`).test(pdfText)],
    ['PDF coverage equals JSON', pdfText.includes(`Test coverage ${th.coverage.pct}% (${th.coverage.evaluated_units} of ${th.coverage.applicable_units} applicable check units`)],
    ['PDF AI coverage equals JSON', pdfText.includes(`Test coverage ${ai.coverage.pct}% (${ai.coverage.evaluated_units} of ${ai.coverage.applicable_units} applicable check units`)],
    ['PDF valid/selected equals JSON', pdfText.includes(`${a.coverage.pages.valid} valid page(s) evaluated of ${a.coverage.pages.selected} selected`)],
    ['PDF lists every root issue ID and title', a.root_issues.every((i: any) => pdfText.includes(i.issue_id) && pdfText.includes(i.title.slice(0, 40)))],
    ['PDF lists every audited URL', a.pages.every((p: any) => pdfText.replace(/\u200b/g, '').includes(p.url))],
    ['PDF recommendation rows carry the same affected page IDs', (() => {
      // Layout-mode text keeps table rows together. Compare per row: the text between one issue ID and the next inside section 5 must name every affected page ID.
      const sec = pdfText.slice(pdfText.indexOf('5. Recommendations'), pdfText.indexOf('6. Action plan'));
      return a.root_issues.every((i: any, n: number) => {
        const start = sec.indexOf(i.issue_id);
        const next = a.root_issues[n + 1] ? sec.indexOf(a.root_issues[n + 1].issue_id, start + 1) : sec.length;
        const row = sec.slice(start, next < 0 ? sec.length : next);
        return start >= 0 && (i.affected_page_ids.length ? i.affected_page_ids.every((p: string) => row.includes(p)) : row.includes('Site-level'));
      });
    })()],
    ['PDF is labelled fixture/demo', pdfText.includes('FIXTURE / DEMO DATA')],
    ['PDF states sitemap scope', pdfText.includes('does not parse XML')],
  ];
  fs.writeFileSync(path.join(out, 'parity.json'), JSON.stringify({ audit_id: auditId, ui_stats: uiStats, checks: Object.fromEntries(checks) }, null, 2));
  for (const [name, ok] of checks) console.log(ok ? 'PARITY OK  ' : 'PARITY FAIL', name);
  console.log('pdf status', pdf.status(), pdf.headers()['content-type'], (await pdf.body()).length, 'bytes');
  console.log('audit', auditId);
} finally {
  await browser.close();
  await app.fastify.close();
  app.store.close();
  await fx.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
