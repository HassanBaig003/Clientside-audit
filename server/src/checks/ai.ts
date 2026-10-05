import * as cheerio from 'cheerio';
import type { Env, PageWork } from './engine';
import { describeProfile, isIntentional, rawValid, renValid } from './engine';
import { effectiveDirectives, norm } from '../extract/html';
import { BOTS, BOT_REGISTRY_VERSION } from '../sources/registry';
import { truncate } from '../util/url';

const ROBOTS_CAVEAT = 'Robots-level access only: a robots.txt allow cannot establish that the vendor\'s real crawler IP addresses pass the site\'s CDN or firewall.';

/** Why a RAW/RENDERED comparison cannot be made, or null. Never concludes JavaScript gating from a missing profile. */
function pairGate(p: PageWork): string | null {
  if (rawValid(p) && renValid(p)) return null;
  if (p.rec.state === 'BLOCKED') return 'ROBOTS_DISALLOWED_FOR_AUDITOR: the page was not fetched.';
  const raw = describeProfile(p.raw.record);
  const ren = describeProfile(p.rendered.record);
  if (!rawValid(p) && renValid(p)) return `RAW comparison unavailable (RAW: ${raw}). The rendered page is genuine, but without a genuine RAW document no conclusion about JavaScript dependency is drawn.`;
  if (rawValid(p) && !renValid(p)) return `RENDERED comparison unavailable (RENDERED: ${ren}). RAW findings are kept; a failed render does not show that the real page lacks content.`;
  return `Neither profile returned a genuine page (RAW: ${raw}; RENDERED: ${ren}).`;
}

function allVisibleText(html: string | null): string {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script,style,noscript,template').remove();
  return norm($('body').text()).toLowerCase();
}

