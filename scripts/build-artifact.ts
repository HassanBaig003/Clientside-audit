/**
 * Builds the read-only preview page: the real UI over stored FIXTURE / DEMO audits, plus a browser of every
 * source file. Usage: tsx scripts/build-artifact.ts <output.html>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeHarness, TENANT_A } from '../server/test/harness';
import { RULES } from '../server/src/checks/registry';
import type { Audit } from '../server/src/types';

const outFile = path.resolve(process.argv[2] ?? 'artifact/index.html');
const root = path.resolve('.');

// ---- 1. Stored fixture audits ---------------------------------------------------------------------------------
const h = await makeHarness({ CRUX_API_KEY: 'fixture', CRUX_API_BASE: 'http://127.0.0.1:18080/__crux', BUDGET_MAX_LAB_PERFORMANCE_PAGES: '3' });
const audits: Audit[] = [];
const assets: Record<string, string> = {};
const reportPages: Record<string, string[]> = {};
try {
  const runs: [string, string, boolean][] = [
    ['demo.test', 'Harbor Bikes (fixture client)', true],
    ['ssr.test', 'Northwind Analytics (fixture client)', true],
    ['challenge.test', 'Blocked site (fixture)', true],
    ['jsshell.test', 'Page selection example (fixture)', false],
  ];
  for (const [url, client, auto] of runs) {
    const a = await h.run({ url, client_name: client, auto_run: auto, branding: { prepared_by: 'Wellows audit team' } }, TENANT_A);
    audits.push(a);
    console.log(url, a.status, a.run_quality, 'pages', a.pages.length, 'report', a.report.state);
    const blobs = h.store.blobs(a.audit_id);
    for (const p of a.pages) {
      if (!p.screenshot_ref) continue;
      const b = blobs.get(p.screenshot_ref);
      if (b) assets[p.screenshot_ref] = `data:image/jpeg;base64,${b.toString('base64')}`;
    }
    if (a.report.state === 'READY') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pages-'));
      execFileSync('pdftoppm', ['-jpeg', '-jpegopt', 'quality=72', '-r', '78', h.store.reportPath(a.audit_id), path.join(tmp, 'p')]);
      reportPages[a.audit_id] = fs.readdirSync(tmp).sort().map((f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(tmp, f)).toString('base64')}`);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
} finally {
  await h.close();
}

// ---- 2. Source files -------------------------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', 'dist', 'data', 'verification', '.git', 'artifact']);
const SKIP_FILES = new Set(['package-lock.json', 'scripts/smoke.ts']);
const files: { path: string; content: string }[] = [];
const walk = (dir: string) => {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full);
    } else if (!SKIP_FILES.has(rel) && /\.(ts|tsx|css|html|json|md|example|gitignore|dockerignore)$|^Dockerfile$/.test(name)) {
      files.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
    }
  }
};
walk(root);

// ---- 3. Preview bundle -------------------------------------------------------------------------------------------
execFileSync('npx', ['vite', 'build', '--config', 'web/vite.demo.config.ts'], { stdio: 'ignore' });
const js = fs.readFileSync('dist/preview/preview.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(fs.readdirSync('dist/preview').map((f) => path.join('dist/preview', f)).find((f) => f.endsWith('.css'))!, 'utf8');

const data = { audits, assets, report_pages: reportPages, rules: RULES.map((r) => ({ check_id: r.check_id, name: r.name })), files };
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const json = JSON.stringify(data).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

// The publish step adds the document skeleton, so this file has no doctype, html, head or body tags.
const page = `<title>Wellows Initial Audit</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
/* Layout: the product's own interface, shown as it ships. One deliberate light look (the product is a light SaaS UI). */
:root { color-scheme: light; }
${css}
</style>
<div id="root"><p style="padding:24px;font-family:system-ui,sans-serif;color:#111827;background:#f4f5f7">Loading the audit preview…</p></div>
<script>window.__WA_DEMO__ = ${json};</script>
<script>${js}</script>
`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, page);
console.log('wrote', outFile, `${(page.length / 1024 / 1024).toFixed(2)} MB`, 'files', files.length, 'screenshots', Object.keys(assets).length, 'report pages', Object.values(reportPages).reduce((n, p) => n + p.length, 0));
