import type { Candidate, PageType } from '../types';

const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|gz|rar|7z|mp4|mp3|mov|avi|webm|wav|docx?|xlsx?|pptx?|csv|xml|json|rss|atom|txt|css|js|woff2?|ttf|eot|dmg|exe|apk)$/i;
const UTILITY_SEGMENTS = /^(login|log-in|signin|sign-in|signup|sign-up|register|registration|account|my-account|cart|basket|checkout|dashboard|admin|wp-admin|wp-login\.php|search|logout|log-out|auth|oauth|password|reset-password|forgot-password|wishlist|compare|preview|feed|cdn-cgi)$/i;
const LEGAL_SEGMENTS = /^(privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|terms-of-use|cookie-policy|cookies|legal|disclaimer|imprint|impressum|gdpr|accessibility-statement|sitemap|html-sitemap|refund-policy|shipping-policy)$/i;
const FACET_KEYS = /^(sort|sortby|orderby|order|filter|filters|color|colour|size|price|min_price|max_price|brand|page|p|paged|per_page|limit|view|display|dir|facet|refine|q|s|query|search|utm_[a-z]+|gclid|fbclid|ref|replytocom|share|sessionid|sid)$/i;

const HUB_ROOTS = new Set(['blog', 'blogs', 'news', 'resources', 'insights', 'articles', 'guides', 'learn', 'library', 'case-studies', 'case-study', 'stories', 'press', 'knowledge-base', 'kb', 'help', 'docs', 'academy', 'journal', 'magazine', 'updates', 'posts', 'whitepapers', 'webinars', 'events']);
const CATEGORY_ROOTS = new Set(['category', 'categories', 'collections', 'collection', 'shop', 'store', 'catalog', 'catalogue', 'tag', 'tags', 'topics', 'topic', 'departments']);
const SERVICE_ROOTS = new Set(['services', 'service', 'solutions', 'solution', 'what-we-do', 'capabilities', 'industries', 'industry', 'use-cases', 'use-case', 'expertise', 'practice-areas', 'treatments', 'offerings', 'tours', 'destinations', 'programs', 'courses']);
const PRODUCT_ROOTS = new Set(['products', 'product', 'software', 'features', 'feature', 'platform', 'tools', 'tool', 'apps', 'app', 'integrations', 'item', 'items', 'p']);
const AUTHOR_ROOTS = new Set(['author', 'authors', 'team', 'people', 'profile', 'profiles', 'staff', 'experts', 'contributors', 'writers']);

export function segmentsOf(url: string): string[] {
  return new URL(url).pathname.split('/').filter(Boolean);
}

/** Reason a URL is not eligible for automatic selection, or null. */
export function exclusionReason(url: string): string | null {
  const u = new URL(url);
  const segs = segmentsOf(url);
  if (NON_HTML_EXT.test(u.pathname)) return 'non-HTML resource';
  const util = segs.find((s) => UTILITY_SEGMENTS.test(s));
  if (util) return `private/utility path (${util})`;
  const legal = segs.find((s) => LEGAL_SEGMENTS.test(s));
  if (legal) return `legal/utility page (${legal}); not a representative business template`;
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => /^(s|q|query|search)$/i.test(k))) return 'internal search URL';
  const facets = keys.filter((k) => FACET_KEYS.test(k));
  if (facets.length >= 1 && keys.length === facets.length) return `faceted/tracking variant (?${facets.join('&')})`;
  return null;
}

/** Heuristic page-type label from the observed path and link text. Unknown stays `other`; it is never proof of a CMS template. */
export function classifyPage(url: string, linkText = ''): PageType {
  const segs = segmentsOf(url).map((s) => s.toLowerCase().replace(/\.(html?|php|aspx?)$/, ''));
  if (segs.length === 0) return 'homepage';
  const first = segs[0];
  const last = segs[segs.length - 1];
  const has = (set: Set<string>) => segs.findIndex((s) => set.has(s));

  if (/^(pricing|plans|price|prices|plans-pricing|pricing-plans)$/.test(last)) return 'pricing';
  if (/^(about|about-us|company|who-we-are|our-story|about-company|our-company)$/.test(last)) return 'about';
  if (/^(contact|contact-us|get-in-touch|contacts)$/.test(last)) return 'contact';

  const authorAt = has(AUTHOR_ROOTS);
  if (authorAt >= 0 && authorAt < segs.length - 1) return 'author';

  const productAt = has(PRODUCT_ROOTS);
  const categoryAt = has(CATEGORY_ROOTS);
  const hubAt = has(HUB_ROOTS);
  const serviceAt = has(SERVICE_ROOTS);

  if (productAt >= 0 && productAt < segs.length - 1) return 'product';
  if (categoryAt >= 0) return 'category_hub';
  if (hubAt >= 0) return hubAt === segs.length - 1 ? 'category_hub' : 'article';
  if (serviceAt >= 0) return 'service';
  if (productAt >= 0) return 'product';
  if (authorAt >= 0) return 'category_hub';

  const t = linkText.toLowerCase();
  if (/\b(pricing|plans)\b/.test(t)) return 'pricing';
  if (/^about\b|\babout us\b/.test(t)) return 'about';
  if (/\bcontact\b/.test(t)) return 'contact';
  if (/\b(services?|solutions?)\b/.test(t) && segs.length <= 2) return 'service';
  if (/\b(products?|features?|platform)\b/.test(t) && segs.length <= 2) return 'product';
  if (/\b(blog|news|resources|insights)\b/.test(t) && segs.length === 1) return 'category_hub';
  void first;
  return 'other';
}

