# Rule registry 2026.10.0

Generated from `server/src/checks/registry.ts` by `npm run docs`. Do not edit by hand.

Check statuses: PASS, WARN, FAIL, NOT_APPLICABLE, NOT_TESTABLE, ERROR. ERROR is a tool defect, never a website defect.

## Scoring (Wellows tool policy)

PASS = 1, WARN = 0.5, FAIL = 0. Page units are averaged inside each check, checks are combined by rule weight inside a category, categories by the weights below, normalised over categories with evaluated checks. NOT_APPLICABLE, NOT_TESTABLE, ERROR, derived composites, optional signals and lab diagnostics are excluded. The headline is withheld without a genuine evaluated page or below 50% coverage.

| Initial Technical Health category | Weight |
| --- | ---: |
| Crawl and indexing controls | 35 |
| Essential on-page and internal links | 20 |
| Structured data and international signals | 15 |
| Field performance | 15 |
| Initial UX and accessibility | 10 |
| HTTPS and transport | 5 |

| AI Technical Accessibility bucket | Weight |
| --- | ---: |
| RAW primary content | 60 |
| RAW important links | 20 |
| Search-crawler robots access | 20 |

## Crawl and indexing controls

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| C-1.1 | robots.txt retrieval and handling | SITE | technical_health | 1 | Always. | robots.txt URL, final status, parsed groups, unsupported fields. | HIGH warning when robots.txt returns 5xx. Empty or missing files pass. Challenge/timeout is NOT_TESTABLE. | SRC-G-ROBOTS, SRC-RFC9309 | DOCUMENTED |
| C-1.2 | Googlebot robots.txt access to sampled paths | PAGE | technical_health | 2 | Every sampled page intended for search. Depends on C-1.1. | Matching group and longest matching rule for the sampled path. | HIGH failure when an intended public page is disallowed; policy note when the restriction is intentional. | SRC-G-ROBOTS, SRC-RFC9309 | DOCUMENTED |
| C-1.3 | HTTP status of the sampled page | PAGE | technical_health | 2 | Every sampled page the auditor may fetch. | Requested URL, redirect hops, final status. | HIGH failure for genuine 404/410/5xx on an intended public page. 401/403 is a warning pending context. Timeouts are NOT_TESTABLE. | SRC-G-HTTP | DOCUMENTED |
| C-1.4 | Missing-page (soft-404) handling | SITE | technical_health | 0.5 | When the preferred origin is reachable. | One harmless nonexistent-path probe: status and response excerpt. | MEDIUM warning only when a 200 response clearly presents a missing/error page. Google's own classification is not verified. | SRC-G-HTTP | DOCUMENTED |
| C-1.5 | Redirect behaviour | PAGE | technical_health | 1 | Every sampled page with a response. | Server redirect hops; RAW versus RENDERED final URL. | HIGH failure for loops or HTTPS downgrades. LOW warning above two hops (tool policy) or client-side divergence. | SRC-G-HTTP, SRC-TOOL-POLICY | DOCUMENTED |
| C-1.6 | Origin consolidation (HTTP/HTTPS, www/apex) | SITE | technical_health | 1 | When the origin variants can be tested. | Status, hops, final URL and canonical for each origin variant. | LOW warning for duplicate live origins with coherent canonicals; MEDIUM warning when their canonicals conflict. | SRC-G-CANON | DOCUMENTED |
| C-1.7 | Canonical signals | PAGE | technical_health | 1.5 | Valid pages. Depends on C-1.3. | RAW head, RENDERED head and HTTP Link canonical values; tested target status. | MEDIUM failure for conflicting declarations or a broken target. LOW opportunity when absent. Reciprocity is never required; relative and cross-domain canonicals are valid. | SRC-G-CANON | DOCUMENTED |
| C-1.8 | Indexing directives | PAGE | technical_health | 2 | Valid pages. Depends on C-1.3. | robots/googlebot meta tags and X-Robots-Tag values with the effective result. | CRITICAL failure for an unexpected noindex on an intended search page. Intentional restrictions are policy choices. Missing index,follow is not a defect. | SRC-G-META | DOCUMENTED |
| C-1.9 | Snippet controls | PAGE | unscored | - | Valid pages. | nosnippet, max-snippet and data-nosnippet with affected content. | Unscored. LOW trade-off note; these are legitimate publisher controls. | SRC-G-META, SRC-G-AI | DOCUMENTED |
| C-1.10 | Technical indexing eligibility (derived) | PAGE | unscored | - | Every sampled page. Depends on C-1.2, C-1.3, C-1.7, C-1.8. | Composite of access, valid response, directives, canonical and usable content. | Unscored derived summary. Never a claim that the page is indexed. | SRC-G-AI, SRC-G-HTTP, SRC-G-META | DOCUMENTED |
| C-1.11 | Googlebot-blocked discovered candidates | SITE | unscored | - | When discovery observed public candidates disallowed for Googlebot. | Candidate URLs with the matching robots rule. | Unscored MEDIUM warning to confirm intent. | SRC-G-ROBOTS | DOCUMENTED |
| C-1.12 | Parent sitemap endpoint (HTTP behaviour only) | SITE | technical_health | 0.5 | Always. Depends on C-1.1. | Variant matrix: requested URL, initial status, hops, final URL, final status, result. | MEDIUM failure for a broken explicitly declared endpoint (endpoint configuration, not an indexing failure). LOW opportunity when none is found. No XML is parsed. | SRC-G-SITEMAP, SRC-TOOL-POLICY | DOCUMENTED |

