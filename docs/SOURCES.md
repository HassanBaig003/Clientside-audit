# Source registry

Generated from `server/src/sources/registry.ts` by `npm run docs`. Registry reviewed: 2026-10-05.

Reviewing sources is a product maintenance task. Vendor documentation is not fetched during client audits. A "seeded" review note means the claim was taken from the builder prompt's registry and was not re-fetched in the build session; re-check those before relying on them for a FAIL.

| ID | Source | Label | Supports | Reviewed |
| --- | --- | --- | --- | --- |
| SRC-G-AI | [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) | DOCUMENTED | AI Overviews/AI Mode need a page that is indexed and snippet-eligible; no new machine-readable files, AI text files or special schema are required. nosnippet, data-nosnippet, max-snippet, noindex and Google-Extended are the applicable controls. | 2026-10-05 |
| SRC-G-ROBOTS | [Google: How Google interprets the robots.txt specification](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec) | DOCUMENTED | Most specific user-agent group; rules of matching groups are combined; longest path wins and the least restrictive rule wins a tie; * and $ wildcards; 4xx other than 429 means no restrictions; 5xx pauses crawling; 500 KiB limit; only user-agent/allow/disallow/sitemap are supported. | 2026-10-05 |
| SRC-RFC9309 | [RFC 9309: Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309) | DOCUMENTED | Group selection, longest-match precedence and status handling of the Robots Exclusion Protocol. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-HTTP | [Google: HTTP status codes and Google crawlers](https://developers.google.com/crawling/docs/troubleshooting/http-status-codes) | DOCUMENTED | Content from 4xx URLs is not used; 5xx slows crawling and content is eventually dropped; up to 10 redirect hops; soft 404 is a 2xx response whose content suggests an error or is empty. | 2026-10-05 |
| SRC-G-CANON | [Google: Consolidate duplicate URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) | DOCUMENTED | rel=canonical belongs in the head; relative paths are supported though absolute is advised; do not declare different canonicals via different techniques; HTTPS is preferred; specifying a canonical is not required. | 2026-10-05 |
| SRC-G-META | [Google: Robots meta tag, data-nosnippet and X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) | DOCUMENTED | Rules from multiple tags/headers combine and the more restrictive applies; max-snippet:0 equals nosnippet; nosnippet also prevents use as direct input for AI Overviews; rules on a robots.txt-blocked page are not seen. | 2026-10-05 |
| SRC-G-JS | [Google: JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) | DOCUMENTED | Google renders JavaScript with an evergreen Chromium; content and links injected by JavaScript can be processed after rendering. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-LINKS | [Google: Make your links crawlable](https://developers.google.com/search/docs/crawling-indexing/links-crawlable) | DOCUMENTED | Google can follow links only when they are <a> elements with an href attribute that resolves to a web address. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-TITLE | [Google: Influencing title links](https://developers.google.com/search/docs/appearance/title-link) | DOCUMENTED | Every page should have a <title>; Google may use other on-page sources for the title link. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-SNIPPET | [Google: Control your snippets](https://developers.google.com/search/docs/appearance/snippet) | DOCUMENTED | Snippets are primarily created from page content; the meta description may be used when it describes the page better. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-SITEMAP | [Google: Sitemaps overview](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview) | DOCUMENTED | A sitemap helps discovery but is not required; well-linked sites can be discovered without one. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-SDPOLICY | [Google: General structured data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies) | DOCUMENTED | Structured data must represent content visible on the page; markup does not guarantee a rich result. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-GALLERY | [Google: Structured data markup that Google Search supports](https://developers.google.com/search/docs/appearance/structured-data/search-gallery) | DOCUMENTED | List of Google-supported structured data features. FAQ is no longer listed (page updated 2026-06-15). | 2026-10-05 |
| SRC-G-ORG | [Google: Organization structured data](https://developers.google.com/search/docs/appearance/structured-data/organization) | DOCUMENTED | No required properties; recommended on the home page or a single page describing the organization, not needed on every page. | 2026-10-05 |
| SRC-G-ARTICLE | [Google: Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article) | DOCUMENTED | Article/NewsArticle/BlogPosting: no required properties; recommended author, author.name, author.url, dateModified, datePublished, headline, image. | 2026-10-05 |
| SRC-G-BREADCRUMB | [Google: Breadcrumb structured data](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb) | DOCUMENTED | BreadcrumbList requires itemListElement; each ListItem requires name and position, and item except on the last element. | 2026-10-05 |
| SRC-G-LOCALBIZ | [Google: Local business structured data](https://developers.google.com/search/docs/appearance/structured-data/local-business) | DOCUMENTED | LocalBusiness requires address and name. | 2026-10-05 |
| SRC-G-PRODUCT | [Google: Product snippet structured data](https://developers.google.com/search/docs/appearance/structured-data/product-snippet) | DOCUMENTED | Product snippet requires name and one of review, aggregateRating or offers. | 2026-10-05 |
| SRC-G-SOFTWARE | [Google: Software app structured data](https://developers.google.com/search/docs/appearance/structured-data/software-app) | DOCUMENTED | SoftwareApplication requires name, offers.price and one of aggregateRating or review. | 2026-10-05 |
| SRC-G-EVENT | [Google: Event structured data](https://developers.google.com/search/docs/appearance/structured-data/event) | DOCUMENTED | Event requires location, location.address, name and startDate. | 2026-10-05 |
| SRC-G-PROFILE | [Google: Profile page structured data](https://developers.google.com/search/docs/appearance/structured-data/profile-page) | DOCUMENTED | ProfilePage requires mainEntity (Person or Organization) with a name. | 2026-10-05 |
| SRC-G-FAQ | [Google: FAQ rich result removal notice](https://developers.google.com/search/docs/appearance/structured-data/faqpage) | DOCUMENTED | The FAQ rich result is no longer shown in Google Search (announced May 2026; documentation removed 2026-06-15). No FAQ eligibility is offered by this tool. | 2026-10-05 |
| SRC-SCHEMA | [Schema.org vocabulary](https://schema.org/) | DOCUMENTED | Defines the vocabulary only. Google feature documentation defines search-feature requirements. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-G-HREFLANG | [Google: Localized versions of your pages](https://developers.google.com/search/docs/specialty/international/localized-versions) | DOCUMENTED | Each version lists itself and all others; non-reciprocal annotations are ignored; fully-qualified URLs; ISO 639-1 language with optional ISO 3166-1 alpha-2 region or script; x-default is recommended, not required; HTML, HTTP header and sitemap methods are equivalent. | 2026-10-05 |
| SRC-WEBVITALS | [web.dev: Web Vitals](https://web.dev/articles/vitals) | DOCUMENTED | Good thresholds at the 75th percentile: LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1. TBT is a lab proxy and is not INP. | 2026-10-05 |
| SRC-CRUX | [Chrome UX Report API](https://developer.chrome.com/docs/crux/api/) | DOCUMENTED | queryRecord returns p75 field metrics for a url or origin key with a collection period and form factor. | 2026-10-05 |
| SRC-OPENAI | [OpenAI: Overview of OpenAI crawlers](https://developers.openai.com/api/docs/bots) | DOCUMENTED | OAI-SearchBot surfaces sites in ChatGPT search; GPTBot is the training crawler; ChatGPT-User is user-initiated and robots.txt rules may not apply to it. | 2026-10-05 |
| SRC-ANTHROPIC | [Anthropic: Does Anthropic crawl data from the web?](https://privacy.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler) | DOCUMENTED | ClaudeBot collects training data; Claude-SearchBot supports search; Claude-User fetches on user request. All three honour robots.txt. | 2026-10-05 |
| SRC-PERPLEXITY | [Perplexity: Perplexity crawlers](https://docs.perplexity.ai/docs/resources/perplexity-crawlers) | DOCUMENTED | PerplexityBot surfaces sites in Perplexity search and is not used for foundation-model training; Perplexity-User is user-requested and generally ignores robots.txt. | 2026-10-05 |
| SRC-G-CRAWLERS | [Google: Common crawlers (Google-Extended)](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers) | DOCUMENTED | Google-Extended is a product token controlling Gemini training and grounding use; it does not affect inclusion or ranking in Google Search. | 2026-10-05 |
| SRC-W3C-IMG | [W3C WAI: Images tutorial](https://www.w3.org/WAI/tutorials/images/) | DOCUMENTED | Informative images need a text alternative; decorative images use an empty alt. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-W3C-LABELS | [W3C WAI: Labeling controls](https://www.w3.org/WAI/tutorials/forms/labels/) | DOCUMENTED | Form controls need a programmatically associated label. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-W3C-STRUCT | [W3C WAI: Page structure tutorial](https://www.w3.org/WAI/tutorials/page-structure/) | DOCUMENTED | Landmarks and headings convey page structure to assistive technology. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-W3C-MIXED | [W3C: Mixed Content](https://www.w3.org/TR/mixed-content/) | DOCUMENTED | Browsers block active mixed content and upgrade or block passive mixed content on HTTPS pages. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-WEBDEV-VIEWPORT | [web.dev: Responsive web design basics](https://web.dev/articles/responsive-web-design-basics) | DOCUMENTED | Pages need a meta viewport tag for mobile rendering; content should not overflow the viewport horizontally. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-LLMSTXT | [llms.txt proposal](https://llmstxt.org/) | PROPOSED_SPEC | A community proposal for a markdown file at /llms.txt. Not a Google requirement and no vendor adoption is implied. | seeded 2026-10-05, not re-fetched in the build session |
| SRC-TOOL-POLICY | [Wellows initial-audit tool policy](about:wellows-tool-policy) | TOOL_POLICY | Thresholds, scoring weights and efficiency targets chosen by this tool. Not a search-engine requirement or an industry benchmark. | 2026-10-05 |

## Google feature registry 2026.10.0 (reviewed 2026-10-05)

Schema.org defines vocabulary; these rows are Google's search-feature requirements. FAQ is deliberately absent: Google no longer shows the FAQ rich result.

| Feature | Types | Required | One of | Recommended (checked) | Source |
| --- | --- | --- | --- | --- | --- |
| Organization | Organization, Corporation, NGO, EducationalOrganization, OnlineBusiness, OnlineStore | none | - | name, url, logo, sameAs | SRC-G-ORG |
| Local business | LocalBusiness, Restaurant, Store, Dentist, Physician, MedicalClinic, ... | name, address | - | telephone, url, openingHoursSpecification, geo | SRC-G-LOCALBIZ |
| Article | Article, NewsArticle, BlogPosting | none | - | headline, author, datePublished, dateModified, image | SRC-G-ARTICLE |
| Breadcrumb | BreadcrumbList | itemListElement | - | - | SRC-G-BREADCRUMB |
| Product snippet | Product | name | review / aggregateRating / offers | - | SRC-G-PRODUCT |
| Software app | SoftwareApplication, MobileApplication, WebApplication | name, offers.price | aggregateRating / review | applicationCategory, operatingSystem | SRC-G-SOFTWARE |
| Event | Event | name, startDate, location, location.address | - | endDate, description, eventStatus, image, offers, organizer | SRC-G-EVENT |
| Profile page | ProfilePage | mainEntity, mainEntity.name | - | dateCreated, dateModified | SRC-G-PROFILE |

## Bot registry 2026.10.0

| Token | Vendor | Role | Scored | Interpretation | Source |
| --- | --- | --- | --- | --- | --- |
| Googlebot | Google | Google Search crawling | no | Relevant to Google Search and its AI search features. Scored under crawl/indexing, shown here for context. | SRC-G-AI |
| OAI-SearchBot | OpenAI | OpenAI search crawler | AI Technical Accessibility | Robots access relevant to being surfaced in ChatGPT search. | SRC-OPENAI |
| PerplexityBot | Perplexity | Perplexity search crawler | AI Technical Accessibility | Search discovery; not a foundation-model training crawler. | SRC-PERPLEXITY |
| Claude-SearchBot | Anthropic | Anthropic search crawler | AI Technical Accessibility | Search discovery. | SRC-ANTHROPIC |
| GPTBot | OpenAI | OpenAI training crawler | no | Training-policy choice; excluded from visibility scoring. | SRC-OPENAI |
| ClaudeBot | Anthropic | Anthropic training crawler | no | Training-policy choice; excluded from visibility scoring. | SRC-ANTHROPIC |
| Google-Extended | Google | Gemini training/grounding product control | no | Does not control Google Search inclusion or ranking; excluded from the Google Search visibility assessment. | SRC-G-CRAWLERS |
| ChatGPT-User | OpenAI | User-triggered access | no | Not the automatic search crawler; OpenAI states robots.txt rules may not apply to user-initiated visits. | SRC-OPENAI |
| Perplexity-User | Perplexity | User-triggered access | no | Perplexity documents that these user-requested fetches generally ignore robots.txt rules. | SRC-PERPLEXITY |
| Claude-User | Anthropic | User-triggered access | no | Anthropic documents that Claude-User honours robots.txt. | SRC-ANTHROPIC |
