import type { Env, PageWork } from './engine';
import { anyValid, bestExtract, contentGate, describeProfile, isIntentional, rawValid, renValid } from './engine';
import { effectiveDirectives, extractPage, norm, resolveCanonical } from '../extract/html';
import { fetchKey, sameUrl, truncate } from '../util/url';
import type { Finding } from '../types';

const hopsText = (hops: { url: string; status: number; location: string | null }[]) => hops.map((h) => `${h.status} ${h.url} -> ${h.location}`).join(' | ');

export async function checkRobots(env: Env) {
  const { rec, audit } = env;
  const r = audit.site.robots;
  await rec.guard('C-1.1', null, () => {
    if (!r.url) return rec.untestable('C-1.1', null, 'robots.txt was not fetched because no origin could be established.');
    const ev = rec.ev({ url: r.url, profile: 'RAW', locator: 'HTTP status / body', observed: `HTTP ${r.status ?? 'no response'} - ${r.note}`, body_ref: r.body_ref });
    const notes: string[] = [r.note];
    if (r.unsupported_fields.length) {
      notes.push(`Fields not supported by Google were present and are not treated as indexing directives: ${r.unsupported_fields.join(', ')}.`);
    }
    if (['UNREACHABLE', 'CHALLENGED', 'RATE_LIMITED', 'NOT_FETCHED'].includes(r.state)) {
      return rec.untestable('C-1.1', null, `${r.note} New page discovery was stopped conservatively for this auditor.`, [ev]);
    }
    const findings: Finding[] = [];
    if (r.state === 'SERVER_ERROR') {
      findings.push(rec.finding({
        check_id: 'C-1.1', status: 'WARN', reason_code: 'ROBOTS_SERVER_ERROR', severity: 'HIGH', pages: [], evidence: [ev],
        title: `robots.txt returns HTTP ${r.status}`,
        explanation: `The robots.txt request ended on HTTP ${r.status}. Google documents that a server error on robots.txt makes it stop crawling the site for a period while it retries, then fall back to a cached copy if one exists.`,
        impact: 'While the error persists, crawling of the whole site can pause. This was observed once by this auditor; it may be intermittent.',
        action: 'Confirm the response with a second check and server logs, then make /robots.txt return 200 with the intended rules (or 404 if no rules are intended).',
        owner: 'Developer / hosting', effort: 'S',
      }));
    }
    rec.result({ check_id: 'C-1.1', evidence: [ev], findings, notes });
  });
}

