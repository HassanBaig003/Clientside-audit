import type { Env, PageWork } from './engine';
import { bestExtract, contentGate } from './engine';
import { extractPage, resolveCanonical } from '../extract/html';
import { sameUrl } from '../util/url';
import type { Finding, HreflangObs } from '../types';

const langNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** hreflang value: x-default, or ISO 639-1 language with optional script and ISO 3166-1 alpha-2 region. */
export function hreflangProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return 'empty value';
  if (v.toLowerCase() === 'x-default') return null;
  const m = /^([A-Za-z]{2})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}))?$/.exec(v);
  if (!m) return 'not in language[-script][-region] form (a region cannot be used on its own)';
  let known = false;
  try {
    known = !!langNames.of(m[1].toLowerCase());
  } catch {
    known = false;
  }
  if (!known) return `"${m[1]}" is not a recognised ISO 639-1 language code`;
  if (m[3]) {
    let region = false;
    try {
      region = !!regionNames.of(m[3].toUpperCase());
    } catch {
      region = false;
    }
    if (!region || m[3].toUpperCase() === 'UK') return `"${m[3]}" is not an ISO 3166-1 alpha-2 region code${m[3].toUpperCase() === 'UK' ? ' (use GB)' : ''}`;
  }
  return null;
}

/** S-3.5: only the annotations declared in HTML/HTTP and at most 10 directly referenced alternates. */
export async function checkHreflang(env: Env, p: PageWork) {
  const { rec, acq, config } = env;
  const id = p.rec.page_id;
  await rec.guard('S-3.5', id, async () => {
    const gate = contentGate(p);
    const best = bestExtract(p);
    if (gate || !best) return gate!.status === 'NOT_APPLICABLE' ? rec.na('S-3.5', id, gate!.reason) : rec.untestable('S-3.5', id, gate!.reason);
    const all: HreflangObs[] = [...best.ex.hreflang];
    for (const h of p.rec.raw_extract?.hreflang ?? []) if (!all.some((x) => x.hreflang === h.hreflang && x.href === h.href)) all.push(h);
    if (!all.length) {
      if (config.multilingual) {
        return rec.untestable('S-3.5', id, 'The site was flagged as multilingual but this page declares no hreflang in HTML or HTTP headers. Annotations may exist only in a sitemap, which this initial audit does not read, so they cannot be validated here.');
      }
      return rec.na('S-3.5', id, 'No language/region annotations were observed on this page. That is not evidence that the whole site is monolingual.');
    }
    const pageUrl = best.url;
    const ev = rec.ev({ url: pageUrl, profile: best.profile, locator: 'link[rel=alternate][hreflang] / HTTP Link', observed: all.map((h) => `${h.hreflang} -> ${h.href} (${h.source})`).join(' | '), expected: 'valid codes, a self-reference, and return links from each alternate' });
    const findings: Finding[] = [];
    const limitations: string[] = [];
    const notes: string[] = [];

    const invalid = all.map((h) => ({ h, why: hreflangProblem(h.hreflang) })).filter((x) => x.why);
    if (invalid.length) {
      findings.push(rec.finding({
        check_id: 'S-3.5', status: 'FAIL', reason_code: 'HREFLANG_INVALID_CODE', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'Invalid hreflang code', explanation: invalid.map((x) => `"${x.h.hreflang}": ${x.why}`).join('; ') + '.',
        impact: 'Google ignores annotations whose language or region code it does not recognise.', action: 'Use an ISO 639-1 language code, optionally followed by an ISO 3166-1 alpha-2 region.', owner: 'Developer', effort: 'S',
      }));
    }
    const canon = p.rec.raw_extract?.canonical_head[0] ?? best.ex.canonical_head[0];
    const canonUrl = canon ? resolveCanonical(canon, pageUrl, best.ex.base_href) : null;
    const isSelf = (href: string) => sameUrl(href, pageUrl) || sameUrl(href, p.rec.url) || (!!canonUrl && sameUrl(href, canonUrl));
    if (!all.some((h) => isSelf(h.href))) {
      findings.push(rec.finding({
        check_id: 'S-3.5', status: 'FAIL', reason_code: 'HREFLANG_NO_SELF_REFERENCE', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'hreflang set has no self-reference', explanation: 'None of the declared alternates points to this page itself. Google requires each language version to list itself as well as the others.',
        impact: 'The annotation set for this page may be ignored.', action: 'Add an hreflang entry for this page\'s own URL and language.', owner: 'Developer', effort: 'S',
      }));
    }
    if (!all.some((h) => h.hreflang.toLowerCase() === 'x-default')) notes.push('No x-default entry. x-default is recommended as a fallback but optional.');

    const alternates = [...new Map(all.filter((h) => !isSelf(h.href) && /^https?:/i.test(h.href)).map((h) => [h.href, h])).values()];
    const cap = acq.ctx.budgets.max_hreflang_alternate_fetches;
    let tested = 0;
    const broken: string[] = [];
    const noReturn: string[] = [];
    const evs: string[] = [];
    for (const alt of alternates) {
      if (acq.ctx.counters.hreflang_alternate_fetches >= cap) {
        limitations.push(`${alt.href} was not fetched: the ${cap}-alternate limit for this run was reached.`);
        continue;
      }
      if (acq.ctx.blocked()) {
        limitations.push(`${alt.href} was not fetched: ${acq.ctx.blocked()}.`);
        continue;
      }
      acq.ctx.counters.hreflang_alternate_fetches++;
      const res = await acq.raw(alt.href, 'hreflang alternate');
      const r = res.record;
      if (r.acquisition !== 'OK' || r.validity === 'ACCESS_CHALLENGE') {
        limitations.push(`${alt.href} could not be verified (${r.acquisition === 'OK' ? 'access challenge' : r.acquisition}).`);
        continue;
      }
      tested++;
      if ((r.status ?? 0) >= 400) {
        broken.push(alt.href);
        evs.push(rec.ev({ url: alt.href, profile: 'RAW', locator: `hreflang="${alt.hreflang}" target`, observed: `HTTP ${r.status}`, expected: 'HTTP 200', at: r.fetched_at }));
        continue;
      }
      if (r.validity !== 'VALID_PAGE' || !res.text) {
        limitations.push(`${alt.href} did not return a readable page (${r.validity}).`);
        continue;
      }
      const ex = extractPage(res.text, r.final_url ?? alt.href, r.headers);
      const back = ex.hreflang.some((h) => isSelf(h.href));
      if (!back) {
        noReturn.push(alt.href);
        evs.push(rec.ev({ url: alt.href, profile: 'RAW', locator: 'return hreflang annotations', observed: ex.hreflang.map((h) => `${h.hreflang} -> ${h.href}`).join(' | ') || '(none declared)', expected: `an entry pointing back to ${pageUrl}`, at: r.fetched_at }));
      }
      const altCanon = ex.canonical_head[0] ? resolveCanonical(ex.canonical_head[0], r.final_url ?? alt.href, ex.base_href) : null;
      if (altCanon && !sameUrl(altCanon, r.final_url ?? alt.href)) notes.push(`${alt.href} declares a different canonical (${altCanon}); hreflang should reference canonical URLs.`);
    }
    if (broken.length) {
      findings.push(rec.finding({
        check_id: 'S-3.5', status: 'FAIL', reason_code: 'HREFLANG_TARGET_BROKEN', severity: 'MEDIUM', pages: [id], evidence: [ev, ...evs], sources: ['SRC-G-HREFLANG', 'SRC-G-HTTP'],
        title: 'hreflang points to a page that returns an error', explanation: `Tested alternate(s) returned an error status: ${broken.join(', ')}.`,
        impact: 'That language version cannot be served to its audience.', action: 'Fix the alternate URL or remove the annotation.', owner: 'Developer', effort: 'S',
      }));
    }
    if (noReturn.length) {
      findings.push(rec.finding({
        check_id: 'S-3.5', status: 'FAIL', reason_code: 'HREFLANG_NO_RETURN_LINK', severity: 'MEDIUM', pages: [id], evidence: [ev, ...evs],
        title: 'hreflang alternate does not link back', explanation: `${noReturn.join(', ')} ${noReturn.length === 1 ? 'does' : 'do'} not declare a return annotation to this page. Google ignores hreflang pairs that are not bidirectional.`,
        impact: 'The language pairing between these pages is ignored.', action: 'Add the reciprocal hreflang entry on each alternate.', owner: 'Developer', effort: 'S',
      }));
    }
    if (alternates.length && tested < alternates.length) limitations.push(`${tested} of ${alternates.length} declared alternates were tested; this is not a verdict on the full hreflang cluster.`);
    rec.result({ check_id: 'S-3.5', page_id: id, evidence: [ev], findings, notes, limitations, missing: alternates.length > 0 && tested === 0 });
  });
}
