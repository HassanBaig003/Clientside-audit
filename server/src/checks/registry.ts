import type { CategoryId, RuleDef, ScoreId, Scope, SourceLabel } from '../types';

export const RULE_REGISTRY_VERSION = '2026.10.0';

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  crawl_indexing: 'Crawl and indexing controls',
  onpage_links: 'Essential on-page and internal links',
  structured_international: 'Structured data and international signals',
  field_performance: 'Field performance',
  ux_accessibility: 'Initial UX and accessibility',
  https_transport: 'HTTPS and transport',
  ai_access: 'AI Access and Content Readiness',
  content_review: 'Focused content review (advisory)',
  optional_signals: 'Optional signals',
};

/** Initial Technical Health category weights (Wellows tool policy). */
export const TECH_WEIGHTS: { id: CategoryId; weight: number }[] = [
  { id: 'crawl_indexing', weight: 35 },
  { id: 'onpage_links', weight: 20 },
  { id: 'structured_international', weight: 15 },
  { id: 'field_performance', weight: 15 },
  { id: 'ux_accessibility', weight: 10 },
  { id: 'https_transport', weight: 5 },
];

/** AI Technical Accessibility buckets (Wellows tool policy). */
export const AI_BUCKETS: { id: string; label: string; weight: number }[] = [
  { id: 'raw_content', label: 'RAW primary content', weight: 60 },
  { id: 'raw_links', label: 'RAW important links', weight: 20 },
  { id: 'search_crawlers', label: 'Search-crawler robots access', weight: 20 },
];

const V = RULE_REGISTRY_VERSION;
function rule(
  check_id: string, name: string, category: CategoryId, scope: Scope, score: ScoreId | null, weight: number, source_ids: string[],
  o: { bucket?: string; label?: SourceLabel; applicability: string; deps?: string[]; evidence: string; severity: string },
): RuleDef {
  return {
    check_id, name, category, scope, score, score_bucket: o.bucket ?? (score === 'technical_health' ? category : null), weight,
    applicability: o.applicability, dependencies: o.deps ?? [], evidence_requirements: o.evidence, source_ids, source_label: o.label ?? 'DOCUMENTED',
    severity_policy: o.severity, rule_version: V,
  };
}
const T: ScoreId = 'technical_health';
const A: ScoreId = 'ai_accessibility';

