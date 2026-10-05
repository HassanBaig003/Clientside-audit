import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { browserUserAgent } from '../config';
import type { LabRecord, RenderedRecord } from '../types';
import type { RunContext } from './context';
import { startGuardProxy, type GuardProxy } from './proxy';
import { assessValidity } from '../validity/validity';

const require = createRequire(import.meta.url);
let axeSource: string | null = null;
function getAxe(): string {
  if (axeSource === null) axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

export const VIEWPORT = { width: 412, height: 915 };

/** Bounded, high-confidence automated rules only. Passing them is not a WCAG conformance claim. */
export const AXE_RULES = ['button-name', 'link-name', 'image-alt', 'input-image-alt', 'role-img-alt', 'area-alt', 'label', 'select-name', 'html-has-lang', 'frame-title'];

export interface RenderResult {
  record: RenderedRecord;
  dom: string | null;
}

/** Runs in the page. Marks hidden subtrees, measures horizontal overflow, and returns nothing the page can spoof into a finding by itself. */
const COLLECT_SCRIPT = `(() => {
  // The layout viewport width. window.innerWidth grows when mobile Chrome zooms out to fit overflowing content.
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const sel = (el) => {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
    return s;
  };
  let marked = 0;
  const walk = (el, depth) => {
    if (marked > 4000 || depth > 60) return;
    for (const c of el.children) {
      const tag = c.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
      const cs = getComputedStyle(c);
      // Navigation stays unmarked: collapsed mobile menus are still real, crawlable links.
      if ((cs.display === 'none' || cs.visibility === 'hidden') && !c.closest('nav,header')) {
        c.setAttribute('data-wa-hidden', '1');
        marked++;
        continue;
      }
      walk(c, depth + 1);
    }
  };
  if (document.body) walk(document.body, 0);
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const offenders = [];
  if (scrollWidth > vw + 2 && document.body) {
    const all = document.body.querySelectorAll('*');
    for (let i = 0; i < all.length && i < 6000; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > vw + 2) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' && cs.visibility === 'hidden') continue;
        offenders.push({ selector: sel(el.parentElement) + ' > ' + sel(el), right: Math.round(r.right), width: Math.round(r.width) });
      }
    }
    offenders.sort((a, b) => b.right - a.right);
  }
  const mixed = [];
  if (location.protocol === 'https:') {
    const q = (s, attr, type, active) => document.querySelectorAll(s).forEach((el) => {
      const v = el.getAttribute(attr) || '';
      if (/^http:\\/\\//i.test(v) && mixed.length < 20) mixed.push({ url: v.slice(0, 300), resource_type: type, blocked: active });
    });
    q('script[src]', 'src', 'script', true);
    q('link[rel~="stylesheet"][href]', 'href', 'stylesheet', true);
    q('iframe[src]', 'src', 'iframe', true);
    q('img[src]', 'src', 'image', false);
    q('video[src],audio[src],source[src]', 'src', 'media', false);
  }
  return { scrollWidth, vw, offenders: offenders.slice(0, 5), mixed };
})()`;

const QUIET_SCRIPT = `new Promise((resolve) => {
  let t = setTimeout(done, 500);
  const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 500); });
  function done() { obs.disconnect(); resolve('dom-quiet'); }
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(() => { obs.disconnect(); resolve('dom-still-changing'); }, 3000);
})`;

const PERF_INIT = `(() => {
  const w = window;
  w.__wa = { lcp: null, cls: 0, clsSources: [], longTasks: [], fcp: null };
  const sel = (el) => { if (!el || !el.tagName) return null; let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.'); return s; };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__wa.lcp = { t: e.startTime, el: sel(e.element), url: e.url || null, size: e.size }; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) continue; w.__wa.cls += e.value; for (const s of (e.sources || [])) { const n = sel(s.node); if (n && w.__wa.clsSources.length < 5 && !w.__wa.clsSources.includes(n)) w.__wa.clsSources.push(n); } } }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__wa.longTasks.push({ s: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') w.__wa.fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch (e) {}
})()`;

export class BrowserSession {
  private browser: Browser | null = null;
  private proxy: GuardProxy | null = null;
  constructor(private ctx: RunContext) {}

  private async ensure(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.proxy = await startGuardProxy(this.ctx);
    const cfg = this.ctx.cfg;
    const args = [`--proxy-server=http://127.0.0.1:${this.proxy.port}`, '--proxy-bypass-list=<-loopback>', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-gpu', '--disable-extensions'];
    if (cfg.chromium.noSandbox || process.getuid?.() === 0) args.push('--no-sandbox');
    this.browser = await chromium.launch({ headless: true, executablePath: cfg.chromium.executablePath ?? undefined, args });
    return this.browser;
  }

  get blockedRequests() {
    return this.proxy?.blocked ?? [];
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    await this.proxy?.close().catch(() => undefined);
    this.browser = null;
    this.proxy = null;
  }

  private async newContext(url: string): Promise<BrowserContext> {
    const browser = await this.ensure();
    const host = new URL(url).hostname;
    return browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: browserUserAgent(this.ctx.cfg),
      locale: 'en-US',
      serviceWorkers: 'block',
      acceptDownloads: false,
      // A fresh context per page: no operator cookies, no state carried between client pages.
      ignoreHTTPSErrors: this.ctx.guard.isFixtureHost(host),
    });
  }

  /** RENDERED profile: headless Chromium at ~412x915, final DOM, screenshot, bounded resource usage. */
  async render(url: string, assetPrefix: string): Promise<RenderResult> {
    const started = Date.now();
    const record: RenderedRecord = {
      profile: 'RENDERED',
      requested_url: url,
      final_url: null,
      status: null,
      headers: {},
      timing_ms: 0,
      rendered_at: new Date().toISOString(),
      acquisition: 'NOT_ATTEMPTED',
      error: null,
      validity: null,
      validity_evidence: [],
      dom_ref: null,
      screenshot_ref: null,
      viewport: VIEWPORT,
      console_errors: [],
      failed_requests: [],
      mixed_content: [],
      resource_count: 0,
      resource_bytes: 0,
      resource_cap_hit: false,
      overflow: null,
      axe: null,
      settle: 'not-started',
    };
    const stop = this.ctx.blocked();
    if (stop) {
      record.acquisition = stop;
      record.error = `Render not started: ${stop}`;
      return { record, dom: null };
    }
    const budgets = this.ctx.budgets;
    let context: BrowserContext | null = null;
    let dom: string | null = null;
    try {
      this.ctx.counters.renders++;
      context = await this.newContext(url);
      const page = await context.newPage();
      page.on('dialog', (d) => d.dismiss().catch(() => undefined));
      page.on('console', (m) => {
        if (m.type() === 'error' && record.console_errors.length < 10) record.console_errors.push(m.text().slice(0, 300));
      });
      page.on('pageerror', (e) => {
        if (record.console_errors.length < 10) record.console_errors.push(`Uncaught: ${String(e.message).slice(0, 280)}`);
      });
      page.on('requestfailed', (r) => {
        if (record.failed_requests.length < 15) record.failed_requests.push({ url: r.url().slice(0, 300), reason: r.failure()?.errorText ?? 'failed' });
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      cdp.on('Network.loadingFinished', (e: any) => {
        record.resource_bytes += Math.max(0, e.encodedDataLength ?? 0);
      });
      await page.route('**/*', (route) => {
        const req = route.request();
        const rurl = req.url();
        if (!/^https?:/i.test(rurl)) return route.continue().catch(() => undefined); // data:, blob:, about:
        if (this.ctx.signal.aborted) return route.abort('aborted').catch(() => undefined);
        record.resource_count++;
        if (!req.isNavigationRequest() && (record.resource_count > budgets.max_browser_resources_per_page || record.resource_bytes > budgets.max_browser_bytes_per_page)) {
          record.resource_cap_hit = true;
          return route.abort('blockedbyclient').catch(() => undefined);
        }
        return route.continue().catch(() => undefined);
      });

      const navTimeout = Math.max(1000, Math.min(budgets.render_timeout_ms, this.ctx.remainingMs()));
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      const afterNav = Math.max(500, navTimeout - (Date.now() - started));
      // Never rely on network idle: sites with persistent requests would never settle.
      const loaded = await page.waitForLoadState('load', { timeout: afterNav }).then(() => 'load', () => 'load-timeout');
      const quiet = await page.evaluate(QUIET_SCRIPT).catch(() => 'quiet-check-failed');
      record.settle = `${loaded}+${quiet}`;

      record.status = response?.status() ?? null;
      record.headers = lowerHeaders((await response?.allHeaders().catch(() => ({}))) ?? {});
      record.final_url = stripHash(page.url());

      const collected: any = await page.evaluate(COLLECT_SCRIPT).catch(() => null);
      if (collected) {
        record.overflow = { scroll_width: collected.scrollWidth, viewport_width: collected.vw, offenders: collected.offenders };
        record.mixed_content = collected.mixed;
      }
      dom = await page.content();

      const v = assessValidity({ status: record.status, headers: record.headers, html: dom, bodyComplete: true, truncatedReason: null, contentType: record.headers['content-type'] ?? 'text/html' });
      record.validity = v.validity;
      record.validity_evidence = v.evidence;

      if (v.validity === 'VALID_PAGE') {
        try {
          await page.evaluate(getAxe());
          const res: any = await page.evaluate(
            `axe.run(document, { runOnly: { type: 'rule', values: ${JSON.stringify(AXE_RULES)} }, resultTypes: ['violations', 'incomplete'] })`,
          );
          record.axe = {
            rules_run: AXE_RULES,
            violations: (res.violations ?? []).map((x: any) => ({
              id: x.id,
              impact: x.impact ?? null,
              help: x.help,
              help_url: x.helpUrl,
              nodes: (x.nodes ?? []).slice(0, 5).map((n: any) => ({ target: String((n.target ?? []).join(' ')).slice(0, 160), html: String(n.html ?? '').slice(0, 220) })),
            })),
            incomplete: (res.incomplete ?? []).map((x: any) => ({ id: x.id, help: x.help, count: (x.nodes ?? []).length })),
          };
        } catch (e: any) {
          record.axe = null;
          record.console_errors.push(`Accessibility checker could not run: ${String(e?.message ?? e).slice(0, 160)}`);
        }
      }
      const shot = await page.screenshot({ type: 'jpeg', quality: 62, fullPage: false, timeout: 8000 }).catch(() => null);
      if (shot) record.screenshot_ref = this.ctx.blobs.put(`${assetPrefix}-screenshot.jpg`, shot);
      record.dom_ref = this.ctx.blobs.put(`${assetPrefix}-rendered.html`, dom);
      record.acquisition = 'OK';
      if (record.resource_cap_hit) {
        this.ctx.limitations.add(`Rendering ${url} reached the browser resource cap (${budgets.max_browser_resources_per_page} requests / ${budgets.max_browser_bytes_per_page} bytes); later subresources were not loaded.`);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      record.acquisition = this.ctx.signal.aborted ? 'CANCELLED' : /Timeout .* exceeded/i.test(msg) ? 'TIMEOUT' : 'RENDER_FAILED';
      record.error = msg.split('\n')[0].slice(0, 300);
      dom = null;
    } finally {
      record.timing_ms = Date.now() - started;
      await context?.close().catch(() => undefined);
    }
    return { record, dom };
  }

  /**
   * Limited mobile lab diagnostics. Measured in this environment with throttling; never used for the
   * Core Web Vitals field verdict, and TBT is not INP.
   */
  async lab(pageId: string, url: string): Promise<LabRecord> {
    const environment = 'Headless Chromium, 412x915 viewport, CPU 4x slowdown, 150 ms RTT / 1.6 Mbps down / 0.75 Mbps up, cold cache, single run, auditor network location';
    const rec: LabRecord = {
      page_id: pageId, url, available: false, reason: null, environment, lcp_ms: null, lcp_element: null, lcp_resource: null, cls: null, cls_sources: [],
      tbt_ms: null, long_tasks: 0, render_blocking: [], transfer_bytes: null, requests: null, measured_at: new Date().toISOString(),
    };
    const stop = this.ctx.blocked();
    if (stop) {
      rec.reason = `Not run: ${stop}`;
      return rec;
    }
    let context: BrowserContext | null = null;
    try {
      this.ctx.counters.lab_runs++;
      context = await this.newContext(url);
      const page: Page = await context.newPage();
      page.on('dialog', (d) => d.dismiss().catch(() => undefined));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      let bytes = 0;
      let requests = 0;
      cdp.on('Network.loadingFinished', (e: any) => {
        bytes += Math.max(0, e.encodedDataLength ?? 0);
        requests++;
      });
      await page.addInitScript(PERF_INIT);
      const timeout = Math.max(2000, Math.min(this.ctx.budgets.render_timeout_ms * 2.5, this.ctx.remainingMs()));
      await page.goto(url, { waitUntil: 'load', timeout });
      await page.waitForTimeout(Math.min(2500, Math.max(0, this.ctx.remainingMs() - 500)));
      const data: any = await page.evaluate(`(() => {
        const w = window.__wa || {};
        const blocking = performance.getEntriesByType('resource').filter((r) => r.renderBlockingStatus === 'blocking').map((r) => r.name).slice(0, 8);
        return { ...w, blocking };
      })()`);
      const fcp = data.fcp ?? 0;
      rec.lcp_ms = data.lcp ? Math.round(data.lcp.t) : null;
      rec.lcp_element = data.lcp?.el ?? null;
      rec.lcp_resource = data.lcp?.url ?? null;
      rec.cls = typeof data.cls === 'number' ? Math.round(data.cls * 1000) / 1000 : null;
      rec.cls_sources = data.clsSources ?? [];
      const lts = (data.longTasks ?? []).filter((t: any) => t.s >= fcp);
      rec.long_tasks = lts.length;
      rec.tbt_ms = Math.round(lts.reduce((a: number, t: any) => a + Math.max(0, t.d - 50), 0));
      rec.render_blocking = data.blocking ?? [];
      rec.transfer_bytes = bytes;
      rec.requests = requests;
      rec.available = true;
    } catch (e: any) {
      rec.reason = String(e?.message ?? e).split('\n')[0].slice(0, 200);
    } finally {
      await context?.close().catch(() => undefined);
    }
    return rec;
  }
}

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

function stripHash(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString();
  } catch {
    return u;
  }
}

/** PDF rendering uses a separate offline browser: no proxy, no network, JavaScript disabled. */
export async function renderPdf(html: string, opts: { executablePath: string | null; noSandbox: boolean; footerLeft: string }): Promise<Buffer> {
  const args = ['--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions'];
  if (opts.noSandbox || process.getuid?.() === 0) args.push('--no-sandbox');
  const browser = await chromium.launch({ headless: true, executablePath: opts.executablePath ?? undefined, args });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    const page = await context.newPage();
    await page.route('**/*', (r) => (r.request().url().startsWith('data:') || r.request().url() === 'about:blank' ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-family:Inter,Arial,sans-serif;font-size:8px;color:#6B7280;padding:0 14mm;display:flex;justify-content:space-between;"><span>${esc(opts.footerLeft)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
      preferCSSPageSize: false,
    });
    return pdf;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