## Essential on-page and internal links

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| O-2.1 | Title element | PAGE | technical_health | 1.5 | Valid pages. | Exact RAW and RENDERED title values. | MEDIUM failure when missing or empty. Never failed on length. | SRC-G-TITLE | DOCUMENTED |
| O-2.2 | Meta description | PAGE | technical_health | 0.5 | Valid pages. | Exact meta description values. | LOW opportunity when missing; Google can generate snippets from page content. | SRC-G-SNIPPET | DOCUMENTED |
| O-2.3 | Main heading (H1) | PAGE | technical_health | 0.5 | Valid pages. | Visible H1 values. | LOW opportunity when missing. Multiple H1s and level skips are never failures. | SRC-W3C-STRUCT, SRC-TOOL-POLICY | DOCUMENTED |
| O-2.4 | Exact title/description duplication within the sample | SAMPLE | technical_health | 0.5 | Two or more valid sampled pages. | Duplicate value, affected URLs and the evaluated denominator. | LOW warning scoped to the evaluated sample only. | SRC-G-TITLE, SRC-G-SNIPPET | DOCUMENTED |
| O-2.5 | Page-level crawlable internal links | PAGE | technical_health | 1 | Valid pages, including single-page samples. | Crawlable internal anchors; navigation controls with an observed destination and no crawlable alternative. | MEDIUM warning for navigation without a usable anchor. Relative URLs are valid. | SRC-G-LINKS | DOCUMENTED |
| O-2.6 | Internal link targets (bounded) | SAMPLE | technical_health | 1 | When valid pages expose internal links. | Status of up to 20 unique tested targets. | MEDIUM failure for broken tested targets; LOW efficiency opportunity for redirects. No orphan or link-distribution claims. | SRC-G-HTTP, SRC-G-LINKS | DOCUMENTED |

## Structured data and international signals

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| S-3.1 | Structured data syntax | PAGE | technical_health | 1 | Pages that contain JSON-LD, Microdata or RDFa. | Parser error and markup excerpt. | MEDIUM failure for unparseable markup (feature eligibility, not indexing). | SRC-G-SDPOLICY, SRC-SCHEMA | DOCUMENTED |
| S-3.2 | Google feature properties for existing markup | PAGE | technical_health | 1 | Pages whose markup uses a type in the Google feature registry. Depends on S-3.1. | Missing required/recommended properties per the versioned feature registry. | MEDIUM failure for missing required properties of a specific rich-result feature; LOW warning for recommended properties. Never an indexing failure. | SRC-G-GALLERY | DOCUMENTED |
| S-3.3 | Markup matches visible page facts | PAGE | technical_health | 1 | Pages with parseable markup carrying a comparable name/headline. Depends on S-3.1. | Marked-up value versus visible text. | MEDIUM warning (derived comparison). | SRC-G-SDPOLICY | DOCUMENTED |
| S-3.4 | Structured data opportunities | PAGE | unscored | - | Only where the observed page supports a Google-supported feature. | Observed page type and existing markup types. | Unscored advisory. Generic absence of markup is never a failure. FAQ eligibility is not offered. | SRC-G-GALLERY | TOOL_POLICY |
| S-3.5 | Hreflang annotations | PAGE | technical_health | 1 | Pages with observed language/region annotations in HTML or HTTP headers. | Declared codes, self-reference, return links from up to 10 fetched alternates, target status. | MEDIUM failure for invalid codes, missing return links or broken targets within the tested set. x-default is optional. Sitemap-only hreflang cannot be validated. | SRC-G-HREFLANG | DOCUMENTED |

## Field performance

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| P-4.1 | Core Web Vitals field data (URL level) | PAGE | technical_health | 1 | Valid pages. | CrUX URL-level p75 LCP, INP and CLS with collection period and form factor. | HIGH failure for a poor metric; MEDIUM warning for needs-improvement. Missing data is NOT_TESTABLE, never "poor". | SRC-WEBVITALS, SRC-CRUX | DOCUMENTED |
| P-4.2 | Origin-level field data (context) | SITE | unscored | - | Always. | CrUX origin-level p75 values. | Unscored context; never presented as a specific page's result. | SRC-CRUX | DOCUMENTED |
| P-4.3 | Mobile lab diagnostics | PAGE | unscored | - | Homepage and at most two other representative pages. | Measured LCP, CLS, TBT, LCP resource, blocking resources, run environment. | Unscored. Lab data never decides the field verdict; TBT is not INP. | SRC-WEBVITALS, SRC-TOOL-POLICY | TOOL_POLICY |

