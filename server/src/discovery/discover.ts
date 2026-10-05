import crypto from 'node:crypto';
import type { Acquirer } from '../net/acquire';
import type { Audit, AuditConfig, Candidate, LinkObs, PageType } from '../types';
import { extractPage } from '../extract/html';
import { apexWwwPair, fetchKey, isAliasHost, registrableDomain } from '../util/url';
import { buildSignatures, classifyPage, compareCandidates, exclusionReason, FALLBACK_PROBE_PATHS, isSectionHub, SELECTION_PLAN, TYPE_PRIORITY } from './grouping';

export interface SelectedPage {
  url: string;
  page_type: PageType;
  selection_reason: string;
  discovered_from: string | null;
  observed_group: string;
  operator_override: string | null;
}

export interface DiscoveryOutput {
  target: Audit['target'];
  discovery: Audit['discovery'];
  selected: SelectedPage[];
  homepageUrl: string | null;
}

export function urlHash(url: string): string {
  return crypto.createHash('sha1').update(fetchKey(url)).digest('hex').slice(0, 10);
}

const ZONE_RANK: Record<LinkObs['zone'], number> = { nav: 0, main: 1, footer: 2, other: 3 };

/**
 * Bounded, deterministic discovery: homepage RAW + RENDERED links, observed section hubs to depth 2,
 * a fixed-path fallback, then one page per observed group. Sitemap contents, search indexes and Common Crawl
 * are never used for sampling.
 */