export async function checkCrawlPage(env: Env, p: PageWork) {
  const { rec, config, audit } = env;
  const id = p.rec.page_id;
  const intentional = isIntentional(p, config);

  // C-1.2 Googlebot robots access --------------------------------------------------------------------------
  await rec.guard('C-1.2', id, () => {
    const d = p.rec.robots.googlebot;
    const ev = rec.ev({ url: audit.site.robots.url ?? p.rec.url, profile: 'RAW', locator: `robots.txt decision for Googlebot on ${new URL(p.rec.url).pathname}`, observed: `${d.decision}${d.matched_rule ? ` - ${d.matched_rule}` : ''} (${d.reason})`, expected: 'ALLOW for an intended public page' });
    if (d.decision === 'UNKNOWN') return rec.untestable('C-1.2', id, `Googlebot access is unknown: ${d.reason}`, [ev]);
    if (d.decision === 'ALLOW') return rec.result({ check_id: 'C-1.2', page_id: id, evidence: [ev] });
    if (intentional) return rec.result({ check_id: 'C-1.2', page_id: id, evidence: [ev], notes: ['Googlebot is disallowed. The operator marked this page or environment as intentionally restricted, so this is recorded as a policy choice.'] });
    rec.result({
      check_id: 'C-1.2', page_id: id, evidence: [ev],
      findings: [rec.finding({
        check_id: 'C-1.2', status: 'FAIL', reason_code: 'GOOGLEBOT_DISALLOWED', severity: 'HIGH', pages: [id], evidence: [ev],
        title: 'robots.txt disallows Googlebot on a sampled public page',
        explanation: `The longest matching rule for Googlebot on this path is ${d.matched_rule}. A robots.txt disallow controls crawling: Google cannot read the page's content, canonical or indexing rules.`,
        impact: 'Google cannot crawl this page. A robots block does not by itself prove the URL is absent from the index, but its content cannot be evaluated or refreshed.',
        action: 'If the page is meant to be found in search, remove or narrow the matching Disallow rule. If the block is intentional, mark the page as an intentional restriction for future audits.',
        owner: 'SEO / developer', effort: 'S',
      })],
    });
  });

  // C-1.3 HTTP status -----------------------------------------------------------------------------------------
  await rec.guard('C-1.3', id, () => {
    const r = p.raw.record;
    if (p.rec.state === 'BLOCKED') return rec.untestable('C-1.3', id, 'ROBOTS_DISALLOWED_FOR_AUDITOR: the page was not fetched.');
    if (r.acquisition !== 'OK') {
      return rec.untestable('C-1.3', id, `No HTTP status was observed (${r.acquisition}${r.error ? `: ${truncate(r.error, 140)}` : ''}). A timeout or connection failure is unavailable evidence, not a status code.`);
    }
    const ev = rec.ev({ url: r.requested_url, profile: 'RAW', locator: 'HTTP status line', observed: `HTTP ${r.status}${r.hops.length ? ` after ${r.hops.length} redirect hop(s): ${hopsText(r.hops)}` : ''}; final URL ${r.final_url}`, expected: 'HTTP 200', body_ref: r.body_ref, at: r.fetched_at });
    if (r.validity === 'ACCESS_CHALLENGE') {
      return rec.untestable('C-1.3', id, `ACCESS_CHALLENGE_DETECTED: HTTP ${r.status} carried an access challenge for this auditor (${r.validity_evidence.slice(0, 2).join('; ')}). The page's real status was not observed.`, [ev]);
    }
    const s = r.status ?? 0;
    if (s === 200) return rec.result({ check_id: 'C-1.3', page_id: id, evidence: [ev] });
    if (s === 429) return rec.untestable('C-1.3', id, 'HTTP 429: the server rate-limited this auditor; the page status is unavailable.', [ev]);
    if (s === 401 || s === 403) {
      if (intentional) return rec.result({ check_id: 'C-1.3', page_id: id, evidence: [ev], notes: [`HTTP ${s} on a page marked as intentionally restricted; recorded as a policy choice.`] });
      return rec.result({
        check_id: 'C-1.3', page_id: id, evidence: [ev],
        findings: [rec.finding({
          check_id: 'C-1.3', status: 'WARN', reason_code: 'ACCESS_DENIED_STATUS', severity: 'MEDIUM', pages: [id], evidence: [ev],
          title: `Sampled page returns HTTP ${s} to this auditor`,
          explanation: `The page answered HTTP ${s}. This can be an intentional restriction, or a firewall rule that denies this auditor specifically. This audit cannot tell which.`,
          impact: 'If search crawlers receive the same status, Google does not use content from 4xx URLs. If only this auditor is denied, there is no search impact.',
          action: 'Check with Search Console URL Inspection or server logs what Googlebot receives for this URL. If the page should be public, allow access; if it is private, exclude it from future samples.',
          owner: 'Developer / hosting', effort: 'S',
        })],
      });
    }
    if (s === 404 || s === 410 || s >= 500) {
      return rec.result({
        check_id: 'C-1.3', page_id: id, evidence: [ev],
        findings: [rec.finding({
          check_id: 'C-1.3', status: 'FAIL', reason_code: s >= 500 ? 'SERVER_ERROR_STATUS' : 'NOT_FOUND_STATUS', severity: 'HIGH', pages: [id], evidence: [ev],
          title: `Sampled page returns HTTP ${s}`,
          explanation: s >= 500
            ? `The page returned a server error (HTTP ${s}). Google slows crawling on 5xx responses and eventually drops content that keeps failing.`
            : `The page returned HTTP ${s}. Google does not use content from URLs that return a 4xx status.`,
          impact: s >= 500 ? 'The page cannot be crawled or indexed while the error persists. A single observation may be intermittent.' : 'The page cannot be indexed, and internal links pointing to it lead nowhere.',
          action: s >= 500 ? 'Check server/application logs for this URL and fix the failure; re-test to confirm it is not intermittent.' : 'Restore the page, redirect the URL to its replacement with a 301, or remove internal links to it.',
          owner: 'Developer', effort: 'M',
        })],
      });
    }
    rec.result({
      check_id: 'C-1.3', page_id: id, evidence: [ev],
      findings: [rec.finding({
        check_id: 'C-1.3', status: 'WARN', reason_code: 'UNEXPECTED_STATUS', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: `Sampled page returns HTTP ${s}`, explanation: `The final response status was ${s}, which is not a normal page response.`,
        impact: 'Crawlers may not process this URL as a regular page.', action: 'Return HTTP 200 for the page or redirect it to the intended URL.', owner: 'Developer', effort: 'S',
      })],
    });
  });

  // C-1.5 Redirects ---------------------------------------------------------------------------------------------
  await rec.guard('C-1.5', id, () => {
    const r = p.raw.record;
    if (p.rec.state === 'BLOCKED') return rec.untestable('C-1.5', id, 'ROBOTS_DISALLOWED_FOR_AUDITOR: the page was not fetched.');
    const findings: Finding[] = [];
    const notes: string[] = [];
    const chain = r.hops.length ? hopsText(r.hops) : 'no server redirect';
    const ev = rec.ev({ url: r.requested_url, profile: 'RAW', locator: 'redirect chain', observed: `${chain}; outcome ${r.acquisition}${r.final_url ? `; final URL ${r.final_url}` : ''}`, expected: 'direct 200, or a short HTTPS-preserving redirect', at: r.fetched_at });
    if (r.acquisition === 'REDIRECT_LOOP' || r.acquisition === 'TOO_MANY_REDIRECTS') {
      findings.push(rec.finding({
        check_id: 'C-1.5', status: 'FAIL', reason_code: r.acquisition, severity: 'HIGH', pages: [id], evidence: [ev], sources: ['SRC-G-HTTP'],
        title: r.acquisition === 'REDIRECT_LOOP' ? 'Redirect loop' : 'Redirect chain exceeds the hop limit',
        explanation: `${r.error}. Google follows up to 10 redirect hops; a loop never resolves.`,
        impact: 'The URL never resolves to a page, so it cannot be crawled or indexed.', action: 'Fix the redirect rules so the URL resolves to its final page in one hop.', owner: 'Developer', effort: 'S',
      }));
    } else if (r.acquisition !== 'OK') {
      return rec.untestable('C-1.5', id, `Redirect behaviour could not be observed (${r.acquisition}).`, [ev]);
    } else {
      const downgrade = r.hops.find((h) => h.url.startsWith('https:') && (h.location ?? '').startsWith('http:'));
      if (downgrade) {
        findings.push(rec.finding({
          check_id: 'C-1.5', status: 'FAIL', reason_code: 'HTTPS_DOWNGRADE_REDIRECT', severity: 'HIGH', pages: [id], evidence: [ev], sources: ['SRC-G-CANON', 'SRC-G-HTTP'],
          title: 'Redirect downgrades HTTPS to HTTP', explanation: `${downgrade.url} redirects to ${downgrade.location}. Google prefers HTTPS pages as canonical.`,
          impact: 'Visitors and crawlers are sent to an insecure URL, which conflicts with HTTPS canonicalisation.', action: 'Redirect to the HTTPS version of the destination.', owner: 'Developer', effort: 'S',
        }));
      }
      if (r.hops.length > 2) {
        findings.push(rec.finding({
          check_id: 'C-1.5', status: 'WARN', reason_code: 'LONG_REDIRECT_CHAIN', severity: 'LOW', pages: [id], evidence: [ev], sources: ['SRC-TOOL-POLICY', 'SRC-G-HTTP'], classification: 'OPPORTUNITY',
          title: `${r.hops.length} redirect hops before the page`, explanation: `The URL passes through ${r.hops.length} server redirects. Google follows up to 10; the two-hop efficiency target is a Wellows tool policy, not a search-engine rule.`,
          impact: 'Each hop adds latency for visitors and crawlers.', action: 'Point the first redirect straight at the final URL.', owner: 'Developer', effort: 'S',
        }));
      } else if (r.hops.length) notes.push(`${r.hops.length} server redirect hop(s) observed: ${chain}.`);
      const rr = p.rendered.record;
      if (rr.acquisition === 'OK' && rr.final_url && r.final_url && renValid(p) && rawValid(p)) {
        const a = new URL(r.final_url);
        const b = new URL(rr.final_url);
        const onlySchemeUpgrade = a.host === b.host && a.pathname + a.search === b.pathname + b.search && a.protocol === 'http:' && b.protocol === 'https:';
        if (onlySchemeUpgrade) notes.push('The browser loaded the HTTPS version of the same URL. A browser-side HTTPS upgrade is not counted as a server redirect.');
        else if (fetchKey(a) !== fetchKey(b)) {
          const ev2 = rec.ev({ url: r.requested_url, profile: 'RENDERED', locator: 'final URL after rendering', observed: rr.final_url, expected: r.final_url, at: rr.rendered_at });
          findings.push(rec.finding({
            check_id: 'C-1.5', status: 'WARN', reason_code: 'CLIENT_SIDE_REDIRECT', severity: 'LOW', pages: [id], evidence: [ev, ev2], sources: ['SRC-G-JS', 'SRC-G-HTTP'],
            title: 'Rendered page ends on a different URL than the server response', explanation: `The server's final URL is ${r.final_url}, but after rendering the browser is on ${rr.final_url}. The move happens client-side (script or meta refresh).`,
            impact: 'Crawlers that do not render see a different destination than visitors. Server redirects are a stronger, faster signal.', action: 'Replace the client-side redirect with a server-side 301 where possible.', owner: 'Developer', effort: 'S',
          }));
        }
      }
    }
    rec.result({ check_id: 'C-1.5', page_id: id, evidence: [ev], findings, notes });
  });

  // C-1.7 Canonical ----------------------------------------------------------------------------------------------
  await rec.guard('C-1.7', id, async () => {
    const gate = contentGate(p);
    if (gate) return gate.status === 'NOT_APPLICABLE' ? rec.na('C-1.7', id, gate.reason) : rec.untestable('C-1.7', id, gate.reason);
    const docUrl = p.raw.record.final_url ?? p.rendered.record.final_url ?? p.rec.url;
    const rawEx = rawValid(p) ? p.rec.raw_extract : null;
    const renEx = renValid(p) ? p.rec.rendered_extract : null;
    const resolve = (vals: string[], base: string | null) => [...new Set(vals.map((v) => resolveCanonical(v, docUrl, base)).filter((v): v is string => !!v))];
    const rawHead = rawEx ? resolve(rawEx.canonical_head, rawEx.base_href) : [];
    const rawBody = rawEx ? resolve(rawEx.canonical_body, rawEx.base_href) : [];
    const http = rawEx ? resolve(rawEx.canonical_http, null) : [];
    const renHead = renEx ? resolve(renEx.canonical_head, renEx.base_href) : [];
    const invalid = [...(rawEx?.canonical_head ?? []), ...(renEx?.canonical_head ?? [])].filter((v) => !resolveCanonical(v, docUrl, null));
    const limitations: string[] = [];
    if (!rawEx) limitations.push(`RAW canonical could not be read (${describeProfile(p.raw.record)}); only the rendered document was evaluated.`);
    if (!renEx) limitations.push(`RENDERED canonical could not be read (${describeProfile(p.rendered.record)}); only the RAW document was evaluated.`);
    const ev = rec.ev({
      url: docUrl, profile: rawEx ? 'RAW' : 'RENDERED', locator: 'head link[rel=canonical] / HTTP Link header',
      observed: `RAW head: ${rawEx ? rawEx.canonical_head.join(', ') || '(none)' : 'n/a'} | RAW body: ${rawEx ? rawEx.canonical_body.join(', ') || '(none)' : 'n/a'} | HTTP Link: ${rawEx ? rawEx.canonical_http.join(', ') || '(none)' : 'n/a'} | RENDERED head: ${renEx ? renEx.canonical_head.join(', ') || '(none)' : 'n/a'}`,
      expected: 'one consistent canonical declaration, or none',
    });
    const findings: Finding[] = [];
    const notes: string[] = [];
    const declaredRaw = [...new Set([...rawHead, ...http])];

    if (declaredRaw.length > 1) {
      findings.push(rec.finding({
        check_id: 'C-1.7', status: 'FAIL', reason_code: 'CANONICAL_CONFLICT', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'Conflicting canonical declarations', explanation: `The server response declares more than one canonical URL: ${declaredRaw.join(' and ')}. Google asks that different techniques do not specify different canonical URLs.`,
        impact: 'Google may ignore the conflicting hints and choose a canonical itself.', action: 'Keep exactly one canonical URL across the head link element and the HTTP Link header.', owner: 'Developer', effort: 'S',
      }));
    }
    if (!rawHead.length && rawBody.length) {
      findings.push(rec.finding({
        check_id: 'C-1.7', status: 'WARN', reason_code: 'CANONICAL_OUTSIDE_HEAD', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'Canonical link element is outside the head', explanation: `The only canonical link (${rawBody[0]}) is parsed inside the body. Google documents rel="canonical" as an element used in the head; an element before it may be closing the head early.`,
        impact: 'A canonical outside the head is likely to be ignored.', action: 'Move the canonical link into the head and make sure no body-only element precedes it.', owner: 'Developer', effort: 'S',
      }));
    }
    if (invalid.length) {
      findings.push(rec.finding({
        check_id: 'C-1.7', status: 'WARN', reason_code: 'CANONICAL_INVALID_VALUE', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'Canonical value is not a usable URL', explanation: `The canonical value "${truncate(invalid[0], 120)}" does not resolve to an http(s) URL.`,
        impact: 'The hint cannot be used.', action: 'Set the canonical to the page\'s preferred absolute URL.', owner: 'Developer', effort: 'S',
      }));
    }
    if (rawHead.length === 1 && renHead.length === 1 && !sameUrl(rawHead[0], renHead[0])) {
      findings.push(rec.finding({
        check_id: 'C-1.7', status: 'WARN', reason_code: 'CANONICAL_CHANGED_BY_JAVASCRIPT', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'JavaScript changes the canonical URL', explanation: `The server HTML declares ${rawHead[0]}; after rendering it is ${renHead[0]}. Google advises that JavaScript should not change the canonical link element.`,
        impact: 'Crawlers can receive two different canonical hints for the same page.', action: 'Output the final canonical URL in the server HTML and stop modifying it client-side.', owner: 'Developer', effort: 'S',
      }));
    }
    const declared = declaredRaw.length === 1 ? declaredRaw[0] : declaredRaw.length === 0 && renHead.length === 1 ? renHead[0] : null;
    if (!declaredRaw.length && !rawBody.length && renHead.length === 1) notes.push('The canonical is set only by JavaScript (absent from the server HTML). Google supports this when the HTML source does not carry a different value.');
    if ([...(rawEx?.canonical_head ?? []), ...(renEx?.canonical_head ?? [])].some((v) => v && !/^https?:\/\//i.test(v) && !v.startsWith('//'))) {
      notes.push('The canonical uses a relative URL. Relative canonicals are supported; Google advises absolute URLs to avoid long-run mistakes.');
    }
    if (!declaredRaw.length && !rawBody.length && !renHead.length && !invalid.length) {
      findings.push(rec.finding({
        check_id: 'C-1.7', status: 'WARN', reason_code: 'CANONICAL_MISSING', severity: 'LOW', pages: [id], evidence: [ev], classification: 'OPPORTUNITY',
        title: 'No canonical declaration', explanation: 'No rel="canonical" was found in the HTML head or HTTP headers. Google states that specifying a canonical is encouraged but not required.',
        impact: 'Google selects a canonical on its own. Parameter or tracking variants of this URL are not explicitly consolidated.', action: 'Add a self-referencing canonical with the preferred absolute URL.', owner: 'Developer', effort: 'S',
      }));
    }
    if (declared && !sameUrl(declared, docUrl)) {
      const b = env.acq.ctx.budgets;
      const crossDomain = new URL(declared).hostname !== new URL(docUrl).hostname;
      if (env.acq.ctx.counters.canonical_target_fetches >= b.max_canonical_target_fetches) {
        limitations.push(`The canonical target ${declared} was not fetched: the ${b.max_canonical_target_fetches}-target limit was reached.`);
      } else if (env.acq.ctx.blocked()) {
        limitations.push(`The canonical target ${declared} was not fetched: ${env.acq.ctx.blocked()}.`);
      } else {
        env.acq.ctx.counters.canonical_target_fetches++;
        const t = await env.acq.raw(declared, 'canonical target');
        const tr = t.record;
        const tev = rec.ev({ url: declared, profile: 'RAW', locator: 'canonical target response', observed: tr.acquisition === 'OK' ? `HTTP ${tr.status}${tr.hops.length ? ` after ${hopsText(tr.hops)}` : ''} (${tr.validity})` : tr.acquisition, expected: 'HTTP 200 without redirect', at: tr.fetched_at });
        if (tr.acquisition !== 'OK' || tr.validity === 'ACCESS_CHALLENGE') {
          limitations.push(`The canonical target ${declared} could not be verified (${tr.acquisition === 'OK' ? 'access challenge' : tr.acquisition}).`);
        } else if ((tr.status ?? 0) >= 400) {
          findings.push(rec.finding({
            check_id: 'C-1.7', status: 'FAIL', reason_code: 'CANONICAL_TARGET_BROKEN', severity: 'MEDIUM', pages: [id], evidence: [ev, tev], sources: ['SRC-G-CANON', 'SRC-G-HTTP'],
            title: `Canonical points to a URL returning HTTP ${tr.status}`, explanation: `The declared canonical ${declared} returns HTTP ${tr.status}.`,
            impact: 'The canonical hint names a URL that cannot be indexed, so it is likely to be ignored.', action: 'Point the canonical to a live 200 URL.', owner: 'Developer', effort: 'S',
          }));
        } else if (tr.hops.length) {
          findings.push(rec.finding({
            check_id: 'C-1.7', status: 'WARN', reason_code: 'CANONICAL_TARGET_REDIRECTS', severity: 'LOW', pages: [id], evidence: [ev, tev], sources: ['SRC-G-CANON'],
            title: 'Canonical points to a redirecting URL', explanation: `The declared canonical ${declared} redirects to ${tr.final_url}.`,
            impact: 'The hint is indirect; the final URL is the better canonical.', action: `Set the canonical to ${tr.final_url}.`, owner: 'Developer', effort: 'S',
          }));
        } else if (tr.validity === 'VALID_PAGE' && t.text) {
          const targetTitle = norm(extractPage(t.text, declared, tr.headers).title ?? '').toLowerCase();
          const ownTitle = norm(bestExtract(p)?.ex.title ?? '').toLowerCase();
          if (targetTitle && ownTitle && targetTitle !== ownTitle) {
            findings.push(rec.finding({
              check_id: 'C-1.7', status: 'WARN', reason_code: 'CANONICAL_POINTS_TO_DIFFERENT_PAGE', severity: 'MEDIUM', pages: [id], evidence: [ev, tev], confidence: 'DERIVED',
              title: 'Canonical names a different page', explanation: `This page declares ${declared} as canonical, and that URL has a different title ("${truncate(targetTitle, 80)}" versus "${truncate(ownTitle, 80)}"). The comparison is derived from titles.`,
              impact: 'If the pages are not duplicates, this page is asking to be left out of the index in favour of another one.', action: 'If this page should rank on its own, make its canonical self-referencing. Keep the current value only if it is a deliberate duplicate.', owner: 'SEO / developer', effort: 'S',
            }));
          } else notes.push(`The canonical points to ${declared}${crossDomain ? ' on another host (cross-domain canonicals are legitimate)' : ''}, which responds 200 with the same title.`);
        }
      }
    } else if (declared) notes.push('The canonical is self-referencing.');
    rec.result({ check_id: 'C-1.7', page_id: id, evidence: [ev], findings, notes, limitations });
  });

  // C-1.8 Indexing directives and C-1.9 snippet controls ----------------------------------------------------------
  const gate = contentGate(p);
  await rec.guard('C-1.8', id, () => {
    if (gate) return gate.status === 'NOT_APPLICABLE' ? rec.na('C-1.8', id, gate.reason) : rec.untestable('C-1.8', id, gate.reason);
    const rawD = rawValid(p) && p.rec.raw_extract ? effectiveDirectives(p.rec.raw_extract) : null;
    const renD = renValid(p) && p.rec.rendered_extract ? effectiveDirectives({ meta_robots: p.rec.rendered_extract.meta_robots, x_robots_tag: p.rec.raw_extract?.x_robots_tag ?? p.rec.rendered_extract.x_robots_tag }) : null;
    const show = (d: typeof rawD) => (d ? d.sources.join(' ; ') || '(no restrictive directive)' : 'n/a');
    const ev = rec.ev({ url: p.rec.url, profile: rawD ? 'RAW' : 'RENDERED', locator: 'meta[name=robots|googlebot] / X-Robots-Tag', observed: `RAW: ${show(rawD)} | RENDERED: ${show(renD)}`, expected: 'no noindex on an intended search page' });
    const noindex = !!(rawD?.noindex || renD?.noindex);
    const nofollow = !!(rawD?.nofollow || renD?.nofollow);
    const findings: Finding[] = [];
    const notes: string[] = [];
    const limitations: string[] = [];
    if (!rawD) limitations.push(`RAW directives could not be read (${describeProfile(p.raw.record)}).`);
    if (!renD) limitations.push(`RENDERED directives could not be read (${describeProfile(p.rendered.record)}).`);
    if (noindex && intentional) notes.push('noindex is present. The operator marked this page or environment as intentionally restricted, so this is a policy choice, not a defect.');
    else if (noindex) {
      const where = rawD?.noindex && renD && !renD.noindex ? ' It is present in the server HTML and removed by JavaScript; Google may skip rendering a page that is noindex in the initial HTML.' : !rawD?.noindex && renD?.noindex ? ' It is added by JavaScript after rendering.' : '';
      findings.push(rec.finding({
        check_id: 'C-1.8', status: 'FAIL', reason_code: 'UNEXPECTED_NOINDEX', severity: 'CRITICAL', pages: [id], evidence: [ev],
        title: 'noindex on a page intended for search', explanation: `The effective indexing rule for Googlebot is noindex (${[...(rawD?.sources ?? []), ...(renD?.sources ?? [])].filter((v, i, a) => a.indexOf(v) === i).join(' ; ')}). Where rules conflict, the more restrictive rule applies.${where}`,
        impact: 'Google will not show this page in search results, which also makes it ineligible as a supporting link in AI Overviews and AI Mode.', action: 'Remove the noindex rule from the meta tag or X-Robots-Tag header if the page should be found. If it is intentional, mark the page as an intentional restriction.', owner: 'SEO / developer', effort: 'S',
      }));
    }
    if (nofollow && !intentional) {
      findings.push(rec.finding({
        check_id: 'C-1.8', status: 'WARN', reason_code: 'PAGE_LEVEL_NOFOLLOW', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'Page-level nofollow', explanation: 'The page carries a nofollow (or none) rule that applies to every link on it.',
        impact: 'Google does not follow links from this page, which weakens discovery of the pages it links to.', action: 'Remove page-level nofollow unless it is deliberate; qualify individual links instead.', owner: 'SEO / developer', effort: 'S',
      }));
    }
    if (!noindex && !nofollow) notes.push('No restrictive indexing directive was found. A missing "index,follow" tag is not a defect; it is the default.');
    rec.result({ check_id: 'C-1.8', page_id: id, evidence: [ev], findings, notes, limitations });
  });

  await rec.guard('C-1.9', id, () => {
    if (gate) return gate.status === 'NOT_APPLICABLE' ? rec.na('C-1.9', id, gate.reason) : rec.untestable('C-1.9', id, gate.reason);
    const best = bestExtract(p)!;
    const d = effectiveDirectives({ meta_robots: best.ex.meta_robots, x_robots_tag: p.rec.raw_extract?.x_robots_tag ?? best.ex.x_robots_tag });
    const ev = rec.ev({ url: p.rec.url, profile: best.profile, locator: 'nosnippet / max-snippet / data-nosnippet', observed: `nosnippet: ${d.nosnippet}; max-snippet: ${d.max_snippet ?? 'not set'}; data-nosnippet elements: ${best.ex.data_nosnippet_count}${best.ex.data_nosnippet_excerpts.length ? ` ("${best.ex.data_nosnippet_excerpts[0]}")` : ''}` });
    const findings: Finding[] = [];
    const notes: string[] = [];
    if (d.nosnippet && config.visibility_goal === 'search_ai_discovery' && !intentional) {
      findings.push(rec.finding({
        check_id: 'C-1.9', status: 'WARN', reason_code: 'SNIPPET_DISABLED', severity: 'LOW', pages: [id], evidence: [ev], classification: 'ADVISORY',
        title: 'Snippets are disabled for this page', explanation: `The page sets ${d.max_snippet === 0 ? 'max-snippet:0' : 'nosnippet'}. This is a legitimate publisher control documented for Google Search; it is not an instruction to other AI crawlers.`,
        impact: 'Google shows no text snippet for the page and does not use it as direct input for AI Overviews. That is a trade-off against discovery as the stated goal.', action: 'Keep the rule if it is deliberate. Otherwise remove it, or use data-nosnippet on only the sensitive passages.', owner: 'SEO', effort: 'S',
      }));
    } else {
      if (d.max_snippet !== null && d.max_snippet > 0) notes.push(`max-snippet:${d.max_snippet} limits Google's text snippet length for this page.`);
      if (best.ex.data_nosnippet_count) notes.push(`${best.ex.data_nosnippet_count} element(s) are excluded from Google snippets with data-nosnippet.`);
      if (!d.nosnippet && d.max_snippet === null && !best.ex.data_nosnippet_count) notes.push('No snippet restriction is set.');
    }
    rec.result({ check_id: 'C-1.9', page_id: id, evidence: [ev], findings, notes });
  });
}

/** Derived, unscored composite. It restates other checks and never claims the page is indexed. */
export function deriveEligibility(env: Env, p: PageWork) {
  const { rec } = env;
  const id = p.rec.page_id;
  const of = (cid: string) => rec.checks.find((c) => c.check_id === cid && c.page_id === id);
  const access = of('C-1.2');
  const status = of('C-1.3');
  const directives = of('C-1.8');
  const canonical = of('C-1.7');
  const blockers: string[] = [];
  const unknowns: string[] = [];
  if (access?.status === 'FAIL') blockers.push('robots.txt disallows Googlebot (C-1.2)');
  else if (access?.status === 'NOT_TESTABLE') unknowns.push('Googlebot robots access is unknown (C-1.2)');
  if (status?.status === 'FAIL') blockers.push('the page returns an error status (C-1.3)');
  else if (status?.status !== 'PASS') unknowns.push('the page status was not confirmed as 200 (C-1.3)');
  if (directives?.findings.some((f) => f.reason_code === 'UNEXPECTED_NOINDEX')) blockers.push('a noindex rule applies (C-1.8)');
  else if (directives?.status === 'NOT_TESTABLE') unknowns.push('indexing directives were not readable (C-1.8)');
  if (canonical?.findings.some((f) => ['CANONICAL_POINTS_TO_DIFFERENT_PAGE', 'CANONICAL_TARGET_BROKEN', 'CANONICAL_CONFLICT'].includes(f.reason_code))) unknowns.push('canonical signals are unclear or point elsewhere (C-1.7)');
  const best = bestExtract(p);
  if (anyValid(p) && best && !best.ex.main_text.trim() && !(best.ex.title ?? '').trim()) unknowns.push('no usable content was extracted');
  if (p.rec.intent === 'intentional_restriction') {
    p.rec.technical_eligibility = null;
    rec.result({ check_id: 'C-1.10', page_id: id, evidence: [], status: 'NOT_APPLICABLE', notes: ['Marked as an intentional restriction; search eligibility is not the goal for this page.'] });
    return;
  }
  const evIds = [access, status, directives, canonical].flatMap((c) => c?.evidence_ids.slice(0, 1) ?? []);
  if (blockers.length) {
    p.rec.technical_eligibility = 'NOT_ELIGIBLE';
    rec.result({ check_id: 'C-1.10', page_id: id, evidence: evIds, derivedStatus: 'FAIL', notes: [`Not technically eligible based on observable signals: ${blockers.join('; ')}. This restates those checks and is not scored again. A robots.txt block controls crawling and does not by itself prove the URL is absent from the index.`] });
  } else if (unknowns.length) {
    p.rec.technical_eligibility = 'UNCERTAIN';
    rec.result({ check_id: 'C-1.10', page_id: id, evidence: evIds, status: 'NOT_TESTABLE', limitations: [`Eligibility is uncertain: ${unknowns.join('; ')}.`] });
  } else {
    p.rec.technical_eligibility = 'ELIGIBLE';
    rec.result({ check_id: 'C-1.10', page_id: id, evidence: evIds, notes: ['Technically eligible based on observable signals: crawlable for Googlebot, HTTP 200, no noindex, no conflicting canonical. This is not a statement that the page is indexed.'] });
  }
}

export async function checkCrawlSite(env: Env) {
  const { rec, audit } = env;

  // C-1.4 soft-404 handling ----------------------------------------------------------------------------------------
  await rec.guard('C-1.4', null, () => {
    const s = audit.site.soft404;
    if (!s.probe_url || ['NOT_TESTED', 'CHALLENGED'].includes(s.outcome)) return rec.untestable('C-1.4', null, s.note);
    const ev = rec.ev({ url: s.probe_url, profile: 'RAW', locator: 'nonexistent-path probe', observed: `HTTP ${s.status} - ${s.note}`, expected: 'HTTP 404 or 410' });
    if (s.outcome === 'CORRECT_STATUS') return rec.result({ check_id: 'C-1.4', evidence: [ev], notes: [s.note] });
    if (s.outcome === 'ERROR_CONTENT_WITH_200') {
      return rec.result({
        check_id: 'C-1.4', evidence: [ev],
        findings: [rec.finding({
          check_id: 'C-1.4', status: 'WARN', reason_code: 'MISSING_PAGE_RETURNS_200', severity: 'MEDIUM', pages: [], evidence: [ev], confidence: 'DERIVED',
          title: 'Missing pages return HTTP 200', explanation: `${s.note} Google reports 2xx responses whose content suggests an error as soft 404s; this audit did not verify Google's own classification.`,
          impact: 'Removed or mistyped URLs can keep being crawled as if they were real pages, which wastes crawling and can leave error pages reported in Search Console.', action: 'Return HTTP 404 (or 410) from the not-found template.', owner: 'Developer', effort: 'S',
        })],
      });
    }
    if (s.outcome === 'SERVER_ERROR') {
      return rec.result({
        check_id: 'C-1.4', evidence: [ev],
        findings: [rec.finding({
          check_id: 'C-1.4', status: 'WARN', reason_code: 'MISSING_PAGE_RETURNS_5XX', severity: 'MEDIUM', pages: [], evidence: [ev],
          title: `Missing pages return HTTP ${s.status}`, explanation: s.note, impact: 'Server errors for unknown URLs can slow crawling.', action: 'Return HTTP 404 for unknown URLs.', owner: 'Developer', effort: 'S',
        })],
      });
    }
    rec.untestable('C-1.4', null, s.note, [ev]);
  });

  // C-1.6 origin consolidation ------------------------------------------------------------------------------------
  await rec.guard('C-1.6', null, () => {
    const rows = audit.site.origins;
    if (!rows.length) return rec.untestable('C-1.6', null, 'Origin variants were not tested.');
    const evs = rows.map((o) => rec.ev({ url: o.url, profile: 'RAW', locator: 'origin variant response', observed: o.error ? o.error : `HTTP ${o.status}${o.hops.length ? ` after ${hopsText(o.hops)}` : ' (no redirect)'}; final ${o.final_url}; validity ${o.validity}; canonical ${o.canonical ?? '(none)'}`, expected: 'one live origin; the others redirect to it' }));
    const live = rows.filter((o) => o.status === 200 && o.validity === 'VALID_PAGE' && o.final_url);
    const notes = rows.filter((o) => o.error || o.validity === 'ACCESS_CHALLENGE').map((o) => `${o.url}: ${o.error ?? 'access challenge for this auditor'} (observation only).`);
    if (!live.length) return rec.untestable('C-1.6', null, 'No origin variant returned a genuine page to this auditor.', evs);
    const finals = [...new Set(live.map((o) => new URL(o.final_url as string).origin))];
    if (finals.length === 1) return rec.result({ check_id: 'C-1.6', evidence: evs, notes: [`All reachable origin variants resolve to ${finals[0]}.`, ...notes] });
    const canonOrigins = live.map((o) => (o.canonical ? new URL(o.canonical).origin : null));
    const distinct = [...new Set(canonOrigins.filter(Boolean))];
    const coherent = canonOrigins.every(Boolean) && distinct.length === 1;
    const insecure = finals.some((f) => f.startsWith('http:'));
    rec.result({
      check_id: 'C-1.6', evidence: evs, notes,
      findings: [rec.finding({
        check_id: 'C-1.6', status: 'WARN', reason_code: coherent ? 'DUPLICATE_ORIGINS_COHERENT_CANONICAL' : distinct.length > 1 ? 'DUPLICATE_ORIGINS_CONFLICTING_CANONICAL' : 'DUPLICATE_ORIGINS_NO_CANONICAL',
        severity: coherent ? 'LOW' : 'MEDIUM', pages: [], evidence: evs,
        title: coherent ? 'Homepage is live on more than one origin (canonicals agree)' : 'Homepage is live on more than one origin without a consistent canonical',
        explanation: `The homepage answers HTTP 200 without redirecting on ${finals.join(' and ')}. ${coherent ? `Every live version declares ${distinct[0]} as canonical, so the consolidation signal is consistent.` : distinct.length > 1 ? `The live versions declare different canonical origins (${distinct.join(', ')}), which is a verified conflict.` : 'At least one live version declares no canonical, so nothing tells search engines which origin is preferred.'}`,
        impact: coherent ? 'Search engines can consolidate these duplicates using the canonical, but links and crawling stay split across origins.' : 'Search engines must choose a preferred origin themselves, and signals can be split between duplicates.',
        action: `301-redirect every other origin to the preferred one${insecure ? ' (HTTPS)' : ''}, and keep a single self-referencing canonical there.`,
        owner: 'Developer / hosting', effort: 'S',
      })],
    });
  });

  // C-1.11 Googlebot-blocked discovered candidates ------------------------------------------------------------------
  await rec.guard('C-1.11', null, () => {
    const blocked = audit.discovery.candidates.filter((c) => c.robots_googlebot === 'DISALLOW' && !c.excluded_reason);
    if (!blocked.length) return rec.na('C-1.11', null, 'No discovered public candidate URL is disallowed for Googlebot.');
    const robotsUrl = audit.site.robots.url ?? audit.target.normalized_url;
    const ev = rec.ev({ url: robotsUrl, profile: 'RAW', locator: 'robots.txt decisions for discovered links', observed: blocked.slice(0, 10).map((c) => `${c.url} (linked from ${c.zone}${c.text ? `: "${c.text}"` : ''})`).join(' ; ') + (blocked.length > 10 ? ` ; and ${blocked.length - 10} more` : '') });
    rec.result({
      check_id: 'C-1.11', evidence: [ev],
      findings: [rec.finding({
        check_id: 'C-1.11', status: 'WARN', reason_code: 'DISCOVERED_LINKS_BLOCKED_FOR_GOOGLEBOT', severity: 'MEDIUM', pages: [], evidence: [ev],
        title: `${blocked.length} linked page(s) are disallowed for Googlebot`, explanation: `Links found on the homepage or section hubs lead to URLs that robots.txt disallows for Googlebot. They were not sampled for content, so no title, schema or content conclusions are drawn about them.`,
        impact: 'If these are public business pages, Google cannot crawl them. If they are private areas, the block is working as intended.', action: 'Review the listed URLs and confirm each block is deliberate.', owner: 'SEO', effort: 'S',
      })],
    });
  });

  // C-1.12 parent sitemap endpoint ------------------------------------------------------------------------------------
  await rec.guard('C-1.12', null, () => {
    const sm = audit.site.sitemap;
    const evs = sm.matrix.map((m) => rec.ev({ url: m.requested_url, profile: 'RAW', locator: `sitemap endpoint (${m.role})`, observed: `initial ${m.initial_status ?? '-'}; ${m.hops.length} hop(s); final ${m.final_url ?? '-'} ${m.final_status ?? '-'}; ${m.network_error ?? 'no network error'}; result ${m.result}${m.note ? ` - ${m.note}` : ''}`, expected: m.role === 'variant' ? 'observation only' : 'OPEN' }));
    const scope = [sm.scope_statement];
    if (!sm.chosen) {
      if (!sm.matrix.length) return rec.untestable('C-1.12', null, 'The sitemap endpoint was not tested (no reachable origin or the run stopped).');
      if (sm.matrix.every((m) => m.result === 'INCONCLUSIVE')) return rec.untestable('C-1.12', null, 'The fallback sitemap paths returned challenge or fallback responses; whether a sitemap exists is unknown.', evs);
      return rec.result({
        check_id: 'C-1.12', evidence: evs, notes: scope,
        findings: [rec.finding({
          check_id: 'C-1.12', status: 'WARN', reason_code: 'SITEMAP_NOT_DISCOVERED', severity: 'LOW', pages: [], evidence: evs, classification: 'OPPORTUNITY', sources: ['SRC-G-SITEMAP'],
          title: 'No parent sitemap endpoint was found', explanation: 'robots.txt declares no Sitemap, and neither /sitemap.xml nor /sitemap_index.xml opened. A sitemap may still exist at another address or be submitted in Search Console; this audit does not look further.',
          impact: 'A sitemap helps discovery, especially on large or weakly linked sites, but Google does not require one.', action: 'Publish a sitemap and declare it with a Sitemap: line in robots.txt.', owner: 'SEO / developer', effort: 'S',
        })],
      });
    }
    const main = sm.matrix.find((m) => m.requested_url === sm.chosen) ?? sm.matrix[0];
    const variantNotes = sm.matrix.filter((m) => m !== main && m.result !== 'OPEN').map((m) => `${m.requested_url}: ${m.result} (${m.note ?? ''}) - observation only; a variant is not required to serve the sitemap.`);
    if (main.result === 'OPEN') {
      return rec.result({ check_id: 'C-1.12', evidence: evs, notes: [`The ${sm.chosen_basis === 'robots_declaration' ? 'declared' : 'fallback'} sitemap endpoint ${sm.chosen} is reachable. This does not establish that its contents are valid.`, ...variantNotes, ...scope] });
    }
    if (main.result === 'INCONCLUSIVE') return rec.untestable('C-1.12', null, `The sitemap endpoint ${sm.chosen} gave an inconclusive response: ${main.note ?? main.network_error}`, evs);
    rec.result({
      check_id: 'C-1.12', evidence: evs, notes: [...variantNotes, ...scope],
      findings: [rec.finding({
        check_id: 'C-1.12', status: 'FAIL', reason_code: 'DECLARED_SITEMAP_NOT_OPEN', severity: 'MEDIUM', pages: [], evidence: evs, sources: ['SRC-G-SITEMAP', 'SRC-G-HTTP'],
        title: 'The sitemap declared in robots.txt does not open', explanation: `robots.txt declares ${sm.chosen}, which ends on ${main.final_status ? `HTTP ${main.final_status}` : main.network_error}. This is an endpoint/configuration finding; it does not show that the site's pages cannot be indexed.`,
        impact: 'Crawlers that rely on the declared sitemap for discovery receive an error.', action: 'Fix the URL in the Sitemap: line or restore the file at that address.', owner: 'Developer', effort: 'S',
      })],
    });
  });
}