## Initial UX and accessibility

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| U-7.1 | Mobile viewport configuration | PAGE | technical_health | 1 | Valid pages. | meta viewport value. | MEDIUM failure when absent; LOW warning when zoom is disabled. | SRC-WEBDEV-VIEWPORT | DOCUMENTED |
| U-7.2 | Viewport overflow at 412 px | PAGE | technical_health | 1 | Pages with a genuine RENDERED profile. | Measured scroll width, offending elements, screenshot. | MEDIUM warning. | SRC-WEBDEV-VIEWPORT | DOCUMENTED |
| U-7.3 | Automated accessibility checks (bounded) | PAGE | technical_health | 1 | Pages with a genuine RENDERED profile. | axe-core rule, element target and markup. | MEDIUM warning for high-confidence automated findings. Manual-review items are not failures. Not a WCAG conformance claim. | SRC-W3C-IMG, SRC-W3C-LABELS | DOCUMENTED |
| U-7.4 | Landmarks and heading structure (advisory) | PAGE | unscored | - | Valid pages. | Observed landmark elements and heading outline. | Unscored advisory; a div-based layout is not an SEO failure. | SRC-W3C-STRUCT | TOOL_POLICY |

## HTTPS and transport

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| T-8.1 | HTTPS and TLS | SITE | technical_health | 2 | Always. | HTTPS response or the TLS error returned. | HIGH failure for an invalid certificate or no HTTPS. | SRC-G-CANON | DOCUMENTED |
| T-8.2 | Mixed content | PAGE | technical_health | 1 | HTTPS pages with a genuine RENDERED profile. | The actual http:// subresource references. | MEDIUM warning; HIGH when active content is affected. | SRC-W3C-MIXED | DOCUMENTED |
| T-8.3 | Security headers (informational) | SITE | unscored | - | When the homepage responds. | Observed response headers. | Unscored hardening note. Not a penetration test and not an indexing signal. | SRC-TOOL-POLICY | TOOL_POLICY |

## AI Access and Content Readiness

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| A-5.1 | Primary content available without rendering (RAW) | PAGE | ai_accessibility | 1 | Pages with a genuine RAW and a genuine RENDERED profile. | Quoted primary text present in RENDERED and absent from RAW; extraction method and confidence. | MEDIUM rendering-dependency warning. No word-count minimum, no mandatory noscript, no fixed ratio rule. | SRC-G-JS, SRC-TOOL-POLICY | TOOL_POLICY |
| A-5.2 | Important links available without rendering (RAW) | PAGE | ai_accessibility | 1 | Pages with a genuine RAW and a genuine RENDERED profile. | Navigation/main internal links present in RENDERED and absent from RAW. | MEDIUM rendering-dependency warning. | SRC-G-LINKS, SRC-TOOL-POLICY | TOOL_POLICY |
| A-5.3 | Search-crawler robots.txt access | PAGE | ai_accessibility | 1 | Sampled pages when search/AI discovery is the visibility goal. | ALLOW/DISALLOW/UNKNOWN with the matching rule for OAI-SearchBot, PerplexityBot and Claude-SearchBot. | MEDIUM visibility trade-off warning. Robots-level access only; it cannot show that vendor IPs pass a CDN or WAF. | SRC-OPENAI, SRC-PERPLEXITY, SRC-ANTHROPIC | DOCUMENTED |
| A-5.4 | Training, product-control and user-triggered tokens | SITE | unscored | - | Always. | Robots decisions for GPTBot, ClaudeBot, Google-Extended and user-triggered agents. | Unscored policy record. Blocking training crawlers never lowers any score. | SRC-OPENAI, SRC-ANTHROPIC, SRC-PERPLEXITY, SRC-G-CRAWLERS | DOCUMENTED |
| A-5.5 | RAW versus RENDERED signal parity | PAGE | unscored | - | Pages with a genuine RAW and a genuine RENDERED profile. | Title/H1, canonical, indexing directives and structured data types in each profile. | Unscored LOW note when signals exist only after rendering. | SRC-G-JS, SRC-G-CANON | TOOL_POLICY |

## Optional signals

| ID | Check | Scope | Score | Weight | Applicability | Evidence required | Severity policy | Sources | Basis |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| X-9.1 | llms.txt (optional) | SITE | unscored | - | Always. | One fetch of /llms.txt on the observed origin. | Unscored. Absence is not an SEO failure; presence does not prove AI inclusion. | SRC-LLMSTXT, SRC-G-AI | PROPOSED_SPEC |

