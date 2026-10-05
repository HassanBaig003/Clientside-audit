import * as cheerio from 'cheerio';
import type { Extracted, HreflangObs, LinkObs, StructuredItem } from '../types';
import { tryUrl, isAliasHost, truncate } from '../util/url';

type $ = cheerio.CheerioAPI;

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'object', 'embed', 'select', 'option', 'head', 'title', 'meta', 'link']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'blockquote', 'pre', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'form', 'header', 'footer', 'address', 'br', 'hr', 'details', 'summary', 'aside', 'nav', 'body',
]);
const BOILERPLATE_SELECTOR = [
  'nav', 'footer', 'aside', '[role="navigation"]', '[role="contentinfo"]', '[role="complementary"]', '[role="dialog"]', '[role="alertdialog"]',
  '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]', '[class*="gdpr" i]', '[id*="onetrust" i]', '[class*="newsletter-popup" i]',
].join(',');
const HIDDEN_SELECTOR = '[data-wa-hidden], [hidden], [aria-hidden="true"], [style*="display:none" i], [style*="display: none" i], [style*="visibility:hidden" i], [style*="visibility: hidden" i]';

export function norm(s: string): string {
  return s.replace(/[ ​‌‍﻿]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Split a subtree into text blocks at block-level boundaries. */
export function textBlocks($root: cheerio.Cheerio<any>): string[] {
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    const t = norm(buf);
    if (t) out.push(t);
    buf = '';
  };
  const walk = (node: any) => {
    for (const child of node.children ?? []) {
      if (child.type === 'text') buf += child.data;
      else if (child.type === 'tag') {
        const tag = child.name.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        if (BLOCK_TAGS.has(tag)) {
          flush();
          walk(child);
          flush();
        } else walk(child);
      }
    }
  };
  $root.each((_, el) => walk(el));
  flush();
  return out;
}

export interface MainText {
  blocks: string[];
  text: string;
  method: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Primary-content extraction: keep substantive copy, drop navigation/footer repetition, hidden templates,
 * consent UI and unrelated boilerplate. The method and a confidence level are recorded with the result.
 */
export function extractMainText(html: string): MainText {
  const $ = cheerio.load(html);
  $(HIDDEN_SELECTOR).remove();
  $('script,style,noscript,template').remove();
  const bodyAll = norm($('body').text());

  let method = 'body-minus-boilerplate';
  let $root: cheerio.Cheerio<any> = $('main, [role="main"]').first();
  if ($root.length) method = 'landmark:main';
  else {
    const articles = $('article');
    if (articles.length === 1) {
      $root = articles.first();
      method = 'landmark:article';
    } else {
      $root = $('body');
    }
  }
  $root.find(BOILERPLATE_SELECTOR).remove();
  if (method === 'body-minus-boilerplate') {
    // Without a main landmark, a top-level <header> is site chrome; headers inside sections are content.
    $root.children('header, [role="banner"]').remove();
  }
  let blocks = textBlocks($root);
  let text = blocks.join('\n');

  let confidence: MainText['confidence'] = method === 'body-minus-boilerplate' ? 'medium' : 'high';
  // A landmark holding almost none of the page's text means the landmark is not where the content lives.
  if (method !== 'body-minus-boilerplate' && text.length < 200 && bodyAll.length > text.length * 4 + 400) {
    const $body = cheerio.load(html);
    $body(HIDDEN_SELECTOR).remove();
    $body('script,style,noscript,template').remove();
    $body('body').find(BOILERPLATE_SELECTOR).remove();
    $body('body').children('header, [role="banner"]').remove();
    blocks = textBlocks($body('body'));
    text = blocks.join('\n');
    method = 'body-minus-boilerplate (main landmark held little text)';
    confidence = 'low';
  } else if (text.length < 80 && bodyAll.length > 600) {
    confidence = 'low';
  }
  return { blocks, text, method, confidence };
}

function zoneOf($: $, el: any): LinkObs['zone'] {
  const anc = $(el).closest('nav, [role="navigation"], header, [role="banner"], footer, [role="contentinfo"], main, [role="main"], article');
  if (!anc.length) return 'other';
  const a = anc[0] as any;
  const tag = a.name.toLowerCase();
  const role = (a.attribs?.role ?? '').toLowerCase();
  if (tag === 'nav' || role === 'navigation' || tag === 'header' || role === 'banner') return 'nav';
  if (tag === 'footer' || role === 'contentinfo') return 'footer';
  return 'main';
}

function parseLinkHeader(value: string | undefined): { url: string; params: Record<string, string> }[] {
  if (!value) return [];
  const out: { url: string; params: Record<string, string> }[] = [];
  for (const part of value.split(/\n|,(?=\s*<)/)) {
    const m = /<([^>]*)>\s*(.*)$/s.exec(part.trim());
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const p of m[2].split(';')) {
      const kv = /^\s*([\w-]+)\s*=\s*"?([^"]*)"?\s*$/.exec(p);
      if (kv) params[kv[1].toLowerCase()] = kv[2];
    }
    out.push({ url: m[1].trim(), params });
  }
  return out;
}