export const RULES: RuleDef[] = [
  // ---- Crawl and indexing --------------------------------------------------------------------------------
  rule('C-1.1', 'robots.txt retrieval and handling', 'crawl_indexing', 'SITE', T, 1, ['SRC-G-ROBOTS', 'SRC-RFC9309'], {
    applicability: 'Always.', evidence: 'robots.txt URL, final status, parsed groups, unsupported fields.',
    severity: 'HIGH warning when robots.txt returns 5xx. Empty or missing files pass. Challenge/timeout is NOT_TESTABLE.',
  }),
  rule('C-1.2', 'Googlebot robots.txt access to sampled paths', 'crawl_indexing', 'PAGE', T, 2, ['SRC-G-ROBOTS', 'SRC-RFC9309'], {
    applicability: 'Every sampled page intended for search.', deps: ['C-1.1'], evidence: 'Matching group and longest matching rule for the sampled path.',
    severity: 'HIGH failure when an intended public page is disallowed; policy note when the restriction is intentional.',
  }),
  rule('C-1.3', 'HTTP status of the sampled page', 'crawl_indexing', 'PAGE', T, 2, ['SRC-G-HTTP'], {
    applicability: 'Every sampled page the auditor may fetch.', evidence: 'Requested URL, redirect hops, final status.',
    severity: 'HIGH failure for genuine 404/410/5xx on an intended public page. 401/403 is a warning pending context. Timeouts are NOT_TESTABLE.',
  }),
  rule('C-1.4', 'Missing-page (soft-404) handling', 'crawl_indexing', 'SITE', T, 0.5, ['SRC-G-HTTP'], {
    applicability: 'When the preferred origin is reachable.', evidence: 'One harmless nonexistent-path probe: status and response excerpt.',
    severity: 'MEDIUM warning only when a 200 response clearly presents a missing/error page. Google\'s own classification is not verified.',
  }),
  rule('C-1.5', 'Redirect behaviour', 'crawl_indexing', 'PAGE', T, 1, ['SRC-G-HTTP', 'SRC-TOOL-POLICY'], {
    applicability: 'Every sampled page with a response.', evidence: 'Server redirect hops; RAW versus RENDERED final URL.',
    severity: 'HIGH failure for loops or HTTPS downgrades. LOW warning above two hops (tool policy) or client-side divergence.',
  }),
  rule('C-1.6', 'Origin consolidation (HTTP/HTTPS, www/apex)', 'crawl_indexing', 'SITE', T, 1, ['SRC-G-CANON'], {
    applicability: 'When the origin variants can be tested.', evidence: 'Status, hops, final URL and canonical for each origin variant.',
    severity: 'LOW warning for duplicate live origins with coherent canonicals; MEDIUM warning when their canonicals conflict.',
  }),
  rule('C-1.7', 'Canonical signals', 'crawl_indexing', 'PAGE', T, 1.5, ['SRC-G-CANON'], {
    applicability: 'Valid pages.', deps: ['C-1.3'], evidence: 'RAW head, RENDERED head and HTTP Link canonical values; tested target status.',
    severity: 'MEDIUM failure for conflicting declarations or a broken target. LOW opportunity when absent. Reciprocity is never required; relative and cross-domain canonicals are valid.',
  }),
  rule('C-1.8', 'Indexing directives', 'crawl_indexing', 'PAGE', T, 2, ['SRC-G-META'], {
    applicability: 'Valid pages.', deps: ['C-1.3'], evidence: 'robots/googlebot meta tags and X-Robots-Tag values with the effective result.',
    severity: 'CRITICAL failure for an unexpected noindex on an intended search page. Intentional restrictions are policy choices. Missing index,follow is not a defect.',
  }),
  rule('C-1.9', 'Snippet controls', 'crawl_indexing', 'PAGE', null, 0, ['SRC-G-META', 'SRC-G-AI'], {
    applicability: 'Valid pages.', evidence: 'nosnippet, max-snippet and data-nosnippet with affected content.',
    severity: 'Unscored. LOW trade-off note; these are legitimate publisher controls.',
  }),
  rule('C-1.10', 'Technical indexing eligibility (derived)', 'crawl_indexing', 'PAGE', null, 0, ['SRC-G-AI', 'SRC-G-HTTP', 'SRC-G-META'], {
    applicability: 'Every sampled page.', deps: ['C-1.2', 'C-1.3', 'C-1.7', 'C-1.8'], evidence: 'Composite of access, valid response, directives, canonical and usable content.',
    severity: 'Unscored derived summary. Never a claim that the page is indexed.',
  }),
  rule('C-1.11', 'Googlebot-blocked discovered candidates', 'crawl_indexing', 'SITE', null, 0, ['SRC-G-ROBOTS'], {
    applicability: 'When discovery observed public candidates disallowed for Googlebot.', evidence: 'Candidate URLs with the matching robots rule.',
    severity: 'Unscored MEDIUM warning to confirm intent.',
  }),
  rule('C-1.12', 'Parent sitemap endpoint (HTTP behaviour only)', 'crawl_indexing', 'SITE', T, 0.5, ['SRC-G-SITEMAP', 'SRC-TOOL-POLICY'], {
    applicability: 'Always.', deps: ['C-1.1'], evidence: 'Variant matrix: requested URL, initial status, hops, final URL, final status, result.',
    severity: 'MEDIUM failure for a broken explicitly declared endpoint (endpoint configuration, not an indexing failure). LOW opportunity when none is found. No XML is parsed.',
  }),
  // ---- On-page and internal links ------------------------------------------------------------------------
  rule('O-2.1', 'Title element', 'onpage_links', 'PAGE', T, 1.5, ['SRC-G-TITLE'], {
    applicability: 'Valid pages.', evidence: 'Exact RAW and RENDERED title values.', severity: 'MEDIUM failure when missing or empty. Never failed on length.',
  }),
  rule('O-2.2', 'Meta description', 'onpage_links', 'PAGE', T, 0.5, ['SRC-G-SNIPPET'], {
    applicability: 'Valid pages.', evidence: 'Exact meta description values.', severity: 'LOW opportunity when missing; Google can generate snippets from page content.',
  }),
  rule('O-2.3', 'Main heading (H1)', 'onpage_links', 'PAGE', T, 0.5, ['SRC-W3C-STRUCT', 'SRC-TOOL-POLICY'], {
    applicability: 'Valid pages.', evidence: 'Visible H1 values.', severity: 'LOW opportunity when missing. Multiple H1s and level skips are never failures.',
  }),
  rule('O-2.4', 'Exact title/description duplication within the sample', 'onpage_links', 'SAMPLE', T, 0.5, ['SRC-G-TITLE', 'SRC-G-SNIPPET'], {
    applicability: 'Two or more valid sampled pages.', evidence: 'Duplicate value, affected URLs and the evaluated denominator.',
    severity: 'LOW warning scoped to the evaluated sample only.',
  }),
  rule('O-2.5', 'Page-level crawlable internal links', 'onpage_links', 'PAGE', T, 1, ['SRC-G-LINKS'], {
    applicability: 'Valid pages, including single-page samples.', evidence: 'Crawlable internal anchors; navigation controls with an observed destination and no crawlable alternative.',
    severity: 'MEDIUM warning for navigation without a usable anchor. Relative URLs are valid.',
  }),
  rule('O-2.6', 'Internal link targets (bounded)', 'onpage_links', 'SAMPLE', T, 1, ['SRC-G-HTTP', 'SRC-G-LINKS'], {
    applicability: 'When valid pages expose internal links.', evidence: 'Status of up to 20 unique tested targets.',
    severity: 'MEDIUM failure for broken tested targets; LOW efficiency opportunity for redirects. No orphan or link-distribution claims.',
  }),
  // ---- Structured data and international ------------------------------------------------------------------
  rule('S-3.1', 'Structured data syntax', 'structured_international', 'PAGE', T, 1, ['SRC-G-SDPOLICY', 'SRC-SCHEMA'], {
    applicability: 'Pages that contain JSON-LD, Microdata or RDFa.', evidence: 'Parser error and markup excerpt.', severity: 'MEDIUM failure for unparseable markup (feature eligibility, not indexing).',
  }),
  rule('S-3.2', 'Google feature properties for existing markup', 'structured_international', 'PAGE', T, 1, ['SRC-G-GALLERY'], {
    applicability: 'Pages whose markup uses a type in the Google feature registry.', deps: ['S-3.1'], evidence: 'Missing required/recommended properties per the versioned feature registry.',
    severity: 'MEDIUM failure for missing required properties of a specific rich-result feature; LOW warning for recommended properties. Never an indexing failure.',
  }),
  rule('S-3.3', 'Markup matches visible page facts', 'structured_international', 'PAGE', T, 1, ['SRC-G-SDPOLICY'], {
    applicability: 'Pages with parseable markup carrying a comparable name/headline.', deps: ['S-3.1'], evidence: 'Marked-up value versus visible text.',
    severity: 'MEDIUM warning (derived comparison).',
  }),
  rule('S-3.4', 'Structured data opportunities', 'structured_international', 'PAGE', null, 0, ['SRC-G-GALLERY'], {
    label: 'TOOL_POLICY', applicability: 'Only where the observed page supports a Google-supported feature.', evidence: 'Observed page type and existing markup types.',
    severity: 'Unscored advisory. Generic absence of markup is never a failure. FAQ eligibility is not offered.',
  }),
  rule('S-3.5', 'Hreflang annotations', 'structured_international', 'PAGE', T, 1, ['SRC-G-HREFLANG'], {
    applicability: 'Pages with observed language/region annotations in HTML or HTTP headers.', evidence: 'Declared codes, self-reference, return links from up to 10 fetched alternates, target status.',
    severity: 'MEDIUM failure for invalid codes, missing return links or broken targets within the tested set. x-default is optional. Sitemap-only hreflang cannot be validated.',
  }),
  // ---- Performance -----------------------------------------------------------------------------------------
  rule('P-4.1', 'Core Web Vitals field data (URL level)', 'field_performance', 'PAGE', T, 1, ['SRC-WEBVITALS', 'SRC-CRUX'], {
    applicability: 'Valid pages.', evidence: 'CrUX URL-level p75 LCP, INP and CLS with collection period and form factor.',
    severity: 'HIGH failure for a poor metric; MEDIUM warning for needs-improvement. Missing data is NOT_TESTABLE, never "poor".',
  }),
  rule('P-4.2', 'Origin-level field data (context)', 'field_performance', 'SITE', null, 0, ['SRC-CRUX'], {
    applicability: 'Always.', evidence: 'CrUX origin-level p75 values.', severity: 'Unscored context; never presented as a specific page\'s result.',
  }),
  rule('P-4.3', 'Mobile lab diagnostics', 'field_performance', 'PAGE', null, 0, ['SRC-WEBVITALS', 'SRC-TOOL-POLICY'], {
    label: 'TOOL_POLICY', applicability: 'Homepage and at most two other representative pages.', evidence: 'Measured LCP, CLS, TBT, LCP resource, blocking resources, run environment.',
    severity: 'Unscored. Lab data never decides the field verdict; TBT is not INP.',
  }),
  // ---- AI access -------------------------------------------------------------------------------------------
  rule('A-5.1', 'Primary content available without rendering (RAW)', 'ai_access', 'PAGE', A, 1, ['SRC-G-JS', 'SRC-TOOL-POLICY'], {
    bucket: 'raw_content', label: 'TOOL_POLICY', applicability: 'Pages with a genuine RAW and a genuine RENDERED profile.', evidence: 'Quoted primary text present in RENDERED and absent from RAW; extraction method and confidence.',
    severity: 'MEDIUM rendering-dependency warning. No word-count minimum, no mandatory noscript, no fixed ratio rule.',
  }),
  rule('A-5.2', 'Important links available without rendering (RAW)', 'ai_access', 'PAGE', A, 1, ['SRC-G-LINKS', 'SRC-TOOL-POLICY'], {
    bucket: 'raw_links', label: 'TOOL_POLICY', applicability: 'Pages with a genuine RAW and a genuine RENDERED profile.', evidence: 'Navigation/main internal links present in RENDERED and absent from RAW.',
    severity: 'MEDIUM rendering-dependency warning.',
  }),
  rule('A-5.3', 'Search-crawler robots.txt access', 'ai_access', 'PAGE', A, 1, ['SRC-OPENAI', 'SRC-PERPLEXITY', 'SRC-ANTHROPIC'], {
    bucket: 'search_crawlers', applicability: 'Sampled pages when search/AI discovery is the visibility goal.', evidence: 'ALLOW/DISALLOW/UNKNOWN with the matching rule for OAI-SearchBot, PerplexityBot and Claude-SearchBot.',
    severity: 'MEDIUM visibility trade-off warning. Robots-level access only; it cannot show that vendor IPs pass a CDN or WAF.',
  }),
  rule('A-5.4', 'Training, product-control and user-triggered tokens', 'ai_access', 'SITE', null, 0, ['SRC-OPENAI', 'SRC-ANTHROPIC', 'SRC-PERPLEXITY', 'SRC-G-CRAWLERS'], {
    applicability: 'Always.', evidence: 'Robots decisions for GPTBot, ClaudeBot, Google-Extended and user-triggered agents.',
    severity: 'Unscored policy record. Blocking training crawlers never lowers any score.',
  }),
  rule('A-5.5', 'RAW versus RENDERED signal parity', 'ai_access', 'PAGE', null, 0, ['SRC-G-JS', 'SRC-G-CANON'], {
    label: 'TOOL_POLICY', applicability: 'Pages with a genuine RAW and a genuine RENDERED profile.', evidence: 'Title/H1, canonical, indexing directives and structured data types in each profile.',
    severity: 'Unscored LOW note when signals exist only after rendering.',
  }),
  // ---- UX and accessibility ---------------------------------------------------------------------------------
  rule('U-7.1', 'Mobile viewport configuration', 'ux_accessibility', 'PAGE', T, 1, ['SRC-WEBDEV-VIEWPORT'], {
    applicability: 'Valid pages.', evidence: 'meta viewport value.', severity: 'MEDIUM failure when absent; LOW warning when zoom is disabled.',
  }),
  rule('U-7.2', 'Viewport overflow at 412 px', 'ux_accessibility', 'PAGE', T, 1, ['SRC-WEBDEV-VIEWPORT'], {
    applicability: 'Pages with a genuine RENDERED profile.', evidence: 'Measured scroll width, offending elements, screenshot.', severity: 'MEDIUM warning.',
  }),
  rule('U-7.3', 'Automated accessibility checks (bounded)', 'ux_accessibility', 'PAGE', T, 1, ['SRC-W3C-IMG', 'SRC-W3C-LABELS'], {
    applicability: 'Pages with a genuine RENDERED profile.', evidence: 'axe-core rule, element target and markup.',
    severity: 'MEDIUM warning for high-confidence automated findings. Manual-review items are not failures. Not a WCAG conformance claim.',
  }),
  rule('U-7.4', 'Landmarks and heading structure (advisory)', 'ux_accessibility', 'PAGE', null, 0, ['SRC-W3C-STRUCT'], {
    label: 'TOOL_POLICY', applicability: 'Valid pages.', evidence: 'Observed landmark elements and heading outline.', severity: 'Unscored advisory; a div-based layout is not an SEO failure.',
  }),
  // ---- HTTPS and transport ----------------------------------------------------------------------------------
  rule('T-8.1', 'HTTPS and TLS', 'https_transport', 'SITE', T, 2, ['SRC-G-CANON'], {
    applicability: 'Always.', evidence: 'HTTPS response or the TLS error returned.', severity: 'HIGH failure for an invalid certificate or no HTTPS.',
  }),
  rule('T-8.2', 'Mixed content', 'https_transport', 'PAGE', T, 1, ['SRC-W3C-MIXED'], {
    applicability: 'HTTPS pages with a genuine RENDERED profile.', evidence: 'The actual http:// subresource references.', severity: 'MEDIUM warning; HIGH when active content is affected.',
  }),
  rule('T-8.3', 'Security headers (informational)', 'https_transport', 'SITE', null, 0, ['SRC-TOOL-POLICY'], {
    label: 'TOOL_POLICY', applicability: 'When the homepage responds.', evidence: 'Observed response headers.', severity: 'Unscored hardening note. Not a penetration test and not an indexing signal.',
  }),
  // ---- Optional ---------------------------------------------------------------------------------------------
  rule('X-9.1', 'llms.txt (optional)', 'optional_signals', 'SITE', null, 0, ['SRC-LLMSTXT', 'SRC-G-AI'], {
    label: 'PROPOSED_SPEC', applicability: 'Always.', evidence: 'One fetch of /llms.txt on the observed origin.', severity: 'Unscored. Absence is not an SEO failure; presence does not prove AI inclusion.',
  }),
];

export const ruleById = new Map(RULES.map((r) => [r.check_id, r]));