export async function discover(
  acq: Acquirer,
  inputRaw: string,
  input: URL,
  config: AuditConfig,
  progress: (detail: string) => void = () => undefined,
): Promise<DiscoveryOutput> {
  const ctx = acq.ctx;
  const b = ctx.budgets;
  const limitations: string[] = [];
  const documents: Audit['discovery']['documents'] = [];
  const candidates = new Map<string, Candidate>();
  const schemeAssumed = !/^https?:\/\//i.test(inputRaw.trim());
  if (input.port) ctx.guard.authorisePort(Number(input.port));

  // ---- 1. Establish the origin from observed behaviour -------------------------------------------------
  progress('Fetching robots.txt');
  let origin = input.origin;
  await acq.robots.load(origin);
  progress('Resolving the preferred origin');
  let homeRaw = await acq.raw(`${origin}/`, 'homepage', `raw-${urlHash(`${origin}/`)}.html`);
  let originNote = '';
  if (schemeAssumed && homeRaw.record.acquisition !== 'OK' && ['TLS_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(homeRaw.record.acquisition)) {
    const httpOrigin = origin.replace(/^https:/, 'http:');
    await acq.robots.load(httpOrigin);
    const viaHttp = await acq.raw(`${httpOrigin}/`, 'homepage (http fallback)', `raw-${urlHash(`${httpOrigin}/`)}.html`);
    if (viaHttp.record.acquisition === 'OK') {
      originNote = `HTTPS was not reachable for this auditor (${homeRaw.record.acquisition}); the site answered over HTTP. `;
      homeRaw = viaHttp;
      origin = httpOrigin;
    }
  }
  ctx.counters.discovery_documents++;
  const homeFinal = homeRaw.record.acquisition === 'OK' && homeRaw.record.final_url ? homeRaw.record.final_url : null;
  let preferredOrigin: string | null = null;
  let homepageUrl: string | null = null;
  if (homeFinal) {
    preferredOrigin = new URL(homeFinal).origin;
    homepageUrl = homeFinal;
    const finalHost = new URL(homeFinal).hostname;
    if (preferredOrigin !== origin) {
      originNote += isAliasHost(finalHost, input.hostname)
        ? `The server redirects ${origin} to ${preferredOrigin}; the redirect target is used as the preferred origin.`
        : `The homepage redirects to a different host (${finalHost}); that observed host is used as the website host for this audit.`;
      await acq.robots.load(preferredOrigin);
    } else originNote += 'The supplied origin answered directly; no preferred-origin redirect was observed.';
  } else {
    originNote += `The homepage could not be retrieved (${homeRaw.record.acquisition}${homeRaw.record.error ? `: ${homeRaw.record.error}` : ''}). No preferred origin is asserted.`;
  }
  const siteHost = new URL(preferredOrigin ?? origin).hostname;
  const inScope = (host: string) => isAliasHost(host, siteHost);

  const target: Audit['target'] = {
    input_url: inputRaw.trim(),
    normalized_url: fetchKey(input),
    host: siteHost,
    registrable_domain: registrableDomain(siteHost),
    preferred_origin: preferredOrigin,
    origin_resolution: homeRaw.record.hops,
    origin_note: originNote.trim(),
  };

  documents.push({ url: `${origin}/`, depth: 0, profile: 'RAW', status: homeRaw.record.status, links: 0, note: homeRaw.record.acquisition === 'OK' ? homeRaw.record.validity : homeRaw.record.acquisition });

  const robotsFor = (url: string) => acq.robots.peek(new URL(url).origin);
  const addLinks = (links: LinkObs[], from: string, depth: number, profile: 'RAW' | 'RENDERED') => {
    const usable = links
      .filter((l) => l.crawlable && l.url && l.internal && inScope(new URL(l.url).hostname))
      .sort((x, y) => ZONE_RANK[x.zone] - ZONE_RANK[y.zone]);
    if (usable.length > b.max_links_per_document) {
      limitations.push(`${from} exposed ${usable.length} internal links in ${profile}; only the first ${b.max_links_per_document} (navigation and main content first) were considered.`);
    }
    for (const l of usable.slice(0, b.max_links_per_document)) {
      const url = l.url as string;
      if (homepageUrl && fetchKey(url) === fetchKey(homepageUrl)) continue;
      const u = new URL(url);
      if (u.pathname === '/' && !u.search) continue;
      let c = candidates.get(url);
      if (!c) {
        const rs = robotsFor(url);
        c = {
          url, text: l.text, zone: l.zone, discovered_from: from, depth, in_raw: false, in_rendered: false, crawlable: true,
          page_type: classifyPage(url, l.text), group: '', excluded_reason: exclusionReason(url),
          robots_auditor: acq.robots.decideWith(rs, ctx.cfg.auditor.token, url).decision,
          robots_googlebot: acq.robots.decideWith(rs, 'Googlebot', url).decision,
          verification: 'unverified', verification_note: null, selected: false, selection_reason: null,
        };
        candidates.set(url, c);
      } else {
        if (ZONE_RANK[l.zone] < ZONE_RANK[c.zone]) c.zone = l.zone;
        if (!c.text && l.text) c.text = l.text;
      }
      if (profile === 'RAW') c.in_raw = true;
      else c.in_rendered = true;
    }
    return usable.length;
  };

  // ---- 2. Harvest real links from the homepage (RAW and RENDERED) ---------------------------------------
  let homeRawLinks = 0;
  let localeEvidence = new Set<string>();
  if (homepageUrl && homeRaw.record.validity === 'VALID_PAGE' && homeRaw.text) {
    const ex = extractPage(homeRaw.text, homepageUrl, homeRaw.record.headers);
    homeRawLinks = addLinks(ex.links, homepageUrl, 1, 'RAW');
    documents[0].links = homeRawLinks;
    for (const h of ex.hreflang) {
      const seg = (() => {
        try {
          return new URL(h.href).pathname.split('/').filter(Boolean)[0]?.toLowerCase();
        } catch {
          return undefined;
        }
      })();
      if (seg && /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(seg) && h.hreflang.toLowerCase().startsWith(seg.slice(0, 2))) localeEvidence.add(seg);
    }
  }
  if (homepageUrl && !ctx.blocked()) {
    progress('Rendering the homepage');
    const rendered = await acq.render(homepageUrl, `r-${urlHash(homepageUrl)}`);
    let n = 0;
    if (rendered.dom && rendered.record.validity === 'VALID_PAGE') {
      n = addLinks(extractPage(rendered.dom, rendered.record.final_url ?? homepageUrl, rendered.record.headers).links, homepageUrl, 1, 'RENDERED');
    }
    documents.push({ url: homepageUrl, depth: 0, profile: 'RENDERED', status: rendered.record.status, links: n, note: rendered.record.acquisition === 'OK' ? rendered.record.validity : rendered.record.acquisition });
  }

  // ---- 3. Expand observed section hubs just enough to find representative detail pages -------------------
  const docBudgetLeft = () => b.max_discovery_documents - ctx.counters.discovery_documents;
  if (b.max_discovery_depth >= 2) {
    const hubs = [...candidates.values()]
      .filter((c) => !c.excluded_reason && c.robots_auditor === 'ALLOW' && isSectionHub(c.url, c.page_type) && c.zone !== 'footer')
      .sort(compareCandidates)
      .slice(0, 8);
    let hubRenders = 0;
    for (const hub of hubs) {
      if (docBudgetLeft() <= 6 || ctx.blocked()) {
        if (docBudgetLeft() <= 6) limitations.push('The discovery-document budget was nearly used; remaining section hubs were not expanded.');
        break;
      }
      progress(`Reading section hub ${new URL(hub.url).pathname}`);
      ctx.counters.discovery_documents++;
      const res = await acq.raw(hub.url, 'section hub', `raw-${urlHash(hub.url)}.html`);
      let n = 0;
      const finalUrl = res.record.final_url ?? hub.url;
      if (res.record.acquisition === 'OK' && res.record.validity === 'VALID_PAGE' && res.text && inScope(new URL(finalUrl).hostname)) {
        n = addLinks(extractPage(res.text, finalUrl, res.record.headers).links, hub.url, 2, 'RAW');
      }
      documents.push({ url: hub.url, depth: 1, profile: 'RAW', status: res.record.status, links: n, note: res.record.acquisition === 'OK' ? res.record.validity : res.record.acquisition });
      // A hub whose RAW document exposes almost no links may build them with JavaScript; render a few such hubs.
      if (n < 3 && hubRenders < 3 && res.record.acquisition === 'OK' && !ctx.blocked()) {
        hubRenders++;
        const rr = await acq.render(finalUrl, `r-${urlHash(finalUrl)}`);
        let rn = 0;
        if (rr.dom && rr.record.validity === 'VALID_PAGE') rn = addLinks(extractPage(rr.dom, rr.record.final_url ?? finalUrl, rr.record.headers).links, hub.url, 2, 'RENDERED');
        documents.push({ url: hub.url, depth: 1, profile: 'RENDERED', status: rr.record.status, links: rn, note: rr.record.acquisition === 'OK' ? rr.record.validity : rr.record.acquisition });
      }
    }
  }

  // ---- 4. Fixed-path fallback only when discovery found fewer than four usable candidates ----------------
  const usableCount = () => [...candidates.values()].filter((c) => !c.excluded_reason && c.robots_auditor === 'ALLOW').length;
  if (preferredOrigin && usableCount() < 4) {
    for (const p of FALLBACK_PROBE_PATHS) {
      if (docBudgetLeft() <= 0 || ctx.blocked()) break;
      const url = `${preferredOrigin}${p}`;
      if (candidates.has(url)) continue;
      const rs = robotsFor(url);
      if (acq.robots.decideWith(rs, ctx.cfg.auditor.token, url).decision !== 'ALLOW') continue;
      ctx.counters.discovery_documents++;
      const res = await acq.raw(url, 'fixed-path probe', `raw-${urlHash(url)}.html`);
      const ok = res.record.acquisition === 'OK' && res.record.status === 200 && res.record.validity === 'VALID_PAGE';
      documents.push({ url, depth: 1, profile: 'RAW', status: res.record.status, links: 0, note: ok ? 'fixed-path probe: genuine page' : `fixed-path probe: ${res.record.acquisition === 'OK' ? res.record.validity : res.record.acquisition}` });
      if (!ok) continue;
      const finalUrl = res.record.final_url ?? url;
      if (homepageUrl && fetchKey(finalUrl) === fetchKey(homepageUrl)) continue;
      if (candidates.has(finalUrl)) continue;
      candidates.set(finalUrl, {
        url: finalUrl, text: '', zone: 'other', discovered_from: 'fixed-path probe', depth: 1, in_raw: false, in_rendered: false, crawlable: true,
        page_type: classifyPage(finalUrl), group: '', excluded_reason: exclusionReason(finalUrl),
        robots_auditor: 'ALLOW', robots_googlebot: acq.robots.decideWith(robotsFor(finalUrl), 'Googlebot', finalUrl).decision,
        verification: 'verified', verification_note: 'Verified by the fixed-path probe (HTTP 200, genuine page).', selected: false, selection_reason: null,
      });
    }
  }
  if (docBudgetLeft() <= 0) limitations.push(`Discovery stopped at the ${b.max_discovery_documents}-document budget.`);

  // ---- 5. Cap repeated query variants per path, then group by path signature -----------------------------
  const perPath = new Map<string, number>();
  for (const c of [...candidates.values()].sort(compareCandidates)) {
    const u = new URL(c.url);
    if (!u.search) continue;
    const k = u.origin + u.pathname;
    const n = (perPath.get(k) ?? 0) + 1;
    perPath.set(k, n);
    if (n > b.max_query_variants_per_path && !c.excluded_reason) c.excluded_reason = `more than ${b.max_query_variants_per_path} query variants of the same path (crawl-trap cap)`;
  }
  const operatorUrls = config.operator_urls.map((u) => fetchKey(u));
  const allUrls = [...candidates.keys(), ...(homepageUrl ? [homepageUrl] : []), ...operatorUrls, fetchKey(input)];
  const sigs = buildSignatures([...new Set(allUrls)], localeEvidence);
  for (const c of candidates.values()) c.group = sigs.get(c.url) ?? new URL(c.url).pathname;
  const groupMap = new Map<string, string[]>();
  for (const c of candidates.values()) {
    if (!groupMap.has(c.group)) groupMap.set(c.group, []);
    groupMap.get(c.group)!.push(c.url);
  }
  const groups = [...groupMap.entries()].map(([signature, urls]) => ({ signature, count: urls.length, examples: urls.sort().slice(0, 3) })).sort((x, y) => (x.signature < y.signature ? -1 : 1));

  // ---- 6. Select up to N pages: homepage, supplied URLs, then one page per observed group ----------------
  const max = Math.max(1, Math.min(b.max_selected_pages, config.sample_size));
  const selected: SelectedPage[] = [];
  const usedGroups = new Map<string, number>();
  const has = (url: string) => selected.some((s) => fetchKey(s.url) === fetchKey(url));
  const push = (p: SelectedPage) => {
    if (selected.length >= max || has(p.url)) return false;
    selected.push(p);
    usedGroups.set(p.observed_group, (usedGroups.get(p.observed_group) ?? 0) + 1);
    return true;
  };

  // A supplied deep URL is always kept, even when broken or restricted, so the operator gets a diagnostic row.
  const supplied: string[] = [];
  const inputKey = fetchKey(input);
  const inputIsDeep = input.pathname !== '/' || !!input.search;
  if (inputIsDeep) supplied.push(inputKey);
  for (const u of operatorUrls) if (!supplied.includes(u)) supplied.push(u);

  if (homepageUrl) {
    push({ url: homepageUrl, page_type: 'homepage', selection_reason: 'Homepage (observed preferred origin)', discovered_from: null, observed_group: sigs.get(homepageUrl) ?? '/', operator_override: null });
  } else if (!inputIsDeep) {
    push({ url: `${origin}/`, page_type: 'homepage', selection_reason: 'Homepage as supplied; it could not be retrieved, so this row is diagnostic', discovered_from: null, observed_group: '/', operator_override: null });
  }
  for (const u of supplied) {
    const type = classifyPage(u);
    push({ url: u, page_type: type === 'homepage' ? 'homepage' : type, selection_reason: u === inputKey ? 'Deep URL supplied as the audit target' : 'Page supplied by the operator', discovered_from: null, observed_group: sigs.get(u) ?? new URL(u).pathname, operator_override: 'operator-supplied' });
    const c = candidates.get(u);
    if (c) (c.selected = true), (c.selection_reason = 'operator-supplied');
  }
  if (supplied.length + (homepageUrl ? 1 : 0) > max) limitations.push(`More pages were supplied than the ${max}-page sample allows; the extra URLs were not audited.`);

  const verify = async (c: Candidate): Promise<string | null> => {
    if (c.verification === 'verified') return c.url;
    if (c.verification === 'failed' || c.verification === 'alias') return null;
    if (docBudgetLeft() <= 0 || ctx.blocked()) {
      c.verification_note = 'Not verified: discovery budget or run stop condition reached.';
      return null;
    }
    const res = await acq.raw(c.url, 'candidate verification', `raw-${urlHash(c.url)}.html`);
    const r = res.record;
    if (r.acquisition === 'OK' && r.validity === 'ACCESS_CHALLENGE') {
      // RAW is challenged for this auditor; rendering may still return the genuine page, so the page stays eligible.
      c.verification = 'verified';
      c.verification_note = 'RAW returned an access challenge to this auditor; kept so the rendered profile can be tested.';
      return c.url;
    }
    if (r.acquisition !== 'OK' || r.status !== 200 || r.validity !== 'VALID_PAGE') {
      c.verification = 'failed';
      c.verification_note = `Not a verified genuine page: ${r.acquisition !== 'OK' ? r.acquisition : `HTTP ${r.status}, ${r.validity}`}.`;
      ctx.counters.discovery_documents++;
      return null;
    }
    const finalUrl = r.final_url ?? c.url;
    if (fetchKey(finalUrl) !== fetchKey(c.url)) {
      if (!inScope(new URL(finalUrl).hostname)) {
        c.verification = 'failed';
        c.verification_note = `Redirects outside the audited host (${new URL(finalUrl).hostname}).`;
        ctx.counters.discovery_documents++;
        return null;
      }
      if (has(finalUrl) || (homepageUrl && fetchKey(finalUrl) === fetchKey(homepageUrl))) {
        c.verification = 'alias';
        c.verification_note = `Redirect alias of ${finalUrl}, which is already in the sample.`;
        return null;
      }
      c.verification = 'verified';
      c.verification_note = `Linked as ${c.url}; the server redirects it to ${finalUrl}, which is the audited URL.`;
      return finalUrl;
    }
    c.verification = 'verified';
    c.verification_note = 'HTTP 200, genuine page in RAW.';
    return c.url;
  };

  const eligible = () => [...candidates.values()].filter((c) => !c.selected && !c.excluded_reason && c.robots_auditor === 'ALLOW' && c.verification !== 'failed' && c.verification !== 'alias').sort(compareCandidates);
  const take = async (pool: Candidate[], reason: string): Promise<boolean> => {
    for (const c of pool) {
      if (selected.length >= max) return false;
      const finalUrl = await verify(c);
      if (!finalUrl) continue;
      c.selected = true;
      c.selection_reason = reason;
      const added = push({
        url: finalUrl, page_type: c.page_type, selection_reason: finalUrl === c.url ? reason : `${reason} (linked as ${new URL(c.url).pathname}, redirects here)`,
        discovered_from: c.discovered_from, observed_group: c.group, operator_override: null,
      });
      if (added) return true;
    }
    return false;
  };

  progress('Selecting representative pages');
  for (const step of SELECTION_PLAN) {
    if (selected.length >= max) break;
    const pool = eligible().filter((c) => c.page_type === step.type && !usedGroups.has(c.group));
    await take(pool, step.reason);
  }
  // Remaining slots: other distinct observed groups first, then at most a second page from an already used group.
  while (selected.length < max) {
    const pool = eligible().filter((c) => !usedGroups.has(c.group)).sort((x, y) => TYPE_PRIORITY.indexOf(x.page_type) - TYPE_PRIORITY.indexOf(y.page_type) || compareCandidates(x, y));
    if (!pool.length || !(await take(pool, 'Additional distinct observed page group'))) break;
  }
  while (selected.length < max) {
    const pool = eligible().filter((c) => (usedGroups.get(c.group) ?? 0) === 1 && c.page_type !== 'other' && c.page_type !== 'contact');
    if (!pool.length || !(await take(pool, 'Second page from an observed group (all distinct groups already sampled)'))) break;
  }

  const blockedForGoogle = [...candidates.values()].filter((c) => c.robots_googlebot === 'DISALLOW' && !c.excluded_reason);
  if (blockedForGoogle.length) {
    limitations.push(`${blockedForGoogle.length} discovered public candidate URL(s) are disallowed for Googlebot in robots.txt; they are reported as crawl-access findings and were not sampled for content.`);
  }
  const blockedForAuditor = [...candidates.values()].filter((c) => c.robots_auditor !== 'ALLOW');
  if (blockedForAuditor.length) limitations.push(`${blockedForAuditor.length} discovered URL(s) were not fetched because robots.txt does not allow this auditor (or access is unknown).`);
  limitations.push('Sampling used links observed on the homepage and section hubs only. Sitemap contents, search-engine indexes and Common Crawl were not used.');
  const pair = apexWwwPair(siteHost);
  if (!pair) limitations.push(`Discovery was limited to the host ${siteHost}; other subdomains are included only when supplied.`);

  return {
    target,
    homepageUrl,
    selected,
    discovery: {
      documents_fetched: ctx.counters.discovery_documents,
      documents,
      candidates: [...candidates.values()].sort(compareCandidates),
      groups,
      limitations,
      used_sitemap_for_sampling: false,
    },
  };
}
