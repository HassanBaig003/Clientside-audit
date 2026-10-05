import type { Env, PageWork } from '../checks/engine';
import { anyValid, renValid } from '../checks/engine';
import type { FieldRecord, Finding } from '../types';
import type { RunContext } from '../net/context';

const METRICS = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'];
const FIELD_CAVEAT = 'Third-party data: Chrome UX Report field data for real Chrome users over the stated collection period.';

function fmtDate(d: any): string {
  return d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '';
}

/** CrUX query. A missing key, an API error or "no record" is NOT_TESTABLE, never "poor" and never proof of low traffic. */
export async function queryCrux(ctx: RunContext, scope: 'URL' | 'ORIGIN', key: string, pageId: string | null): Promise<FieldRecord> {
  const base: FieldRecord = { scope, key, page_id: pageId, available: false, reason: null, form_factor: null, collection_period: null, metrics: { lcp_ms: null, inp_ms: null, cls: null }, assessment: 'UNAVAILABLE' };
  const cfg = ctx.cfg.crux;
  if (!cfg.apiKey) return { ...base, reason: 'No CrUX API key is configured; field data was not queried.' };
  if (ctx.blocked()) return { ...base, reason: `Not queried: ${ctx.blocked()}` };
  try {
    ctx.counters.crux_requests++;
    const res = await fetch(`${cfg.baseUrl}/records:queryRecord?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [scope === 'URL' ? 'url' : 'origin']: key, formFactor: 'PHONE', metrics: METRICS }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(10000, ctx.remainingMs()))),
    });
    if (res.status === 404) return { ...base, reason: `CrUX has no eligible ${scope === 'URL' ? 'URL-level' : 'origin-level'} record for this key. This does not indicate poor performance.` };
    if (!res.ok) return { ...base, reason: `CrUX API returned HTTP ${res.status}; field data is unavailable for this run.` };
    const json: any = await res.json();
    const m = json?.record?.metrics ?? {};
    const p75 = (name: string) => {
      const v = m[name]?.percentiles?.p75;
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };
    const metrics = { lcp_ms: p75(METRICS[0]), inp_ms: p75(METRICS[1]), cls: p75(METRICS[2]) };
    const cp = json?.record?.collectionPeriod;
    const rec: FieldRecord = { ...base, available: true, form_factor: json?.record?.key?.formFactor ?? 'PHONE', collection_period: cp ? { first: fmtDate(cp.firstDate), last: fmtDate(cp.lastDate) } : null, metrics };
    rec.assessment = assess(metrics);
    return rec;
  } catch (e: any) {
    return { ...base, reason: `CrUX API request failed (${String(e?.name ?? e?.message ?? e).slice(0, 80)}); field data is unavailable for this run.` };
  }
}

/** p75 thresholds: good LCP <= 2500 ms, INP <= 200 ms, CLS <= 0.1; poor above 4000 ms, 500 ms, 0.25. */
export function assess(m: FieldRecord['metrics']): FieldRecord['assessment'] {
  const known = [m.lcp_ms, m.inp_ms, m.cls].filter((v) => v !== null).length;
  if (!known) return 'UNAVAILABLE';
  const poor = (m.lcp_ms !== null && m.lcp_ms > 4000) || (m.inp_ms !== null && m.inp_ms > 500) || (m.cls !== null && m.cls > 0.25);
  const ni = (m.lcp_ms !== null && m.lcp_ms > 2500) || (m.inp_ms !== null && m.inp_ms > 200) || (m.cls !== null && m.cls > 0.1);
  if (poor) return 'POOR';
  if (ni) return 'NEEDS_IMPROVEMENT';
  return known === 3 ? 'GOOD' : 'INCOMPLETE';
}

const show = (m: FieldRecord['metrics']) => `LCP ${m.lcp_ms === null ? 'n/a' : `${(m.lcp_ms / 1000).toFixed(2)} s`}, INP ${m.inp_ms === null ? 'n/a' : `${m.inp_ms} ms`}, CLS ${m.cls === null ? 'n/a' : m.cls}`;

export async function runPerformance(env: Env, onProgress: (done: number, total: number) => void) {
  const { rec, audit, acq, pages } = env;
  const ctx = acq.ctx;
  const valid = pages.filter(anyValid);
  const total = valid.length + 1 + Math.min(ctx.budgets.max_lab_performance_pages, valid.filter(renValid).length);
  let done = 0;

  // P-4.1 URL-level field data -----------------------------------------------------------------------------------
  for (const p of pages) {
    await rec.guard('P-4.1', p.rec.page_id, async () => {
      if (!anyValid(p)) return rec.untestable('P-4.1', p.rec.page_id, 'No genuine page response; field data was not queried.');
      const url = p.raw.record.final_url ?? p.rendered.record.final_url ?? p.rec.url;
      const f = await queryCrux(ctx, 'URL', url, p.rec.page_id);
      audit.performance.field.push(f);
      onProgress(++done, total);
      if (!f.available) return rec.untestable('P-4.1', p.rec.page_id, f.reason ?? 'Field data unavailable.');
      const ev = rec.ev({ url, profile: 'NONE', locator: 'CrUX API records:queryRecord (url, PHONE) p75', observed: `${show(f.metrics)}; collection period ${f.collection_period?.first ?? '?'} to ${f.collection_period?.last ?? '?'}; form factor ${f.form_factor}`, expected: 'LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1' });
      const findings: Finding[] = [];
      if (f.assessment === 'POOR' || f.assessment === 'NEEDS_IMPROVEMENT') {
        const bad = [
          f.metrics.lcp_ms !== null && f.metrics.lcp_ms > 2500 ? `LCP ${(f.metrics.lcp_ms / 1000).toFixed(2)} s` : null,
          f.metrics.inp_ms !== null && f.metrics.inp_ms > 200 ? `INP ${f.metrics.inp_ms} ms` : null,
          f.metrics.cls !== null && f.metrics.cls > 0.1 ? `CLS ${f.metrics.cls}` : null,
        ].filter(Boolean);
        findings.push(rec.finding({
          check_id: 'P-4.1', status: f.assessment === 'POOR' ? 'FAIL' : 'WARN', reason_code: f.assessment === 'POOR' ? 'CWV_FIELD_POOR' : 'CWV_FIELD_NEEDS_IMPROVEMENT', severity: f.assessment === 'POOR' ? 'HIGH' : 'MEDIUM',
          pages: [p.rec.page_id], evidence: [ev], confidence: 'THIRD_PARTY', caveat: FIELD_CAVEAT,
          title: f.assessment === 'POOR' ? 'Core Web Vitals field data is poor' : 'Core Web Vitals field data needs improvement', explanation: `URL-level p75 field values outside the good threshold: ${bad.join(', ')}.`,
          impact: 'Real users on phones experience slow loading, slow response to input or layout movement on this page.', action: 'Use the lab diagnostics for this page (where run) to find the LCP resource, long tasks and layout-shift sources, then re-check field data after the next collection period.', owner: 'Developer', effort: 'M',
        }));
      }
      const limitations = f.assessment === 'INCOMPLETE' ? ['Not all three metrics are reported for this URL, so a complete passing assessment cannot be given; the known metrics are within the good threshold.'] : [];
      rec.result({ check_id: 'P-4.1', page_id: p.rec.page_id, evidence: [ev], findings, limitations, missing: f.assessment === 'INCOMPLETE', notes: [FIELD_CAVEAT] });
    });
  }

  // P-4.2 origin-level context (unscored) -------------------------------------------------------------------------
  await rec.guard('P-4.2', null, async () => {
    const origin = audit.target.preferred_origin;
    if (!origin) return rec.untestable('P-4.2', null, 'No origin was established.');
    const f = await queryCrux(ctx, 'ORIGIN', origin, null);
    audit.performance.field.push(f);
    onProgress(++done, total);
    if (!f.available) return rec.untestable('P-4.2', null, f.reason ?? 'Field data unavailable.');
    const ev = rec.ev({ url: origin, profile: 'NONE', locator: 'CrUX API records:queryRecord (origin, PHONE) p75', observed: `${show(f.metrics)}; collection period ${f.collection_period?.first ?? '?'} to ${f.collection_period?.last ?? '?'}` });
    rec.result({ check_id: 'P-4.2', evidence: [ev], derivedStatus: 'PASS', notes: [`Origin-level assessment: ${f.assessment}. This aggregates all pages of the origin; it is context and is not any specific page's result.`, FIELD_CAVEAT] });
  });

  // P-4.3 lab diagnostics (unscored): homepage plus at most two other representative pages ----------------------------
  const labPages = valid.filter(renValid).slice(0, ctx.budgets.max_lab_performance_pages);
  const skipped = valid.filter((p) => !labPages.includes(p));
  for (const p of skipped) rec.na('P-4.3', p.rec.page_id, `Lab diagnostics run on at most ${ctx.budgets.max_lab_performance_pages} pages per audit; this page was not one of them.`);
  for (const p of labPages) {
    await rec.guard('P-4.3', p.rec.page_id, async () => {
      const lab = await acq.browser.lab(p.rec.page_id, p.rendered.record.final_url ?? p.rec.url);
      audit.performance.lab.push(lab);
      onProgress(++done, total);
      if (!lab.available) return rec.untestable('P-4.3', p.rec.page_id, `Lab run failed: ${lab.reason}`);
      const ev = rec.ev({ url: lab.url, profile: 'RENDERED', locator: 'lab run (PerformanceObserver)', observed: `LCP ${lab.lcp_ms} ms on ${lab.lcp_element ?? 'n/a'}${lab.lcp_resource ? ` (${lab.lcp_resource})` : ''}; CLS ${lab.cls}${lab.cls_sources.length ? ` from ${lab.cls_sources.join(', ')}` : ''}; TBT ${lab.tbt_ms} ms over ${lab.long_tasks} long task(s); ${lab.render_blocking.length} render-blocking resource(s); ${lab.requests} requests, ${lab.transfer_bytes} bytes`, at: lab.measured_at });
      const notes = [`Environment: ${lab.environment}.`, 'Lab measurements are diagnostics only: they do not decide the Core Web Vitals verdict, and TBT is not INP.'];
      if (lab.render_blocking.length) notes.push(`Render-blocking resources observed: ${lab.render_blocking.slice(0, 5).join(', ')}.`);
      rec.result({ check_id: 'P-4.3', page_id: p.rec.page_id, evidence: [ev], derivedStatus: 'PASS', notes });
    });
  }
  audit.performance.note = `Field data: CrUX URL-level p75 for phones where available. Lab diagnostics: ${labPages.length} page(s), unscored. Lighthouse scores are not used.`;
}

export type { PageWork };
