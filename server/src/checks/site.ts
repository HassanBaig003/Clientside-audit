import crypto from 'node:crypto';
import type { Acquirer } from '../net/acquire';
import type { Audit, SitemapVariantRow } from '../types';
import { assessValidity } from '../validity/validity';
import { extractPage, resolveCanonical } from '../extract/html';
import { apexWwwPair, isAliasHost, tryUrl, truncate } from '../util/url';
import type { RawResult } from '../net/context';

const PREFIX_BYTES = 4096;

/** Small bounded fetch for control endpoints; only status, headers and a tiny prefix are used. */
async function controlFetch(acq: Acquirer, url: string, purpose: string, maxBytes = PREFIX_BYTES): Promise<{ res: RawResult; challenge: string | null; htmlLike: boolean }> {
  const res = await acq.ctx.fetchRaw(url, { purpose, maxBytes, gate: (u) => acq.robots.auditorMayFetch(u), accept: '*/*' });
  const r = res.record;
  let challenge: string | null = null;
  if (r.acquisition === 'OK') {
    const v = assessValidity({ status: r.status, headers: r.headers, html: res.text, bodyComplete: true, truncatedReason: null, contentType: r.content_type, expectHtml: false });
    if (v.validity === 'ACCESS_CHALLENGE') challenge = v.evidence.join('; ');
  }
  const prefix = (res.text ?? '').slice(0, 600).trim().toLowerCase();
  const htmlLike = /text\/html/i.test(r.content_type ?? '') || /^<!doctype html|^<html[\s>]/.test(prefix);
  return { res, challenge, htmlLike };
}

/** HTTP/HTTPS and www/apex variants of the homepage, to observe origin consolidation. */
export async function probeOrigins(acq: Acquirer, audit: Audit): Promise<Audit['site']['origins']> {
  const host = audit.target.host;
  const pair = apexWwwPair(host);
  const hosts = pair ? [pair.apex, pair.www] : [host];
  const out: Audit['site']['origins'] = [];
  for (const scheme of ['https', 'http']) {
    for (const h of hosts) {
      const url = `${scheme}://${h}/`;
      if (acq.ctx.blocked()) {
        out.push({ url, status: null, final_url: null, hops: [], canonical: null, validity: null, error: `Not tested: ${acq.ctx.blocked()}` });
        continue;
      }
      const res = await acq.raw(url, 'origin variant');
      const r = res.record;
      let canonical: string | null = null;
      if (r.acquisition === 'OK' && r.validity === 'VALID_PAGE' && res.text && r.final_url) {
        const ex = extractPage(res.text, r.final_url, r.headers);
        const c = ex.canonical_head[0] ?? ex.canonical_http[0];
        canonical = c ? resolveCanonical(c, r.final_url, ex.base_href) : null;
      }
      out.push({ url, status: r.status, final_url: r.final_url, hops: r.hops, canonical, validity: r.validity, error: r.acquisition === 'OK' ? null : `${r.acquisition}${r.error ? `: ${r.error}` : ''}` });
    }
  }
  return out;
}

