import type { Env, PageWork } from './engine';
import { bestExtract, contentGate, rawValid, renValid } from './engine';
import { exclusionReason } from '../discovery/grouping';
import { assessValidity } from '../validity/validity';
import { fetchKey, truncate } from '../util/url';
import type { Finding } from '../types';

export async function checkOnPage(env: Env, p: PageWork) {
  const { rec } = env;
  const id = p.rec.page_id;
  const gate = contentGate(p);
  const skip = (cid: string) => (gate!.status === 'NOT_APPLICABLE' ? rec.na(cid, id, gate!.reason) : rec.untestable(cid, id, gate!.reason));
  const raw = rawValid(p) ? p.rec.raw_extract : null;
  const ren = renValid(p) ? p.rec.rendered_extract : null;
  const best = bestExtract(p);

  // O-2.1 Title -------------------------------------------------------------------------------------------------
  await rec.guard('O-2.1', id, () => {
    if (gate || !best) return skip('O-2.1');
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'head > title', observed: `RAW: ${raw ? JSON.stringify(raw.title) : 'n/a'} | RENDERED: ${ren ? JSON.stringify(ren.title) : 'n/a'}`, expected: 'a non-empty <title>' });
    const findings: Finding[] = [];
    const notes: string[] = [];
    if (!best.ex.title) {
      findings.push(rec.finding({
        check_id: 'O-2.1', status: 'FAIL', reason_code: 'TITLE_MISSING', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'Missing or empty title element', explanation: `No non-empty <title> was found in the ${best.profile} document.`,
        impact: 'Google has to generate a title link from other page content, and the page gives no explicit statement of its subject.', action: 'Add a concise, descriptive <title> unique to this page.', owner: 'Content / developer', effort: 'S',
      }));
    } else {
      if (raw && ren && raw.title !== ren.title) notes.push(raw.title ? 'The title differs between the server HTML and the rendered page (JavaScript rewrites it).' : 'The title exists only after rendering; the server HTML has none.');
      if (best.ex.titles.filter(Boolean).length > 1) notes.push(`${best.ex.titles.filter(Boolean).length} title elements are present; browsers and crawlers use the first.`);
      const len = best.ex.title.length;
      if (len > 70 || len < 15) notes.push(`Title length is ${len} characters. Advisory only (Wellows tool policy): there is no Google character limit; long titles may be shortened in results.`);
    }
    rec.result({ check_id: 'O-2.1', page_id: id, evidence: [ev], findings, notes });
  });

  // O-2.2 Meta description ---------------------------------------------------------------------------------------
  await rec.guard('O-2.2', id, () => {
    if (gate || !best) return skip('O-2.2');
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'meta[name=description]', observed: `RAW: ${raw ? JSON.stringify(raw.meta_description) : 'n/a'} | RENDERED: ${ren ? JSON.stringify(ren.meta_description) : 'n/a'}` });
    const findings: Finding[] = [];
    if (!best.ex.meta_description) {
      findings.push(rec.finding({
        check_id: 'O-2.2', status: 'WARN', reason_code: 'META_DESCRIPTION_MISSING', severity: 'LOW', pages: [id], evidence: [ev], classification: 'OPPORTUNITY',
        title: 'No meta description', explanation: 'The page has no meta description. This is not an indexing problem: Google primarily builds snippets from page content and may use the meta description when it describes the page better.',
        impact: 'The site has less influence over the snippet shown in results.', action: 'Add a one- to two-sentence description that summarises this specific page.', owner: 'Content', effort: 'S',
      }));
    }
    rec.result({ check_id: 'O-2.2', page_id: id, evidence: [ev], findings });
  });

  // O-2.3 H1 ---------------------------------------------------------------------------------------------------------
  await rec.guard('O-2.3', id, () => {
    if (gate || !best) return skip('O-2.3');
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'h1', observed: best.ex.h1.length ? best.ex.h1.map((h) => JSON.stringify(h)).join(', ') : '(no visible h1)' });
    const findings: Finding[] = [];
    const notes: string[] = [];
    if (!best.ex.h1.length) {
      findings.push(rec.finding({
        check_id: 'O-2.3', status: 'WARN', reason_code: 'H1_MISSING', severity: 'LOW', pages: [id], evidence: [ev], classification: 'OPPORTUNITY', sources: ['SRC-W3C-STRUCT', 'SRC-TOOL-POLICY'],
        title: 'No main heading (H1)', explanation: 'No visible H1 was found. This is not a Google violation and does not prevent indexing; a clear main heading helps people, assistive technology and machines identify the page subject.',
        impact: 'The page subject is less explicit.', action: 'Add one descriptive H1 that states what the page is about.', owner: 'Content / developer', effort: 'S',
      }));
    } else if (best.ex.h1.length > 1) notes.push(`${best.ex.h1.length} H1 elements are present. Multiple H1s are valid and are not treated as a problem.`);
    rec.result({ check_id: 'O-2.3', page_id: id, evidence: [ev], findings, notes });
  });

  // O-2.5 Page-level internal links -----------------------------------------------------------------------------------
  await rec.guard('O-2.5', id, () => {
    if (gate || !best) return skip('O-2.5');
    const self = fetchKey(best.url);
    const internal = best.ex.links.filter((l) => l.crawlable && l.internal && l.url && fetchKey(l.url) !== self);
    const unique = new Set(internal.map((l) => l.url));
    const empty = best.ex.links.filter((l) => l.reason === 'empty href').length;
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'a[href]', observed: `${unique.size} unique crawlable internal link target(s); ${best.ex.links.filter((l) => !l.crawlable).length} non-crawlable anchors (${empty} with an empty href); examples: ${[...unique].slice(0, 4).join(', ') || 'none'}`, expected: 'navigation built from <a href> elements' });
    const findings: Finding[] = [];
    const notes: string[] = [];
    if (best.ex.nav_like_controls.length) {
      const c = best.ex.nav_like_controls;
      const ev2 = rec.ev({ url: best.url, profile: best.profile, locator: 'navigation control without <a href>', observed: c.slice(0, 5).map((x) => `"${x.text}" -> ${x.hint} :: ${x.html}`).join(' || '), expected: '<a href="..."> for each destination' });
      findings.push(rec.finding({
        check_id: 'O-2.5', status: 'WARN', reason_code: 'NAVIGATION_WITHOUT_HREF', severity: 'MEDIUM', pages: [id], evidence: [ev, ev2],
        title: 'Navigation implemented without crawlable links', explanation: `${c.length} control(s) navigate to an internal URL through a script or data attribute, and no <a href> on the page points to the same destination. Google follows links only from <a> elements with an href.`,
        impact: 'Crawlers may not discover the destination pages from this page.', action: 'Render these controls as <a href="..."> elements (styling and click handlers can stay).', owner: 'Developer', effort: 'S',
      }));
    }
    if (!unique.size && !best.ex.nav_like_controls.length) {
      findings.push(rec.finding({
        check_id: 'O-2.5', status: 'WARN', reason_code: 'NO_CRAWLABLE_INTERNAL_LINKS', severity: 'LOW', pages: [id], evidence: [ev],
        title: 'No crawlable internal links on this page', explanation: `The ${best.profile} document contains no <a href> link to another page on this site.`,
        impact: 'Crawlers cannot move from this page to the rest of the site. Nothing is inferred about the rest of the site from this one page.', action: 'Link to the main sections of the site with standard anchors.', owner: 'Developer', effort: 'S',
      }));
    }
    if (raw && ren) {
      const rawSet = new Set(raw.links.filter((l) => l.crawlable && l.internal).map((l) => l.url));
      const jsOnly = [...unique].filter((u) => !rawSet.has(u)).length;
      if (jsOnly) notes.push(`${jsOnly} internal link target(s) exist only after rendering. JavaScript-inserted anchors are crawlable once rendered; the dependency is assessed under AI Access (A-5.2).`);
    }
    if (best.ex.base_href) notes.push(`Links resolve against <base href="${truncate(best.ex.base_href, 80)}">.`);
    rec.result({ check_id: 'O-2.5', page_id: id, evidence: [ev], findings, notes });
  });
}

