import type { Env, PageWork } from './engine';
import { bestExtract, contentGate } from './engine';
import { featureByType, FEATURE_REGISTRY_REVIEWED, FEATURE_REGISTRY_VERSION, type FeatureDef } from '../sources/registry';
import { norm } from '../extract/html';
import { truncate } from '../util/url';
import type { Finding, StructuredItem } from '../types';

type Node = Record<string, any>;

/** Flatten JSON-LD (@graph, arrays) and Microdata/RDFa items into typed nodes. */
export function typedNodes(items: StructuredItem[]): { node: Node; types: string[]; format: string }[] {
  const out: { node: Node; types: string[]; format: string }[] = [];
  const visit = (n: any, format: string, depth: number) => {
    if (!n || typeof n !== 'object' || depth > 4) return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, format, depth + 1));
    const t = n['@type'];
    const types = typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((x) => typeof x === 'string') : [];
    if (types.length) out.push({ node: n, types, format });
    if (n['@graph']) visit(n['@graph'], format, depth + 1);
  };
  for (const it of items) if (!it.parse_error && it.data) visit(it.data, it.format, 0);
  return out;
}

function getPath(node: any, path: string): any {
  let cur: any = node;
  for (const key of path.split('.')) {
    if (Array.isArray(cur)) cur = cur[0];
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}
const present = (v: any) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length);

function missingFor(def: FeatureDef, node: Node): { required: string[]; recommended: string[] } {
  const required = def.required.filter((p) => !present(getPath(node, p)));
  for (const group of def.one_of) if (!group.some((p) => present(getPath(node, p)))) required.push(`one of ${group.join(' / ')}`);
  if (def.feature === 'Breadcrumb' && present(node.itemListElement)) {
    const list = Array.isArray(node.itemListElement) ? node.itemListElement : [node.itemListElement];
    list.forEach((li: any, i: number) => {
      if (!present(li?.name) && !present(li?.item?.name)) required.push(`itemListElement[${i}].name`);
      if (!present(li?.position)) required.push(`itemListElement[${i}].position`);
      if (i < list.length - 1 && !present(li?.item)) required.push(`itemListElement[${i}].item`);
    });
  }
  return { required, recommended: def.recommended.filter((p) => !present(getPath(node, p))) };
}