const ERROR_PAGE_RE = /\b(404|page (was )?not found|not found|page (does not|doesn'?t) exist|no longer (exists|available)|couldn'?t find (that|the|this) page|can'?t be found|nothing (was )?found|error 404|oops)\b/i;

/** At most one harmless nonexistent-path probe. */
export async function probeSoft404(acq: Acquirer, audit: Audit): Promise<Audit['site']['soft404']> {
  const origin = audit.target.preferred_origin;
  if (!origin) return { probe_url: null, status: null, outcome: 'NOT_TESTED', note: 'No reachable origin was established.' };
  const probe = `${origin}/wa-audit-missing-${crypto.randomBytes(6).toString('hex')}`;
  if (acq.ctx.blocked()) return { probe_url: probe, status: null, outcome: 'NOT_TESTED', note: `Not tested: ${acq.ctx.blocked()}` };
  const res = await acq.raw(probe, 'missing-page probe');
  const r = res.record;
  if (r.acquisition !== 'OK') return { probe_url: probe, status: null, outcome: 'NOT_TESTED', note: `The probe did not return a response (${r.acquisition}).` };
  if (r.validity === 'ACCESS_CHALLENGE') return { probe_url: probe, status: r.status, outcome: 'CHALLENGED', note: 'The probe returned an access challenge to this auditor; missing-page handling could not be observed.' };
  if (r.status === 404 || r.status === 410) return { probe_url: probe, status: r.status, outcome: 'CORRECT_STATUS', note: `A nonexistent path returns HTTP ${r.status}.` };
  if (r.status !== null && r.status >= 500) return { probe_url: probe, status: r.status, outcome: 'SERVER_ERROR', note: `A nonexistent path returns HTTP ${r.status}.` };
  if (r.status === 200 && r.validity === 'VALID_PAGE' && res.text) {
    const ex = extractPage(res.text, r.final_url ?? probe, r.headers);
    const redirected = r.hops.length > 0;
    const headline = `${ex.title ?? ''} | ${ex.h1.join(' / ')}`;
    if (ERROR_PAGE_RE.test(headline)) {
      return { probe_url: probe, status: 200, outcome: 'ERROR_CONTENT_WITH_200', note: `A nonexistent path returns HTTP 200 while the page presents itself as missing (title/H1: "${truncate(headline, 140)}").` };
    }
    return {
      probe_url: probe, status: 200, outcome: 'INCONCLUSIVE_200',
      note: redirected
        ? `A nonexistent path redirects to ${r.final_url} and returns HTTP 200. A 200 alone does not show how search engines classify it.`
        : 'A nonexistent path returns HTTP 200 with a page that does not clearly present itself as an error. This is inconclusive.',
    };
  }
  return { probe_url: probe, status: r.status, outcome: 'INCONCLUSIVE', note: `A nonexistent path returns HTTP ${r.status} (${r.validity}).` };
}

function classifySitemapRow(requested: string, role: SitemapVariantRow['role'], f: Awaited<ReturnType<typeof controlFetch>>): SitemapVariantRow {
  const r = f.res.record;
  const row: SitemapVariantRow = {
    requested_url: requested,
    initial_status: r.hops.length ? r.hops[0].status : r.status,
    hops: r.hops,
    final_url: r.final_url,
    final_status: r.status,
    network_error: r.acquisition === 'OK' ? null : `${r.acquisition}${r.error ? `: ${r.error}` : ''}`,
    content_type: r.content_type,
    result: 'INCONCLUSIVE',
    role,
    note: null,
  };
  if (r.acquisition !== 'OK') {
    row.note = r.acquisition === 'ROBOTS_DISALLOWED_FOR_AUDITOR' ? 'robots.txt does not allow this auditor to fetch the endpoint.' : 'No HTTP response was received.';
    return row;
  }
  if (f.challenge) {
    row.note = `Access challenge returned to this auditor (${truncate(f.challenge, 120)}).`;
    return row;
  }
  if (r.status === 200) {
    if (f.htmlLike) {
      row.note = 'HTTP 200 with an HTML document (likely a fallback page), so it is not treated as a sitemap response.';
      return row;
    }
    row.result = 'OPEN';
    row.note = r.hops.length ? `Opens after ${r.hops.length} redirect hop(s).` : 'Opens directly.';
    return row;
  }
  if (r.status === 429) {
    row.note = 'HTTP 429 (rate limited); inconclusive.';
    return row;
  }
  row.result = 'NOT_OPEN';
  row.note = `Final HTTP ${r.status}.`;
  return row;
}

export const SITEMAP_SCOPE_STATEMENT =
  'Sitemap scope: this audit tests only whether one parent sitemap endpoint opens over HTTP(S) on the relevant host variants. It does not parse XML, fetch child sitemaps, extract URLs, check lastmod, or measure coverage, and sitemap contents are not used to select pages.';

/** Parent sitemap: HTTP behaviour only. No XML parsing of any kind. */
export async function probeSitemap(acq: Acquirer, audit: Audit, robotsSitemaps: string[]): Promise<Audit['site']['sitemap']> {
  const origin = audit.target.preferred_origin;
  const out: Audit['site']['sitemap'] = { chosen: null, chosen_basis: 'none', matrix: [], scope_statement: SITEMAP_SCOPE_STATEMENT };
  if (!origin) return out;
  const siteHost = new URL(origin).hostname;

  const declared = robotsSitemaps.map((s) => tryUrl(s)).find((u) => u && /^https?:$/.test(u.protocol)) ?? null;
  let chosen: URL | null = null;
  const prefetched = new Map<string, Awaited<ReturnType<typeof controlFetch>>>();
  if (declared) {
    chosen = declared;
    out.chosen_basis = 'robots_declaration';
  } else {
    const httpsOrigin = origin.replace(/^http:/, 'https:');
    for (const p of ['/sitemap.xml', '/sitemap_index.xml']) {
      if (acq.ctx.blocked()) break;
      const url = `${origin.startsWith('https:') ? origin : httpsOrigin}${p}`;
      const f = await controlFetch(acq, url, 'sitemap fallback probe');
      prefetched.set(url, f);
      if (f.res.record.acquisition === 'OK' && f.res.record.status === 200 && !f.challenge && !f.htmlLike) {
        chosen = new URL(url);
        out.chosen_basis = 'fallback_probe';
        break;
      }
    }
    if (!chosen) {
      // Nothing opened: keep the probe rows so the report shows exactly what was tried.
      for (const [url, f] of prefetched) out.matrix.push(classifySitemapRow(url, 'canonical', f));
      return out;
    }
  }
  out.chosen = chosen.toString();

  // Build the variant list for the same path and query.
  const variants: { url: string; role: SitemapVariantRow['role'] }[] = [];
  const pq = chosen.pathname + chosen.search;
  const external = !isAliasHost(chosen.hostname, siteHost) && chosen.hostname !== siteHost;
  const pair = apexWwwPair(chosen.hostname);
  if (external || chosen.port) {
    // A declared external host or a non-default port is tested exactly as declared, never rewritten.
    variants.push({ url: chosen.toString(), role: 'declared' });
  } else if (pair) {
    for (const scheme of ['https', 'http']) for (const h of [pair.apex, pair.www]) variants.push({ url: `${scheme}://${h}${pq}`, role: 'variant' });
  } else {
    for (const scheme of ['https', 'http']) variants.push({ url: `${scheme}://${chosen.hostname}${pq}`, role: 'variant' });
  }
  for (const v of variants) {
    if (v.url === chosen.toString()) v.role = out.chosen_basis === 'robots_declaration' ? 'declared' : 'canonical';
  }
  if (!variants.some((v) => v.url === chosen!.toString())) variants.unshift({ url: chosen.toString(), role: 'declared' });

  for (const v of variants) {
    if (acq.ctx.blocked()) {
      out.matrix.push({ requested_url: v.url, initial_status: null, hops: [], final_url: null, final_status: null, network_error: `Not tested: ${acq.ctx.blocked()}`, content_type: null, result: 'INCONCLUSIVE', role: v.role, note: 'Run stopped before this variant was tested.' });
      continue;
    }
    const f = prefetched.get(v.url) ?? (await controlFetch(acq, v.url, 'sitemap endpoint variant'));
    out.matrix.push(classifySitemapRow(v.url, v.role, f));
  }
  return out;
}

/** llms.txt: one fetch on the observed origin. Optional and unscored. */
export async function probeLlmsTxt(acq: Acquirer, audit: Audit): Promise<Audit['site']['llms_txt']> {
  const origin = audit.target.preferred_origin;
  if (!origin) return { url: null, state: 'NOT_FETCHED', status: null, excerpt: null, note: 'No reachable origin was established.' };
  const url = `${origin}/llms.txt`;
  if (acq.ctx.blocked()) return { url, state: 'NOT_FETCHED', status: null, excerpt: null, note: `Not fetched: ${acq.ctx.blocked()}` };
  const f = await controlFetch(acq, url, 'llms.txt', 65536);
  const r = f.res.record;
  if (r.acquisition !== 'OK') return { url, state: 'UNAVAILABLE', status: null, excerpt: null, note: `No response (${r.acquisition}).` };
  if (f.challenge) return { url, state: 'CHALLENGE', status: r.status, excerpt: null, note: 'An access challenge was returned to this auditor.' };
  if (r.status === 404 || r.status === 410) return { url, state: 'ABSENT', status: r.status, excerpt: null, note: `No llms.txt (HTTP ${r.status}). This optional file is not required by Google or any documented vendor crawler.` };
  if (r.status === 200 && f.htmlLike) return { url, state: 'HTML_FALLBACK', status: 200, excerpt: truncate(f.res.text ?? '', 160), note: 'HTTP 200 with an HTML document; this is a fallback page, not an llms.txt file.' };
  if (r.status === 200 && (f.res.text ?? '').trim()) {
    const text = f.res.text ?? '';
    const hasH1 = /^#\s+\S/m.test(text);
    return { url, state: 'PRESENT_TEXT', status: 200, excerpt: truncate(text, 300), note: `Readable text file present${hasH1 ? ' and it starts with a markdown H1 title as the proposal describes' : '; no markdown H1 title was found (the proposal expects one)'}. Presence does not show that any AI service uses it.` };
  }
  return { url, state: 'UNAVAILABLE', status: r.status, excerpt: null, note: `HTTP ${r.status}; not interpretable as an llms.txt response.` };
}