/** O-2.4: exact duplication, scoped to the evaluated sample with its denominator. */
export async function checkDuplicates(env: Env) {
  const { rec, pages } = env;
  await rec.guard('O-2.4', null, () => {
    const items = pages.map((p) => ({ p, best: bestExtract(p) })).filter((x) => x.best);
    if (items.length < 2) return rec.na('O-2.4', null, `Duplication needs at least two valid pages; ${items.length} was evaluated.`);
    const findings: Finding[] = [];
    const evs: string[] = [];
    for (const field of ['title', 'meta_description'] as const) {
      const map = new Map<string, PageWork[]>();
      for (const it of items) {
        const v = it.best!.ex[field];
        if (!v) continue;
        if (!map.has(v)) map.set(v, []);
        map.get(v)!.push(it.p);
      }
      for (const [value, ps] of map) {
        if (ps.length < 2) continue;
        const ev = rec.ev({ url: ps[0].rec.url, profile: 'NONE', locator: field === 'title' ? 'head > title across sample' : 'meta description across sample', observed: `"${truncate(value, 160)}" on ${ps.length} of ${items.length} evaluated pages: ${ps.map((x) => x.rec.url).join(', ')}`, expected: 'a distinct value per page' });
        evs.push(ev);
        findings.push(rec.finding({
          check_id: 'O-2.4', status: 'WARN', reason_code: field === 'title' ? 'DUPLICATE_TITLE_IN_SAMPLE' : 'DUPLICATE_DESCRIPTION_IN_SAMPLE', severity: 'LOW', pages: ps.map((x) => x.rec.page_id), evidence: [ev],
          title: field === 'title' ? 'Identical title on several sampled pages' : 'Identical meta description on several sampled pages',
          explanation: `${ps.length} of the ${items.length} evaluated pages share exactly the same ${field === 'title' ? 'title' : 'meta description'}. This count covers the sample only and is not a site-wide figure.`,
          impact: 'Pages are harder to tell apart in search results.', action: `Write a distinct ${field === 'title' ? 'title' : 'description'} for each of these pages.`, owner: 'Content', effort: 'S',
        }));
      }
    }
    if (!findings.length) evs.push(rec.ev({ url: items[0].p.rec.url, profile: 'NONE', locator: 'titles and descriptions across sample', observed: `No exact duplicates among ${items.length} evaluated pages.` }));
    rec.result({ check_id: 'O-2.4', evidence: evs, findings, notes: [`Evaluated denominator: ${items.length} valid sampled page(s).`] });
  });
}