export async function checkAiPage(env: Env, p: PageWork) {
  const { rec, config } = env;
  const id = p.rec.page_id;
  const gate = pairGate(p);
  const raw = p.rec.raw_extract;
  const ren = p.rec.rendered_extract;

  // A-5.1 primary content in RAW --------------------------------------------------------------------------------
  await rec.guard('A-5.1', id, () => {
    if (gate || !raw || !ren) return rec.untestable('A-5.1', id, gate ?? 'Extraction was not available for both profiles.');
    const rawAll = allVisibleText(p.raw.text);
    const blocks = ren.main_text.split('\n').map((b) => norm(b)).filter((b) => b.length >= 40);
    const total = blocks.reduce((a, b) => a + b.length, 0);
    const missing = blocks.filter((b) => !rawAll.includes(b.toLowerCase()) && !rawAll.includes(b.toLowerCase().slice(0, 60)));
    const missingChars = missing.reduce((a, b) => a + b.length, 0);
    const method = `extraction: RAW ${raw.main_text_method} (${raw.main_text_confidence}), RENDERED ${ren.main_text_method} (${ren.main_text_confidence})`;
    const ev = rec.ev({
      url: p.rec.url, profile: 'RAW', locator: 'primary text, RAW versus RENDERED',
      observed: `RAW primary text ${raw.word_count} words; RENDERED primary text ${ren.word_count} words; ${blocks.length - missing.length} of ${blocks.length} rendered text blocks found in the RAW document; ${method}`,
      expected: 'the main copy is present in the server HTML', body_ref: p.raw.record.body_ref,
    });
    if (ren.main_text_confidence === 'low') {
      return rec.untestable('A-5.1', id, `Extractor uncertainty: the main content area could not be identified with confidence (${ren.main_text_method}). The evidence is shown, but no claim is made that the page is empty or JavaScript-dependent.`, [ev]);
    }
    if (total < 200) {
      return rec.result({ check_id: 'A-5.1', page_id: id, evidence: [ev], notes: [`Both profiles are short (RAW ${raw.word_count} words, RENDERED ${ren.word_count} words). No rendering dependency is inferred and no minimum word count is applied; whether the page needs more copy depends on its purpose.`] });
    }
    // "Material" is a Wellows tool policy: more than half of the rendered primary text (at least 300 characters) is absent from RAW.
    if (missingChars >= 300 && missingChars > total * 0.5) {
      const ev2 = rec.ev({ url: p.rec.url, profile: 'RENDERED', locator: 'rendered text absent from RAW', observed: missing.slice(0, 3).map((b) => `"${truncate(b, 220)}"`).join(' || '), expected: 'present in the server HTML', body_ref: p.rendered.record.dom_ref });
      return rec.result({
        check_id: 'A-5.1', page_id: id, evidence: [ev],
        findings: [rec.finding({
          check_id: 'A-5.1', status: 'WARN', reason_code: 'PRIMARY_CONTENT_REQUIRES_RENDERING', severity: 'MEDIUM', pages: [id], evidence: [ev, ev2], confidence: 'DERIVED',
          title: 'Main content appears only after JavaScript rendering', explanation: `${missing.length} of ${blocks.length} primary text blocks in the rendered page are absent from the server HTML (${Math.round((missingChars / total) * 100)}% of the rendered primary text). Google renders JavaScript, so this is a rendering dependency, not an indexing failure. The materiality threshold is a Wellows tool policy.`,
          impact: 'Systems that read the HTML without rendering receive little of the page\'s copy. Which AI crawlers render JavaScript is not documented uniformly, so no claim is made about any specific one.', action: 'Server-render or pre-render the main copy so it is present in the initial HTML response.', owner: 'Developer', effort: 'L',
        })],
      });
    }
    rec.result({ check_id: 'A-5.1', page_id: id, evidence: [ev], notes: ['Important primary text is present in this audit\'s non-rendered profile.'] });
  });

  // A-5.2 important links in RAW ----------------------------------------------------------------------------------
  await rec.guard('A-5.2', id, () => {
    if (gate || !raw || !ren) return rec.untestable('A-5.2', id, gate ?? 'Extraction was not available for both profiles.');
    const important = [...new Map(ren.links.filter((l) => l.crawlable && l.internal && l.url && (l.zone === 'nav' || l.zone === 'main')).map((l) => [l.url as string, l])).values()];
    if (!important.length) return rec.na('A-5.2', id, 'The rendered page has no navigation or main-content internal links to compare.');
    const rawSet = new Set(raw.links.filter((l) => l.crawlable).map((l) => l.url));
    const missing = important.filter((l) => !rawSet.has(l.url));
    const ev = rec.ev({ url: p.rec.url, profile: 'RAW', locator: 'navigation/main internal links, RAW versus RENDERED', observed: `${important.length - missing.length} of ${important.length} rendered navigation/main link targets are present in the RAW document`, expected: 'important links exist as <a href> in the server HTML', body_ref: p.raw.record.body_ref });
    if (missing.length >= 3 && missing.length > important.length * 0.5) {
      const ev2 = rec.ev({ url: p.rec.url, profile: 'RENDERED', locator: 'links absent from RAW', observed: missing.slice(0, 8).map((l) => `"${l.text}" -> ${l.url}`).join(' ; '), body_ref: p.rendered.record.dom_ref });
      return rec.result({
        check_id: 'A-5.2', page_id: id, evidence: [ev],
        findings: [rec.finding({
          check_id: 'A-5.2', status: 'WARN', reason_code: 'IMPORTANT_LINKS_REQUIRE_RENDERING', severity: 'MEDIUM', pages: [id], evidence: [ev, ev2], confidence: 'DERIVED',
          title: 'Navigation links appear only after JavaScript rendering', explanation: `${missing.length} of ${important.length} navigation/main internal links are inserted by JavaScript and are absent from the server HTML. They are crawlable once rendered. The materiality threshold is a Wellows tool policy.`,
          impact: 'Systems that do not render cannot follow these links to discover other pages.', action: 'Output the primary navigation as <a href> links in the initial HTML.', owner: 'Developer', effort: 'M',
        })],
      });
    }
    rec.result({ check_id: 'A-5.2', page_id: id, evidence: [ev], notes: ['Important links are present in this audit\'s non-rendered profile.'] });
  });

  // A-5.3 search-crawler robots access --------------------------------------------------------------------------------
  await rec.guard('A-5.3', id, () => {
    if (config.visibility_goal !== 'search_ai_discovery' || isIntentional(p, config)) return rec.na('A-5.3', id, 'Search/AI discovery is not the stated goal for this page or environment.');
    const rows = env.audit.site.ai_bots.filter((b) => b.scored).map((b) => ({ b, d: b.decisions.find((x) => x.page_id === id)?.decision }));
    const ev = rec.ev({ url: env.audit.site.robots.url ?? p.rec.url, profile: 'RAW', locator: `robots.txt decisions for ${new URL(p.rec.url).pathname}`, observed: rows.map((r) => `${r.b.token}: ${r.d?.decision ?? 'UNKNOWN'}${r.d?.matched_rule ? ` (${r.d.matched_rule})` : ''}`).join(' | '), expected: 'ALLOW (a wildcard allow is sufficient; no explicit group is required)' });
    const blocked = rows.filter((r) => r.d?.decision === 'DISALLOW');
    const unknown = rows.filter((r) => !r.d || r.d.decision === 'UNKNOWN');
    const notes = [ROBOTS_CAVEAT, `Bot registry ${BOT_REGISTRY_VERSION}.`];
    if (blocked.length) {
      return rec.result({
        check_id: 'A-5.3', page_id: id, evidence: [ev], notes,
        findings: [rec.finding({
          check_id: 'A-5.3', status: 'WARN', reason_code: 'SEARCH_CRAWLER_DISALLOWED', severity: 'MEDIUM', pages: [id], evidence: [ev],
          title: `robots.txt disallows ${blocked.map((r) => r.b.token).join(', ')}`, explanation: `robots.txt disallows ${blocked.map((r) => `${r.b.token} (${r.b.role})`).join(', ')} on this path. These are search/discovery crawlers, not training crawlers. ${ROBOTS_CAVEAT}`,
          impact: 'The page cannot be surfaced by the corresponding AI search product. This is a visibility trade-off when discovery is the goal.', action: 'If discovery in these products is wanted, allow these tokens. If the restriction is deliberate, no change is needed.', owner: 'SEO', effort: 'S',
        })],
      });
    }
    if (unknown.length) return rec.untestable('A-5.3', id, `Robots access is unknown for ${unknown.map((r) => r.b.token).join(', ')}: ${unknown[0].d?.reason ?? 'robots.txt was not readable'}.`, [ev]);
    rec.result({ check_id: 'A-5.3', page_id: id, evidence: [ev], notes });
  });

  // A-5.5 signal parity (unscored) ----------------------------------------------------------------------------------------
  await rec.guard('A-5.5', id, () => {
    if (gate || !raw || !ren) return rec.untestable('A-5.5', id, gate ?? 'Extraction was not available for both profiles.');
    const types = (e: typeof raw) => [...new Set(e.structured.flatMap((s) => s.types))].sort().join(', ') || '(none)';
    const rows: [string, string, string][] = [
      ['title', raw.title ?? '(none)', ren.title ?? '(none)'],
      ['H1', raw.h1[0] ?? '(none)', ren.h1[0] ?? '(none)'],
      ['canonical', raw.canonical_head[0] ?? '(none)', ren.canonical_head[0] ?? '(none)'],
      ['noindex', String(effectiveDirectives(raw).noindex), String(effectiveDirectives({ meta_robots: ren.meta_robots, x_robots_tag: raw.x_robots_tag }).noindex)],
      ['structured data types', types(raw), types(ren)],
    ];
    const diff = rows.filter((r) => r[1] !== r[2]);
    const ev = rec.ev({ url: p.rec.url, profile: 'RAW', locator: 'page signals, RAW versus RENDERED', observed: rows.map((r) => `${r[0]}: RAW ${truncate(r[1], 80)} / RENDERED ${truncate(r[2], 80)}`).join(' | ') });
    if (!diff.length) return rec.result({ check_id: 'A-5.5', page_id: id, evidence: [ev], notes: ['Title, H1, canonical, indexing directive and structured data types are the same before and after rendering.'] });
    rec.result({
      check_id: 'A-5.5', page_id: id, evidence: [ev],
      findings: [rec.finding({
        check_id: 'A-5.5', status: 'WARN', reason_code: 'SIGNALS_DIFFER_AFTER_RENDERING', severity: 'LOW', pages: [id], evidence: [ev], classification: 'ADVISORY', confidence: 'DERIVED',
        title: 'Page signals change after rendering', explanation: `These signals differ between the server HTML and the rendered page: ${diff.map((d) => d[0]).join(', ')}.`,
        impact: 'Non-rendering clients receive different page signals than rendering ones.', action: 'Where practical, output the final title, H1, canonical and structured data in the server HTML.', owner: 'Developer', effort: 'M',
      })],
    });
  });
}