function collectTypes(node: any, acc: Set<string>, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) return node.forEach((n) => collectTypes(n, acc, depth + 1));
  const t = node['@type'];
  if (typeof t === 'string') acc.add(t);
  else if (Array.isArray(t)) t.filter((x) => typeof x === 'string').forEach((x) => acc.add(x));
  if (node['@graph']) collectTypes(node['@graph'], acc, depth + 1);
}

function microdataValue($: $, el: any): string {
  const $el = $(el);
  return norm($el.attr('content') ?? $el.attr('href') ?? $el.attr('src') ?? $el.attr('datetime') ?? $el.text());
}

function extractStructured($: $): StructuredItem[] {
  const items: StructuredItem[] = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    const raw = $(el).text() ?? '';
    const inHead = $(el).closest('head').length > 0;
    let data: unknown = null;
    let err: string | null = null;
    const types = new Set<string>();
    if (!raw.trim()) err = 'Empty JSON-LD script block';
    else {
      try {
        data = JSON.parse(raw);
        collectTypes(data, types);
      } catch (e: any) {
        err = String(e?.message ?? e);
      }
    }
    items.push({ format: 'JSON-LD', types: [...types], parse_error: err, raw_excerpt: truncate(raw, 400), data, in_head: inHead });
  });
  $('[itemscope][itemtype]').each((_, el) => {
    if ($(el).attr('itemprop') !== undefined) return; // nested item, reported through its parent
    const type = ($(el).attr('itemtype') ?? '').trim().split(/\s+/)[0];
    const name = type.replace(/^https?:\/\/schema\.org\//i, '');
    const data: Record<string, unknown> = { '@type': name };
    $(el)
      .find('[itemprop]')
      .each((__, p) => {
        const owner = $(p).parent().closest('[itemscope]');
        if (owner[0] !== el) return;
        const key = ($(p).attr('itemprop') ?? '').split(/\s+/)[0];
        if (!key) return;
        data[key] = $(p).attr('itemscope') !== undefined ? { '@type': ($(p).attr('itemtype') ?? '').replace(/^https?:\/\/schema\.org\//i, '') } : microdataValue($, p);
      });
    items.push({ format: 'Microdata', types: name ? [name] : [], parse_error: null, raw_excerpt: truncate($.html(el) ?? '', 300), data, in_head: false });
  });
  $('[typeof]').each((_, el) => {
    const vocab = $(el).closest('[vocab]').attr('vocab') ?? '';
    const typeofAttr = ($(el).attr('typeof') ?? '').trim();
    if (!/schema\.org/i.test(vocab) && !/^schema:/i.test(typeofAttr)) return;
    if ($(el).attr('property') !== undefined) return;
    const name = typeofAttr.split(/\s+/)[0].replace(/^schema:/i, '');
    const data: Record<string, unknown> = { '@type': name };
    $(el)
      .find('[property]')
      .each((__, p) => {
        const owner = $(p).parent().closest('[typeof]');
        if (owner[0] !== el) return;
        const key = ($(p).attr('property') ?? '').replace(/^schema:/i, '');
        if (key) data[key] = $(p).attr('typeof') !== undefined ? { '@type': ($(p).attr('typeof') ?? '').replace(/^schema:/i, '') } : microdataValue($, p);
      });
    items.push({ format: 'RDFa', types: name ? [name] : [], parse_error: null, raw_excerpt: truncate($.html(el) ?? '', 300), data, in_head: false });
  });
  return items;
}

const NAV_DEST_RE = /(?:location(?:\.href)?\s*=|location\.assign\(|location\.replace\(|window\.open\(|navigate\(|router\.push\(|goto\()\s*['"`]([^'"`]+)['"`]/i;

export function extractPage(html: string, docUrl: string, headers: Record<string, string>): Extracted {
  const $ = cheerio.load(html);
  const docHost = new URL(docUrl).hostname;

  const baseRaw = $('head base[href]').first().attr('href') ?? null;
  const baseUrl = baseRaw ? tryUrl(baseRaw, docUrl) : null;
  const base = baseUrl && /^https?:$/.test(baseUrl.protocol) ? baseUrl.toString() : docUrl;

  const titles = $('title')
    .filter((_, el) => $(el).closest('svg').length === 0)
    .map((_, el) => norm($(el).text()))
    .get();
  const descs = $('meta[name="description" i]').map((_, el) => norm($(el).attr('content') ?? '')).get();

  const headings: Extracted['headings'] = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    if ($(el).closest('[data-wa-hidden]').length) return;
    const text = norm($(el).text());
    headings.push({ level: Number((el as any).name[1]), text });
  });

  const canonHead = $('head link[rel~="canonical" i]').map((_, el) => ($(el).attr('href') ?? '').trim()).get();
  const canonBody = $('body link[rel~="canonical" i]').map((_, el) => ($(el).attr('href') ?? '').trim()).get();
  const linkHeader = parseLinkHeader(headers['link']);
  const canonHttp = linkHeader.filter((l) => /\bcanonical\b/i.test(l.params.rel ?? '')).map((l) => l.url);

  const metaRobots: Extracted['meta_robots'] = [];
  $('meta[name]').each((_, el) => {
    const name = ($(el).attr('name') ?? '').toLowerCase().trim();
    if (name === 'robots' || name === 'googlebot' || name === 'googlebot-news' || /bot$/.test(name)) {
      metaRobots.push({ name, content: norm($(el).attr('content') ?? '').toLowerCase() });
    }
  });
  const xRobots = (headers['x-robots-tag'] ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

  const links: LinkObs[] = [];
  const crawlableTargets = new Set<string>();
  $('a').each((_, el) => {
    if (links.length >= 3000) return;
    const hrefAttr = $(el).attr('href');
    if (hrefAttr === undefined) return;
    const href = hrefAttr.trim();
    const text = norm($(el).text()) || norm($(el).attr('aria-label') ?? '') || norm($(el).find('img[alt]').attr('alt') ?? '');
    const rel = ($(el).attr('rel') ?? '').toLowerCase();
    let url: string | null = null;
    let crawlable = false;
    let reason: string | null = null;
    if (!href) reason = 'empty href';
    else if (href.startsWith('#')) reason = 'fragment-only link';
    else if (/^(mailto|tel|sms|javascript|data|blob|about|file):/i.test(href)) reason = `${href.split(':')[0].toLowerCase()}: link`;
    else {
      const u = tryUrl(href, base);
      if (!u) reason = 'unparseable href';
      else if (u.protocol !== 'http:' && u.protocol !== 'https:') reason = `${u.protocol} link`;
      else {
        u.hash = '';
        url = u.toString();
        crawlable = true;
      }
    }
    const internal = !!url && isAliasHost(new URL(url).hostname, docHost);
    if (url && crawlable) crawlableTargets.add(url);
    links.push({ href_raw: truncate(href, 300), url, text: truncate(text, 120), zone: zoneOf($, el), internal, crawlable, rel, reason });
  });

  const navControls: Extracted['nav_like_controls'] = [];
  $('[data-href],[data-url],[data-link],[routerlink],[onclick],[role="link"]').each((_, el) => {
    if (navControls.length >= 20) return;
    const $el = $(el);
    if ((el as any).name === 'a' && $el.attr('href')) return;
    if ($el.closest('a[href]').length || $el.find('a[href]').length) return;
    const dest = $el.attr('data-href') ?? $el.attr('data-url') ?? $el.attr('data-link') ?? $el.attr('routerlink') ?? NAV_DEST_RE.exec($el.attr('onclick') ?? '')?.[1];
    if (!dest) return;
    const u = tryUrl(dest, base);
    if (!u || !/^https?:$/.test(u.protocol) || !isAliasHost(u.hostname, docHost)) return;
    u.hash = '';
    if (crawlableTargets.has(u.toString())) return; // a crawlable alternative to the same destination exists
    navControls.push({ text: truncate(norm($el.text()), 80), hint: u.toString(), html: truncate($.html(el) ?? '', 220) });
  });

  const hreflang: HreflangObs[] = [];
  $('link[rel~="alternate" i][hreflang]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    hreflang.push({ hreflang: ($(el).attr('hreflang') ?? '').trim(), href: tryUrl(href, base)?.toString() ?? href, source: 'HTML' });
  });
  for (const l of linkHeader) {
    if (/\balternate\b/i.test(l.params.rel ?? '') && l.params.hreflang) {
      hreflang.push({ hreflang: l.params.hreflang, href: tryUrl(l.url, docUrl)?.toString() ?? l.url, source: 'HTTP' });
    }
  }

  const structured = extractStructured($);
  const main = extractMainText(html);

  const authorSignals = new Set<string>();
  const metaAuthor = norm($('meta[name="author" i]').attr('content') ?? '');
  if (metaAuthor) authorSignals.add(`meta author: ${metaAuthor}`);
  $('[rel~="author"], [itemprop="author"], .author, .byline, [class*="author-name" i]').slice(0, 3).each((_, el) => {
    const t = truncate(norm($(el).text()), 80);
    if (t) authorSignals.add(`byline: ${t}`);
  });
  const dateSignals = new Set<string>();
  $('time[datetime]').slice(0, 3).each((_, el) => { dateSignals.add(`time: ${$(el).attr('datetime')}`); });
  for (const p of ['article:published_time', 'article:modified_time']) {
    const v = $(`meta[property="${p}"]`).attr('content');
    if (v) dateSignals.add(`${p}: ${v}`);
  }
  const walkLd = (n: any, d = 0) => {
    if (!n || typeof n !== 'object' || d > 5) return;
    if (Array.isArray(n)) return n.forEach((x) => walkLd(x, d + 1));
    if (n.datePublished) dateSignals.add(`JSON-LD datePublished: ${String(n.datePublished)}`);
    if (n.dateModified) dateSignals.add(`JSON-LD dateModified: ${String(n.dateModified)}`);
    const a = n.author;
    const an = Array.isArray(a) ? a[0]?.name : typeof a === 'object' ? a?.name : typeof a === 'string' ? a : null;
    if (an) authorSignals.add(`JSON-LD author: ${String(an)}`);
    if (n['@graph']) walkLd(n['@graph'], d + 1);
  };
  structured.filter((s) => s.format === 'JSON-LD').forEach((s) => walkLd(s.data));

  const nosnippet = $('[data-nosnippet]');
  const landmarks = ['header', 'nav', 'main', 'footer', 'article', 'aside'].filter((t) => $(t).length > 0);

  return {
    titles,
    title: titles.find((t) => t.length > 0) ?? null,
    meta_description: descs.find((d) => d.length > 0) ?? null,
    meta_descriptions: descs,
    h1: headings.filter((h) => h.level === 1 && h.text).map((h) => h.text),
    headings: headings.filter((h) => h.text).slice(0, 80),
    canonical_head: canonHead,
    canonical_body: canonBody,
    canonical_http: canonHttp,
    meta_robots: metaRobots,
    x_robots_tag: xRobots,
    viewport_meta: $('meta[name="viewport" i]').first().attr('content') ?? null,
    html_lang: $('html').attr('lang') ?? null,
    base_href: baseRaw,
    links,
    structured,
    hreflang,
    data_nosnippet_count: nosnippet.length,
    data_nosnippet_excerpts: nosnippet.slice(0, 3).map((_, el) => truncate(norm($(el).text()), 140)).get(),
    main_text: main.text,
    main_text_method: main.method,
    main_text_confidence: main.confidence,
    word_count: main.text ? main.text.split(/\s+/).filter(Boolean).length : 0,
    noscript_present: $('noscript').length > 0,
    images: $('img').slice(0, 200).map((_, el) => ({ src: truncate($(el).attr('src') ?? $(el).attr('data-src') ?? '', 200), alt: $(el).attr('alt') ?? null })).get(),
    nav_like_controls: navControls,
    author_signals: [...authorSignals].slice(0, 5),
    date_signals: [...dateSignals].slice(0, 6),
    lists: $('main ul, main ol, article ul, article ol').length || $('ul,ol').length,
    tables: $('table').length,
    landmarks,
  };
}

/** Resolve a canonical declaration against the document, keeping relative canonicals valid. */
export function resolveCanonical(value: string, docUrl: string, baseHref: string | null): string | null {
  const base = baseHref ? tryUrl(baseHref, docUrl)?.toString() ?? docUrl : docUrl;
  const u = tryUrl(value, base);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  return u.toString();
}

export interface EffectiveDirectives {
  noindex: boolean;
  nofollow: boolean;
  nosnippet: boolean;
  max_snippet: number | null;
  none: boolean;
  sources: string[];
  tokens: string[];
}

/**
 * Effective directives for Googlebot: `robots` and `googlebot` meta tags plus X-Robots-Tag
 * (generic or googlebot-scoped) are combined and the most restrictive value applies.
 */
export function effectiveDirectives(ex: Pick<Extracted, 'meta_robots' | 'x_robots_tag'>): EffectiveDirectives {
  const out: EffectiveDirectives = { noindex: false, nofollow: false, nosnippet: false, max_snippet: null, none: false, sources: [], tokens: [] };
  const apply = (content: string, source: string) => {
    const tokens = content.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
    let used = false;
    for (const t of tokens) {
      if (t === 'noindex') (out.noindex = true), (used = true);
      else if (t === 'nofollow') (out.nofollow = true), (used = true);
      else if (t === 'none') (out.noindex = out.nofollow = out.none = true), (used = true);
      else if (t === 'nosnippet') (out.nosnippet = true), (used = true);
      else if (t.startsWith('max-snippet:')) {
        const n = Number(t.split(':')[1]);
        if (Number.isFinite(n)) {
          // -1 means "no limit"; the smallest non-negative limit is the most restrictive.
          if (n >= 0 && (out.max_snippet === null || out.max_snippet < 0 || n < out.max_snippet)) out.max_snippet = n;
          else if (out.max_snippet === null) out.max_snippet = n;
          used = true;
        }
      }
      out.tokens.push(t);
    }
    if (used) out.sources.push(source);
  };
  for (const m of ex.meta_robots) {
    if (m.name === 'robots' || m.name === 'googlebot') apply(m.content, `<meta name="${m.name}" content="${m.content}">`);
  }
  for (const h of ex.x_robots_tag) {
    const scoped = /^([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(h);
    const known = /^(noindex|nofollow|none|nosnippet|noarchive|notranslate|noimageindex|indexifembedded|all|max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i;
    if (scoped && !known.test(scoped[1])) {
      if (scoped[1].toLowerCase() === 'googlebot') apply(scoped[2], `X-Robots-Tag: ${h}`);
    } else apply(h, `X-Robots-Tag: ${h}`);
  }
  if (out.max_snippet === 0) out.nosnippet = true;
  return out;
}