/** O-2.6: validate a bounded set of internal link targets. No orphan or link-distribution claims. */
export async function checkLinkTargets(env: Env) {
  const { rec, pages, acq } = env;
  await rec.guard('O-2.6', null, async () => {
    const cap = acq.ctx.budgets.max_internal_link_targets;
    const sampleUrls = new Set(pages.map((p) => fetchKey(p.rec.url)));
    const seen = new Map<string, { url: string; nav: boolean; count: number; from: Set<string>; text: string }>();
    for (const p of pages) {
      const best = bestExtract(p);
      if (!best) continue;
      for (const l of best.ex.links) {
        if (!l.crawlable || !l.internal || !l.url) continue;
        const why = exclusionReason(l.url);
        if (why && !/legal/.test(why)) continue; // never test login/cart/search or file downloads
        let e = seen.get(l.url);
        if (!e) seen.set(l.url, (e = { url: l.url, nav: false, count: 0, from: new Set(), text: l.text }));
        e.count++;
        e.nav = e.nav || l.zone === 'nav';
        e.from.add(p.rec.page_id);
      }
    }
    if (!seen.size) return rec.na('O-2.6', null, 'No valid sampled page exposed crawlable internal links to test.');
    const ordered = [...seen.values()].sort((a, b) => Number(sampleUrls.has(fetchKey(b.url))) - Number(sampleUrls.has(fetchKey(a.url))) || Number(b.nav) - Number(a.nav) || b.count - a.count || (a.url < b.url ? -1 : 1));
    const targets = ordered.slice(0, cap);
    const limitations: string[] = [];
    if (ordered.length > cap) limitations.push(`${ordered.length} unique internal link targets were observed; ${cap} were tested (sampled pages, navigation, then most frequent).`);
    const broken: typeof targets = [];
    const redirected: { t: (typeof targets)[number]; to: string }[] = [];
    const evs: string[] = [];
    let tested = 0;
    for (const t of targets) {
      if (acq.ctx.blocked()) {
        limitations.push(`Link testing stopped early: ${acq.ctx.blocked()}.`);
        break;
      }
      const res = await acq.ctx.fetchRaw(t.url, { purpose: 'internal link target', gate: (u) => acq.robots.auditorMayFetch(u), maxBytes: 262144 });
      acq.ctx.counters.internal_link_targets++;
      const r = res.record;
      if (r.acquisition !== 'OK') {
        limitations.push(`${t.url}: not testable (${r.acquisition}).`);
        continue;
      }
      const v = r.validity ?? assessValidity({ status: r.status, headers: r.headers, html: res.text, bodyComplete: true, truncatedReason: null, contentType: r.content_type, expectHtml: false }).validity;
      if (v === 'ACCESS_CHALLENGE' || r.status === 429) {
        limitations.push(`${t.url}: access challenge or rate limit for this auditor; not counted as broken.`);
        continue;
      }
      tested++;
      const s = r.status ?? 0;
      if (s === 404 || s === 410 || s >= 500) {
        broken.push(t);
        evs.push(rec.ev({ url: t.url, profile: 'RAW', locator: `internal link target ("${t.text}")`, observed: `HTTP ${s}; linked from ${[...t.from].join(', ')}`, expected: 'HTTP 200', at: r.fetched_at }));
      } else if (r.hops.length && s === 200) redirected.push({ t, to: r.final_url ?? '' });
    }
    const findings: Finding[] = [];
    if (broken.length) {
      findings.push(rec.finding({
        check_id: 'O-2.6', status: 'FAIL', reason_code: 'BROKEN_INTERNAL_LINK_TARGET', severity: 'MEDIUM', pages: [...new Set(broken.flatMap((b) => [...b.from]))], evidence: evs,
        title: `${broken.length} tested internal link(s) lead to an error page`, explanation: `Of ${tested} internal link targets tested, ${broken.length} returned 404/410/5xx: ${broken.map((b) => b.url).join(', ')}.`,
        impact: 'Visitors and crawlers following these links reach a dead end.', action: 'Update each link to the correct URL or redirect the old URL to its replacement.', owner: 'Content / developer', effort: 'S',
      }));
    }
    if (redirected.length) {
      const ev = rec.ev({ url: redirected[0].t.url, profile: 'RAW', locator: 'internal link targets that redirect', observed: redirected.slice(0, 8).map((r) => `${r.t.url} -> ${r.to}`).join(' ; ') });
      evs.push(ev);
      findings.push(rec.finding({
        check_id: 'O-2.6', status: 'WARN', reason_code: 'INTERNAL_LINK_REDIRECTS', severity: 'LOW', pages: [...new Set(redirected.flatMap((r) => [...r.t.from]))], evidence: [ev], classification: 'OPPORTUNITY',
        title: `${redirected.length} tested internal link(s) point to redirecting URLs`, explanation: 'These links work, but each passes through a redirect before reaching the page.',
        impact: 'A small efficiency cost for visitors and crawlers.', action: 'Link directly to the final URLs.', owner: 'Content / developer', effort: 'S',
      }));
    }
    if (!tested) return rec.untestable('O-2.6', null, `No internal link target could be tested. ${limitations.join(' ')}`);
    if (!findings.length) evs.push(rec.ev({ url: pages[0].rec.url, profile: 'RAW', locator: 'internal link targets', observed: `${tested} tested target(s) returned HTTP 200 without redirect.` }));
    rec.result({ check_id: 'O-2.6', evidence: evs, findings, limitations, notes: [`${tested} unique internal targets tested. No orphan-page or site-wide link-distribution conclusion is drawn from this sample.`] });
  });
}