/** Section hubs worth one extra fetch to find representative detail pages. */
export function isSectionHub(url: string, type: PageType): boolean {
  const segs = segmentsOf(url);
  if (segs.length === 0 || segs.length > 2) return false;
  return type === 'category_hub' || type === 'service' || type === 'product';
}

const ID_NUM = /^\d+$/;
const ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_HASH = /^[0-9a-f]{16,}$/i;

function splitExt(seg: string): [string, string] {
  const m = /^(.*?)(\.[a-z0-9]{2,5})$/i.exec(seg);
  return m ? [m[1], m[2]] : [seg, ''];
}

/**
 * Deterministic path signatures. Numeric IDs, UUIDs and long hashes become wildcards, file extensions are kept,
 * and a final slug becomes a wildcard only when at least two distinct leaves were observed under the same
 * non-root parent. Locale segments are wildcarded only when `locales` holds evidence-backed prefixes.
 */
export function buildSignatures(urls: string[], locales: Set<string> = new Set()): Map<string, string> {
  const pre = new Map<string, { host: string; segs: string[]; query: string }>();
  const leaves = new Map<string, Set<string>>();
  for (const url of urls) {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).map((seg, i) => {
      const [stem, ext] = splitExt(seg);
      if (i === 0 && locales.has(seg.toLowerCase())) return '{locale}';
      if (ID_NUM.test(stem)) return `{n}${ext}`;
      if (ID_UUID.test(stem)) return `{uuid}${ext}`;
      if (ID_HASH.test(stem)) return `{hash}${ext}`;
      return seg;
    });
    const keys = [...new Set([...u.searchParams.keys()])].sort();
    pre.set(url, { host: u.host, segs, query: keys.length ? `?${keys.join('&')}` : '' });
    if (segs.length >= 2) {
      const parent = `${u.host}/${segs.slice(0, -1).join('/')}`;
      if (!leaves.has(parent)) leaves.set(parent, new Set());
      leaves.get(parent)!.add(segs[segs.length - 1]);
    }
  }
  const out = new Map<string, string>();
  for (const [url, p] of pre) {
    const segs = [...p.segs];
    if (segs.length >= 2) {
      const parent = `${p.host}/${segs.slice(0, -1).join('/')}`;
      const last = segs[segs.length - 1];
      if ((leaves.get(parent)?.size ?? 0) >= 2 && !last.startsWith('{')) {
        const [, ext] = splitExt(last);
        segs[segs.length - 1] = `{slug}${ext}`;
      }
    }
    out.set(url, `/${segs.join('/')}${p.query}`);
  }
  return out;
}

const ZONE_RANK: Record<Candidate['zone'], number> = { nav: 0, main: 1, footer: 2, other: 3 };
export const TYPE_PRIORITY: PageType[] = ['homepage', 'service', 'product', 'pricing', 'category_hub', 'article', 'author', 'about', 'contact', 'other'];

/** Deterministic ordering: link zone, business-page priority, discovery depth, then normalised URL. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    ZONE_RANK[a.zone] - ZONE_RANK[b.zone] ||
    TYPE_PRIORITY.indexOf(a.page_type) - TYPE_PRIORITY.indexOf(b.page_type) ||
    a.depth - b.depth ||
    (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
  );
}

export const SELECTION_PLAN: { type: PageType; reason: string; distinctGroup?: boolean }[] = [
  { type: 'service', reason: 'Main service/solution page' },
  { type: 'service', reason: 'Secondary service/solution page from a different observed group', distinctGroup: true },
  { type: 'product', reason: 'Product/software/detail page' },
  { type: 'pricing', reason: 'Pricing/plans page' },
  { type: 'category_hub', reason: 'Category/resource hub' },
  { type: 'article', reason: 'Article/resource detail page' },
  { type: 'author', reason: 'Author/profile page' },
  { type: 'about', reason: 'About/company page' },
];

export const FALLBACK_PROBE_PATHS = ['/about', '/about-us', '/pricing', '/plans', '/services', '/products', '/blog', '/news', '/contact'];