export async function checkStructured(env: Env, p: PageWork) {
  const { rec } = env;
  const id = p.rec.page_id;
  const gate = contentGate(p);
  const best = bestExtract(p);
  const skip = (cid: string) => (gate!.status === 'NOT_APPLICABLE' ? rec.na(cid, id, gate!.reason) : rec.untestable(cid, id, gate!.reason));
  const items = best?.ex.structured ?? [];
  const nodes = typedNodes(items);
  const registryNote = `Google feature registry ${FEATURE_REGISTRY_VERSION}, reviewed ${FEATURE_REGISTRY_REVIEWED}.`;

  // S-3.1 syntax -------------------------------------------------------------------------------------------
  await rec.guard('S-3.1', id, () => {
    if (gate || !best) return skip('S-3.1');
    if (!items.length) return rec.na('S-3.1', id, 'No JSON-LD, Microdata or RDFa was found on this page. Absence of markup is not an indexing problem.');
    const bad = items.filter((i) => i.parse_error);
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'structured data blocks', observed: items.map((i) => `${i.format}: ${i.parse_error ? `PARSE ERROR (${i.parse_error})` : i.types.join(', ') || 'no @type'}`).join(' | ') });
    const findings: Finding[] = [];
    if (bad.length) {
      const ev2 = rec.ev({ url: best.url, profile: best.profile, locator: 'script[type="application/ld+json"]', observed: `${bad[0].parse_error} :: ${bad[0].raw_excerpt}`, expected: 'valid JSON' });
      findings.push(rec.finding({
        check_id: 'S-3.1', status: 'FAIL', reason_code: 'STRUCTURED_DATA_PARSE_ERROR', severity: 'MEDIUM', pages: [id], evidence: [ev, ev2],
        title: 'Structured data block cannot be parsed', explanation: `${bad.length} JSON-LD block(s) contain a syntax error (${truncate(bad[0].parse_error ?? '', 120)}).`,
        impact: 'The broken block is ignored, so any rich result it was meant to support is lost. This does not affect whether the page is indexed.', action: 'Fix the JSON syntax and validate the block with the Rich Results Test.', owner: 'Developer', effort: 'S',
      }));
    }
    rec.result({ check_id: 'S-3.1', page_id: id, evidence: [ev], findings });
  });

  // S-3.2 Google feature properties ------------------------------------------------------------------------------
  await rec.guard('S-3.2', id, () => {
    if (gate || !best) return skip('S-3.2');
    const supported = nodes.map((n) => ({ n, def: n.types.map((t) => featureByType.get(t)).find(Boolean) })).filter((x): x is { n: (typeof nodes)[number]; def: FeatureDef } => !!x.def);
    if (!supported.length) {
      const found = [...new Set(nodes.flatMap((n) => n.types))];
      return rec.na('S-3.2', id, found.length ? `Markup types present (${found.join(', ')}) are valid vocabulary but are not in this tool's Google feature registry. ${registryNote}` : 'No parseable typed markup on this page.');
    }
    const findings: Finding[] = [];
    const evs: string[] = [];
    const notes = [registryNote];
    for (const { n, def } of supported) {
      const miss = missingFor(def, n.node);
      const ev = rec.ev({ url: best.url, profile: best.profile, locator: `${n.format} ${n.types.join('/')}`, observed: `properties present: ${Object.keys(n.node).filter((k) => !k.startsWith('@')).join(', ') || '(none)'}; missing required: ${miss.required.join(', ') || 'none'}; missing recommended: ${miss.recommended.join(', ') || 'none'}`, expected: `required: ${[...def.required, ...def.one_of.map((g) => g.join(' / '))].join(', ') || 'none'}` });
      evs.push(ev);
      if (miss.required.length) {
        findings.push(rec.finding({
          check_id: 'S-3.2', status: 'FAIL', reason_code: `MISSING_REQUIRED_${def.feature.toUpperCase().replace(/\s+/g, '_')}`, severity: 'MEDIUM', pages: [id], evidence: [ev], sources: [def.source_id, 'SRC-G-GALLERY'],
          title: `${def.feature} markup is missing required properties`, explanation: `Google's ${def.feature} feature requires ${miss.required.join(', ')}, which this ${n.types.join('/')} item does not provide.`,
          impact: `The page is not eligible for the ${def.feature} rich result. This is a rich-result eligibility issue only; it does not affect indexing.`, action: `Add ${miss.required.join(', ')} using values that are visible on the page.`, owner: 'Developer', effort: 'S',
        }));
      } else if (miss.recommended.length) {
        findings.push(rec.finding({
          check_id: 'S-3.2', status: 'WARN', reason_code: `MISSING_RECOMMENDED_${def.feature.toUpperCase().replace(/\s+/g, '_')}`, severity: 'LOW', pages: [id], evidence: [ev], sources: [def.source_id], classification: 'OPPORTUNITY',
          title: `${def.feature} markup could carry more recommended properties`, explanation: `Recommended properties not present: ${miss.recommended.join(', ')}. Recommended properties are optional.`,
          impact: 'A fuller item gives Google more to work with for this feature.', action: 'Add the recommended properties that apply and are visible on the page.', owner: 'Developer', effort: 'S',
        }));
      }
    }
    if (nodes.some((n) => n.types.includes('FAQPage'))) notes.push('FAQPage markup is present. Google no longer shows the FAQ rich result, so no eligibility is assessed or offered for it.');
    rec.result({ check_id: 'S-3.2', page_id: id, evidence: evs, findings, notes });
  });

  // S-3.3 markup versus visible facts ------------------------------------------------------------------------------
  await rec.guard('S-3.3', id, () => {
    if (gate || !best) return skip('S-3.3');
    const ex = best.ex;
    const hay = norm([ex.title ?? '', ...ex.headings.map((h) => h.text), ex.main_text, ...ex.links.map((l) => l.text), ...ex.images.map((i) => i.alt ?? '')].join(' ')).toLowerCase();
    const comparisons: { type: string; field: string; value: string; found: boolean }[] = [];
    for (const n of nodes) {
      const def = n.types.map((t) => featureByType.get(t)).find(Boolean);
      for (const field of def?.visible_fields ?? []) {
        const v = n.node[field];
        if (typeof v !== 'string' || !v.trim()) continue;
        const needle = norm(v).toLowerCase();
        comparisons.push({ type: n.types[0], field, value: v, found: hay.includes(needle) || hay.includes(needle.slice(0, 40)) });
      }
    }
    if (!comparisons.length) return rec.na('S-3.3', id, 'No marked-up name or headline was available to compare with visible content.');
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'marked-up value versus visible text', observed: comparisons.map((c) => `${c.type}.${c.field} = "${truncate(c.value, 90)}" -> ${c.found ? 'found in visible text' : 'NOT found in visible text'}`).join(' | '), expected: 'marked-up values appear on the page' });
    const missing = comparisons.filter((c) => !c.found);
    const findings: Finding[] = missing.length
      ? [rec.finding({
          check_id: 'S-3.3', status: 'WARN', reason_code: 'MARKUP_NOT_VISIBLE_ON_PAGE', severity: 'MEDIUM', pages: [id], evidence: [ev], confidence: 'DERIVED',
          title: 'Structured data value does not appear in the visible page', explanation: `${missing.map((c) => `${c.type}.${c.field} ("${truncate(c.value, 70)}")`).join('; ')} was not found in the page's visible text. Google's guidelines require structured data to represent content that is visible on the page. The comparison is a derived text match.`,
          impact: 'Markup that describes content users cannot see can be ignored or lead to a manual action against the structured data.', action: 'Make the marked-up value match the visible page, or correct the markup.', owner: 'Developer / content', effort: 'S',
        })]
      : [];
    rec.result({ check_id: 'S-3.3', page_id: id, evidence: [ev], findings });
  });

  // S-3.4 opportunities (unscored advisory) -----------------------------------------------------------------------------
  await rec.guard('S-3.4', id, () => {
    if (gate || !best) return skip('S-3.4');
    const have = new Set(nodes.flatMap((n) => n.types.map((t) => featureByType.get(t)?.feature)).filter(Boolean));
    const type = p.rec.page_type;
    let want: string | null = null;
    // Google recommends Organization markup on the home page or one page describing the organization, so it is
    // suggested only when no sampled page already carries it.
    const orgElsewhere = env.pages.some((o) => typedNodes(bestExtract(o)?.ex.structured ?? []).some((n) => n.types.some((t) => ['Organization', 'Local business'].includes(featureByType.get(t)?.feature ?? ''))));
    if ((type === 'homepage' || type === 'about') && !orgElsewhere) want = 'Organization';
    else if (type === 'article' && !have.has('Article')) want = 'Article';
    else if (type === 'author' && !have.has('Profile page')) want = 'Profile page';
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'observed page type and existing markup', observed: `page type (heuristic): ${type}; Google-supported features already marked up: ${[...have].join(', ') || 'none'}` });
    if (!want) return rec.result({ check_id: 'S-3.4', page_id: id, evidence: [ev], notes: ['No feature-specific markup opportunity applies to this page type. Missing markup in general is not a defect.'] });
    const h1 = best.ex.h1[0] ?? best.ex.title ?? '';
    const tpl: Record<string, object> = {
      Organization: { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${new URL(best.url).origin}/#organization`, name: 'REQUIRES VERIFIED VALUE: legal or brand name', url: `${new URL(best.url).origin}/`, logo: 'REQUIRES VERIFIED VALUE: absolute logo URL', sameAs: ['REQUIRES VERIFIED VALUE: official profile URLs'] },
      Article: { '@context': 'https://schema.org', '@type': 'Article', headline: h1 || 'REQUIRES VERIFIED VALUE: article headline', author: { '@type': 'Person', name: 'REQUIRES VERIFIED VALUE: author name', url: 'REQUIRES VERIFIED VALUE: author page URL' }, datePublished: 'REQUIRES VERIFIED VALUE: ISO 8601 date', dateModified: 'REQUIRES VERIFIED VALUE: ISO 8601 date', image: ['REQUIRES VERIFIED VALUE: image URL'] },
      'Profile page': { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: h1 || 'REQUIRES VERIFIED VALUE: person name', description: 'REQUIRES VERIFIED VALUE: byline or credential' } },
    };
    rec.result({
      check_id: 'S-3.4', page_id: id, evidence: [ev],
      findings: [rec.finding({
        check_id: 'S-3.4', status: 'WARN', reason_code: `MARKUP_OPPORTUNITY_${want.toUpperCase().replace(/\s+/g, '_')}`, severity: 'LOW', pages: [id], evidence: [ev], classification: 'OPPORTUNITY', confidence: 'DERIVED',
        sources: ['SRC-G-GALLERY', want === 'Organization' ? 'SRC-G-ORG' : want === 'Article' ? 'SRC-G-ARTICLE' : 'SRC-G-PROFILE'],
        title: `${want} markup could be added`, explanation: `This page looks like a ${type} page (heuristic from its URL) and carries no ${want} markup. ${want === 'Organization' ? 'Google recommends Organization markup on the home page or one page describing the organization; it is not needed on every page.' : `Google supports a ${want} feature for this kind of page.`} Markup never guarantees a rich result.`,
        impact: 'An optional way to state page facts explicitly. Not an indexing factor.', action: `Add ${want} JSON-LD using values that are visible on the page. The template in the appendix needs verified values before publishing.`, owner: 'Developer', effort: 'S',
        code: { label: `Template: requires verified values (${want})`, language: 'json', content: JSON.stringify(tpl[want], null, 2), is_template: true },
      })],
    });
  });
}
