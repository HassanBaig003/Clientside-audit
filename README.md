# Wellows Initial Website Audit

A working module that audits **up to 10 representative public pages** of a website for important technical SEO issues and for how accessible the content is to search and AI retrieval systems, then produces a client-ready PDF.

It is an *initial* audit. It is not a full-site crawl, it does not measure actual AI citations, and it does not predict rankings, leads or revenue.

This is the **standalone build**: no Wellows application repository was supplied, so it uses the fallback design tokens from the builder prompt and keeps a clean integration boundary (see [Integration boundary](#integration-boundary)).

## What is included

| Area | Where |
| --- | --- |
| Audit engine (discovery, RAW + RENDERED acquisition, validity gate, checks, scoring) | `server/src` |
| REST API, background jobs, tenant-scoped storage | `server/src/api`, `server/src/jobs`, `server/src/store` |
| PDF report (A4, embedded Inter, built from the stored audit JSON) | `server/src/report` |
| React UI (setup, page review, live audit, results, findings, evidence, report, history) | `web/src` |
| Rule registry, source registry, Google feature registry, bot registry | `server/src/checks/registry.ts`, `server/src/sources/registry.ts`, `docs/RULES.md`, `docs/SOURCES.md` |
| Controlled fixture sites and the 20 acceptance cases | `server/test` |
| End-to-end verification run (UI screenshots, audit JSON, PDF, parity checks) | `scripts/demo.ts`, `docs/VERIFICATION.md` |

## Quick start

Requirements: Node.js 22+, and Chromium for Playwright (`npx playwright install chromium`, or use the Docker image, which includes it).

```bash
npm ci
cp .env.example .env          # set AUDIT_API_TOKENS and SESSION_SECRET at minimum
npm run build
set -a && . ./.env && set +a
npm start                     # http://localhost:8080
```

Sign in with one of the tokens from `AUDIT_API_TOKENS`, create a client/project, enter a URL and press **Run audit**.

### Docker

```bash
docker build -t wellows-initial-audit .
docker run --rm -p 8080:8080 -v audit-data:/data \
  -e AUDIT_API_TOKENS="a-long-random-token:acme:Acme" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e AUDITOR_CONTACT_URL="https://your-domain.example/audit-bot" \
  wellows-initial-audit
```

The image runs as a non-root user and stores the SQLite index, audit JSON, evidence and PDFs under `/data`. Put it behind TLS (cookies are `Secure` by default) and give the container outbound internet only: it must have no route to internal networks.

### Railway

Push this repository to GitHub and create a Railway service from it; `railway.toml` selects the Dockerfile and the health check. On the service, add a volume mounted at `/data` and set `AUDIT_API_TOKENS`, `SESSION_SECRET`, `DATA_DIR=/data`, `PORT=8080` and `RAILWAY_RUN_UID=0` (Railway mounts volumes as root). Headless Chromium needs memory: a 512 MB trial service can run out on heavy pages, which shows up as partial audits.

### Try it without touching a real site (fixture / demo mode)

```bash
npm run build
npm run fixtures &            # local test sites on 127.0.0.1:18080 / 18443
FIXTURE_MODE=1 SECURE_COOKIES=0 AUDIT_API_TOKENS="fixture-token-tenant-a-0001:demo" SESSION_SECRET=dev npm start
```

Audit `demo.test`, `ssr.test`, `jsshell.test`, `challenge.test` and the other hosts in `server/test/fixtures`. Every such audit is stamped **FIXTURE / DEMO** in the UI, the JSON and the PDF and can never be presented as a client audit. Never enable `FIXTURE_MODE` in production.

## Configuration

All configuration is by environment variable; `.env.example` lists every one.

| Variable | Purpose | Default |
| --- | --- | --- |
| `AUDIT_API_TOKENS` | `token:tenant_id[:label]` pairs. The app refuses to start without one. | none (required) |
| `SESSION_SECRET` | Signs session cookies. | random per start |
| `AUDITOR_CONTACT_URL` | Contact page sent in the auditor User-Agent. Must be truthful. | none |
| `AUDITOR_ROBOTS_TOKEN` | robots.txt product token the auditor obeys. | `WellowsAuditBot` |
| `CRUX_API_KEY` | Chrome UX Report field data. Missing key: field performance is NOT_TESTABLE. | none |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_API_BASE` | One bounded content-review call per audit (Anthropic Messages API shape). Missing: deterministic observations only. | none |
| `BUDGET_*` | Product limits from the builder prompt. They can be lowered; the 10-page ceiling cannot be raised. | see `.env.example` |
| `MAX_CONCURRENT_AUDITS`, `MAX_RETRIES_PER_AUDIT` | Worker concurrency; bounded retries of unavailable checks. | 1, 2 |
| `DATA_DIR`, `PORT`, `HOST`, `SECURE_COOKIES` | Runtime. | `./data`, 8080, 0.0.0.0, 1 |

Credentials stay on the server. They are never sent to the browser, written into evidence, or printed in the PDF.

## How an audit runs

1. **Discovery** (bounded, deterministic): robots.txt first, the preferred origin from observed redirects, links from the homepage RAW HTML and rendered DOM, observed section hubs to depth 2, at most 30 discovery documents, a nine-path fallback only when fewer than four candidates exist. Sitemap contents, search indexes and Common Crawl are never used for sampling.
2. **Selection**: URLs are grouped by path signature; one page per observed group before a second from the same group, in the priority order homepage, supplied URL, service, product, pricing, hub, article, author, about. The sample is never padded.
3. **Acquisition**: every page gets a RAW record (plain GET) and a RENDERED record (headless Chromium, 412×915). Each response passes the validity gate (`VALID_PAGE`, `ACCESS_CHALLENGE`, `ERROR_DOCUMENT`, `EMPTY_OR_TRUNCATED`, `UNKNOWN_RESPONSE`) before any content conclusion is drawn.
4. **Checks**: ordinary code decides every status. The registry in `docs/RULES.md` lists each check with its applicability, evidence requirement, source and scoring participation.
5. **Scoring**: two scores, *Initial Technical Health* and *AI Technical Accessibility*, each shown with its coverage. Both are Wellows tool policy, not Google scores.
6. **Report**: the PDF is rendered from the stored audit JSON, never from the live dashboard, and regeneration never re-fetches the site.

The run is one background job with persisted stage transitions. The audit JSON is saved after every stage and page, so a timeout, cancellation or worker restart leaves partial evidence and an honest status (`PARTIAL`, `CANCELLED`, `INTERRUPTED`), never `COMPLETED`.

## API

Base path `/api/v1`. Authenticate with `Authorization: Bearer <token>` or the session cookie from `/auth/login`.

| Method and path | Purpose |
| --- | --- |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | Session |
| `GET /projects`, `POST /projects` | Client/project records (tenant-scoped) |
| `POST /audits` | Start discovery and, with `auto_run` (default), the audit. Returns `202` with `audit_id` / `job_id`. |
| `POST /audits/:id/run` | Continue after the optional page-selection review (`{ "pages": [...] }`). |
| `GET /audits/:id/progress` | Stage states, counts, partial results, export state |
| `GET /audits/:id` | The canonical audit JSON |
| `GET /audits/:id/export` | The same JSON as a download |
| `POST /audits/:id/cancel`, `POST /audits/:id/retry` | Cancel; bounded retry of unavailable checks |
| `GET /audits/:id/report`, `POST /audits/:id/report`, `GET /audits/:id/report/download` | Export readiness, (re)generation from the stored audit, PDF download |
| `GET /audits/:id/assets/:name` | Screenshots (JPEG) and stored sources (served as plain-text downloads only) |
| `GET /audits?project_id=` | History |
| `GET /registry/rules`, `GET /registry/sources` | Rule, source, feature and bot registries |

## Security model

- **SSRF**: one `DestinationGuard` validates the initial target, every redirect hop, canonical and hreflang targets, and every browser subrequest. Only public unicast addresses and authorised ports are accepted; a DNS answer containing any private address is refused; the connection is pinned to the validated address. The browser is forced through a local guard proxy, so Chromium never resolves or connects by itself.
- **Untrusted content**: fetched HTML is only parsed, never executed outside the isolated renderer. Stored sources are served as `text/plain` attachments with a sandbox CSP. UI and report output are escaped. Website text is passed to the optional LLM as data with an instruction to ignore embedded instructions, and its output is validated against a strict schema: unknown page IDs, unknown evidence IDs, excerpts not found in the supplied content, URLs and invented metrics are rejected.
- **Tenancy**: every storage read filters on the tenant id. Another tenant's audit, evidence, screenshot, export or PDF returns 404.
- **Crawler conduct**: the auditor identifies itself truthfully, obeys robots.txt for its own token, paces requests per host, stops after repeated 429s or three distinct persistent access challenges, and never attempts to bypass a CAPTCHA, login or WAF or to impersonate a vendor crawler. Each page renders in a fresh browser context with no operator cookies.

## Integration boundary

To move this into app.wellows.com:

- **Auth and tenancy**: replace `tenantOf()` in `server/src/api/server.ts` with the host application's session. It only has to return a tenant/workspace id.
- **Client/project model**: `projects` is a minimal local table. Swap `Store.getProject/listProjects/createProject` for the existing client/project service; audits reference `project_id` only.
- **UI**: `web/src/styles.css` holds the fallback tokens (`#0452F0`, `#111827`, `#F4F5F7`, Inter). Replace the tokens and the small set of primitives in `web/src/ui.tsx` with the Wellows component library; screens consume the audit JSON and need no other change.
- **Branding**: the report uses a text wordmark. A client logo is accepted only as an approved image data URI; none is fabricated.
- **Jobs**: `AuditService` is an in-process queue. Its `execute()` method is the unit to hand to an existing job runner.

## Tests and verification

```bash
npm test          # unit tests + the 20 acceptance cases against local fixtures
npm run verify    # builds, then drives the real UI in Chromium and writes ./verification
npm run docs      # regenerates docs/RULES.md and docs/SOURCES.md from the registries
npm run preview:build   # static read-only preview of the UI over stored fixture audits (artifact/index.html)
```

See `docs/VERIFICATION.md` for results, the disclosed fixture run, and what could not be verified in the build environment.

## Maintenance

- Re-review the source registry periodically and bump `SOURCE_REGISTRY_REVIEWED`, `FEATURE_REGISTRY_VERSION` and `BOT_REGISTRY_VERSION`. Entries marked "seeded" were not re-fetched during the build and should be checked first.
- Keep the Playwright version in `package.json` and the Docker base image tag identical.