/** A-5.4: policy record for training, product-control and user-triggered tokens. Never scored. */
export async function checkAiSite(env: Env) {
  const { rec, audit } = env;
  await rec.guard('A-5.4', null, () => {
    const rows = audit.site.ai_bots.filter((b) => !b.scored && b.token !== 'Googlebot');
    const home = env.pages[0];
    if (!home || !rows.length) return rec.untestable('A-5.4', null, 'No sampled page was available to evaluate robots policy.');
    const line = rows.map((b) => `${b.token}: ${b.decisions.find((d) => d.page_id === home.rec.page_id)?.decision.decision ?? 'UNKNOWN'}`).join(' | ');
    if (rows.every((b) => (b.decisions.find((d) => d.page_id === home.rec.page_id)?.decision.decision ?? 'UNKNOWN') === 'UNKNOWN')) return rec.untestable('A-5.4', null, 'robots.txt was not readable, so these policy choices are unknown.');
    const ev = rec.ev({ url: audit.site.robots.url ?? home.rec.url, profile: 'RAW', locator: `robots.txt decisions for ${new URL(home.rec.url).pathname}`, observed: line });
    rec.result({
      check_id: 'A-5.4', evidence: [ev],
      notes: [
        'These tokens express training, product-use and user-triggered access policy. They are the site owner\'s choice and do not affect either score.',
        ...BOTS.filter((b) => !b.scored && b.token !== 'Googlebot').map((b) => `${b.token} - ${b.role}: ${b.interpretation}`),
      ],
    });
  });
}
