import type { AppConfig } from '../config';
import { auditorUserAgent } from '../config';
import { Acquirer } from '../net/acquire';
import type { RawResult } from '../net/context';
import type { RenderResult } from '../net/browser';
import { Recorder, anyValid, rawValid, renValid, type Env, type PageWork } from '../checks/engine';
import { discover, urlHash, type SelectedPage } from '../discovery/discover';
import { classifyPage } from '../discovery/grouping';
import { extractPage } from '../extract/html';
import { probeLlmsTxt, probeOrigins, probeSitemap, probeSoft404, SITEMAP_SCOPE_STATEMENT } from '../checks/site';
import { checkCrawlPage, checkCrawlSite, checkRobots, deriveEligibility } from '../checks/crawl';
import { checkDuplicates, checkLinkTargets, checkOnPage } from '../checks/onpage';
import { checkStructured } from '../checks/structured';
import { checkHreflang } from '../checks/hreflang';
import { checkAiPage, checkAiSite } from '../checks/ai';
import { checkTransportSite, checkUxPage } from '../checks/ux';
import { runPerformance } from '../perf/perf';
import { runContentReview } from '../content/review';
import { buildCoverage, buildRootIssues, buildSummary, computeScores } from '../scoring/score';
import { RULE_REGISTRY_VERSION } from '../checks/registry';
import { BOTS, SOURCES, SOURCE_REGISTRY_REVIEWED } from '../sources/registry';
import { SCHEMA_VERSION, TOOL_VERSION, type Audit, type AuditConfig, type PageRecord, type RawRecord, type RenderedRecord, type StageRecord } from '../types';
import { fetchKey, parseTargetUrl } from '../util/url';

export const STAGES: [StageRecord['id'], string][] = [
  ['discovery', 'Discovery'],
  ['acquisition', 'Fetching and rendering'],
  ['technical_checks', 'Technical checks'],
  ['ai_content', 'AI access and content review'],
  ['performance', 'Performance'],
  ['report', 'Report generation'],
];

export function emptyScores(): Audit['scores'] {
  return computeScores([], 0);
}

export function newAudit(a: { audit_id: string; tenant_id: string; project_id: string; client_name: string; input_url: string; config: AuditConfig; cfg: AppConfig; retry_of?: string | null; retry_count?: number }): Audit {
  return {
    schema_version: SCHEMA_VERSION, tool_version: TOOL_VERSION, rule_registry_version: RULE_REGISTRY_VERSION, source_registry_reviewed: SOURCE_REGISTRY_REVIEWED,
    audit_id: a.audit_id, run_id: `${a.audit_id}-r1`, tenant_id: a.tenant_id, project_id: a.project_id, client_name: a.client_name, mode: 'LIVE',
    retry_of: a.retry_of ?? null, retry_count: a.retry_count ?? 0, status: 'QUEUED', run_quality: 'PENDING', stop_reason: null,
    target: { input_url: a.input_url, normalized_url: a.input_url, host: '', registrable_domain: null, preferred_origin: null, origin_resolution: [], origin_note: '' },
    config: a.config,
    site_facts: {},
    auditor: { user_agent: auditorUserAgent(a.cfg), robots_token: a.cfg.auditor.token, contact_url: a.cfg.auditor.contactUrl },
    discovery: { documents_fetched: 0, documents: [], candidates: [], groups: [], limitations: [], used_sitemap_for_sampling: false },
    pages: [],
    site: {
      robots: { url: null, status: null, state: 'NOT_FETCHED', note: 'Not fetched yet.', sitemaps: [], unsupported_fields: [], bytes: 0, body_ref: null },
      sitemap: { chosen: null, chosen_basis: 'none', matrix: [], scope_statement: SITEMAP_SCOPE_STATEMENT },
      llms_txt: { url: null, state: 'NOT_FETCHED', status: null, excerpt: null, note: 'Not fetched yet.' },
      soft404: { probe_url: null, status: null, outcome: 'NOT_TESTED', note: 'Not tested yet.' },
      origins: [], ai_bots: [],
    },
    evidence: [], checks: [], root_issues: [],
    content_review: { state: 'UNAVAILABLE', note: 'Not run yet.', truncated: false, input_chars: 0, observations: [], rejected: [], summary: null },
    optional_signals: [],
    performance: { field: [], lab: [], note: '' },
    scores: emptyScores(),
    coverage: { pages: { requested: a.config.sample_size, selected: 0, fetched: 0, valid: 0, blocked: 0, unavailable: 0, challenged: 0, error_pages: 0 }, omitted_checks: [] },
    summary: { strengths: [], top_issue_ids: [], counts: { critical: 0, high: 0, medium: 0, low: 0, opportunities: 0 }, action_plan: [], narrative: [] },
    budgets_used: {},
    timings: { created_at: new Date().toISOString(), started_at: null, finished_at: null, elapsed_ms: null },
    stages: STAGES.map(([id, label]) => ({ id, label, state: 'PENDING', started_at: null, finished_at: null, detail: null, completed: null, total: null })),
    limitations: [],
    sources: SOURCES,
    report: { state: 'NONE', generated_at: null, error: null, bytes: null },
  };
}

export interface PipelineHooks {
  save(audit: Audit): void;
}

function stage(audit: Audit, id: StageRecord['id'], patch: Partial<StageRecord>) {
  const s = audit.stages.find((x) => x.id === id)!;
  if (patch.state === 'RUNNING' && !s.started_at) s.started_at = new Date().toISOString();
  if (patch.state && ['DONE', 'PARTIAL', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(patch.state)) s.finished_at = new Date().toISOString();
  Object.assign(s, patch);
}

function skeletonRaw(url: string): RawRecord {
  return { profile: 'RAW', requested_url: url, final_url: null, hops: [], status: null, headers: {}, bytes: 0, body_complete: false, truncated_reason: null, timing_ms: 0, fetched_at: new Date().toISOString(), acquisition: 'NOT_ATTEMPTED', error: null, validity: null, validity_evidence: [], content_type: null, body_ref: null, from_cache: false };
}
function skeletonRendered(url: string): RenderedRecord {
  return { profile: 'RENDERED', requested_url: url, final_url: null, status: null, headers: {}, timing_ms: 0, rendered_at: new Date().toISOString(), acquisition: 'NOT_ATTEMPTED', error: null, validity: null, validity_evidence: [], dom_ref: null, screenshot_ref: null, viewport: { width: 412, height: 915 }, console_errors: [], failed_requests: [], mixed_content: [], resource_count: 0, resource_bytes: 0, resource_cap_hit: false, overflow: null, axe: null, settle: 'not-started' };
}

export function pageSkeletons(selected: SelectedPage[], config: AuditConfig): PageRecord[] {
  return selected.map((s, i) => ({
    page_id: `P${String(i + 1).padStart(2, '0')}`, url: s.url, page_type: s.page_type, selection_reason: s.selection_reason, discovered_from: s.discovered_from,
    observed_group: s.observed_group, operator_override: s.operator_override,
    intent: config.intentional_restrictions.some((r) => r && (s.url === r || s.url.startsWith(r) || new URL(s.url).pathname.startsWith(r))) ? 'intentional_restriction' : 'public_search',
    robots: { auditor: { token: '', decision: 'UNKNOWN', matched_group: null, matched_rule: null, reason: 'Not evaluated yet.' }, googlebot: { token: 'Googlebot', decision: 'UNKNOWN', matched_group: null, matched_rule: null, reason: 'Not evaluated yet.' } },
    raw: skeletonRaw(s.url), rendered: skeletonRendered(s.url), raw_extract: null, rendered_extract: null, state: 'UNAVAILABLE', technical_eligibility: null, screenshot_ref: null,
  }));
}

/** Phase A: discovery. Leaves the proposed sample on the audit. */
export async function runDiscovery(audit: Audit, acq: Acquirer, hooks: PipelineHooks): Promise<void> {
  audit.status = 'DISCOVERING';
  audit.timings.started_at = audit.timings.started_at ?? new Date().toISOString();
  stage(audit, 'discovery', { state: 'RUNNING', detail: 'Starting' });
  hooks.save(audit);
  const input = parseTargetUrl(audit.target.input_url);
  if (acq.ctx.guard.isFixtureHost(input.hostname)) audit.mode = 'FIXTURE_DEMO';
  let last = 0;
  const out = await discover(acq, audit.target.input_url, input, audit.config, (detail) => {
    stage(audit, 'discovery', { detail });
    if (Date.now() - last > 700) (last = Date.now()), hooks.save(audit);
  });
  audit.target = out.target;
  audit.discovery = out.discovery;
  audit.pages = pageSkeletons(out.selected, audit.config);
  audit.coverage.pages.selected = audit.pages.length;
  stage(audit, 'discovery', { state: acq.ctx.stopReason ? 'PARTIAL' : 'DONE', detail: `${out.selected.length} page(s) proposed from ${out.discovery.candidates.length} observed candidate(s)`, completed: out.discovery.documents_fetched, total: null });
  hooks.save(audit);
}

/** Replace the proposed sample with the operator's reviewed selection (still capped at the product limit). */
export function applyOperatorSelection(audit: Audit, urls: string[], maxPages: number) {
  const max = Math.min(maxPages, 10);
  const existing = new Map(audit.pages.map((p) => [fetchKey(p.url), p]));
  const candidates = new Map(audit.discovery.candidates.map((c) => [fetchKey(c.url), c]));
  const chosen: SelectedPage[] = [];
  for (const raw of urls) {
    const u = parseTargetUrl(raw);
    const key = fetchKey(u);
    if (chosen.some((c) => fetchKey(c.url) === key)) continue;
    if (chosen.length >= max) {
      audit.limitations.push(`More than ${max} pages were submitted; extra URLs were not audited.`);
      break;
    }
    const prev = existing.get(key);
    const cand = candidates.get(key);
    chosen.push(prev
      ? { url: prev.url, page_type: prev.page_type, selection_reason: prev.selection_reason, discovered_from: prev.discovered_from, observed_group: prev.observed_group, operator_override: prev.operator_override }
      : { url: key, page_type: cand?.page_type ?? classifyPage(key), selection_reason: cand ? 'Discovered candidate chosen by the operator' : 'Public URL added by the operator', discovered_from: cand?.discovered_from ?? null, observed_group: cand?.group ?? u.pathname, operator_override: 'operator-selected' });
  }
  const keep = new Set(chosen.map((c) => fetchKey(c.url)));
  for (const c of audit.discovery.candidates) c.selected = keep.has(fetchKey(c.url));
  audit.pages = pageSkeletons(chosen, audit.config);
  audit.coverage.pages.selected = audit.pages.length;
}

export interface Reuse {
  raw: Map<string, RawResult>;
  rendered: Map<string, RenderResult>;
}

/** Phase B: acquisition, checks, AI/content, performance, scoring. */
export async function runChecks(audit: Audit, acq: Acquirer, hooks: PipelineHooks, reuse?: Reuse): Promise<void> {
  const ctx = acq.ctx;
  audit.status = 'RUNNING';
  audit.timings.started_at = audit.timings.started_at ?? new Date().toISOString();
  const rec = new Recorder();
  const works: PageWork[] = [];
  const env: Env = { acq, config: audit.config, audit, pages: works, rec };
  const sync = () => {
    audit.evidence = rec.evidence;
    audit.checks = rec.checks;
    audit.coverage = buildCoverage(audit);
    audit.budgets_used = { ...ctx.counters, elapsed_ms: Date.now() - ctx.startedAt };
    hooks.save(audit);
  };

  // ---- Acquisition ------------------------------------------------------------------------------------------
  stage(audit, 'acquisition', { state: 'RUNNING', completed: 0, total: audit.pages.length, detail: 'Reading robots.txt' });
  hooks.save(audit);
  const origin = audit.target.preferred_origin ?? new URL(parseTargetUrl(audit.target.input_url)).origin;
  const robots = await acq.robots.load(origin);
  audit.site.robots = { url: robots.url, status: robots.status, state: robots.state, note: robots.note, sitemaps: robots.parsed?.sitemaps ?? [], unsupported_fields: robots.parsed?.unsupported_fields ?? [], bytes: robots.bytes, body_ref: robots.body_ref };

  let i = 0;
  for (const page of audit.pages) {
    stage(audit, 'acquisition', { detail: `Page ${i + 1} of ${audit.pages.length}: ${new URL(page.url).pathname}`, completed: i });
    hooks.save(audit);
    const pageOrigin = new URL(page.url).origin;
    const rs = await acq.robots.load(pageOrigin);
    page.robots.auditor = acq.robots.decideWith(rs, ctx.cfg.auditor.token, page.url);
    page.robots.googlebot = acq.robots.decideWith(rs, 'Googlebot', page.url);
    const h = urlHash(page.url);
    const key = fetchKey(page.url);
    let raw: RawResult;
    let rendered: RenderResult;
    if (reuse?.raw.has(key) && reuse.rendered.has(key)) {
      raw = reuse.raw.get(key)!;
      rendered = reuse.rendered.get(key)!;
    } else {
      [raw, rendered] = await Promise.all([acq.raw(page.url, 'sampled page', `raw-${h}.html`), acq.render(page.url, `r-${h}`)]);
      // RENDERED challenge: one more attempt inside the budget before it is treated as persistent.
      if (rendered.record.validity === 'ACCESS_CHALLENGE' && !ctx.blocked()) {
        const again = await acq.browser.render(page.url, `r-${h}`);
        if (again.record.acquisition === 'OK') rendered = again;
        if (rendered.record.validity === 'ACCESS_CHALLENGE') {
          rendered.record.validity_evidence.unshift('ACCESS_CHALLENGE_DETECTED (persisted after one retry)');
          ctx.noteChallenge(page.url);
        }
      }
    }
    page.raw = raw.record;
    page.rendered = rendered.record;
    const w: PageWork = { rec: page, raw, rendered };
    if (rawValid(w) && raw.text) page.raw_extract = extractPage(raw.text, raw.record.final_url ?? page.url, raw.record.headers);
    if (renValid(w) && rendered.dom) page.rendered_extract = extractPage(rendered.dom, rendered.record.final_url ?? page.url, { ...rendered.record.headers });
    page.screenshot_ref = rendered.record.screenshot_ref;
    if (page.robots.auditor.decision !== 'ALLOW') page.state = 'BLOCKED';
    else if (anyValid(w)) page.state = 'VALID';
    else if (raw.record.validity === 'ACCESS_CHALLENGE' || rendered.record.validity === 'ACCESS_CHALLENGE') page.state = 'CHALLENGED';
    else if (raw.record.acquisition === 'OK' && raw.record.validity === 'ERROR_DOCUMENT') page.state = 'ERROR_PAGE';
    else page.state = 'UNAVAILABLE';
    works.push(w);
    i++;
    stage(audit, 'acquisition', { completed: i });
    sync();
  }

  stage(audit, 'acquisition', { detail: 'Site-level probes (origins, sitemap endpoint, llms.txt)' });
  hooks.save(audit);
  audit.site.origins = await probeOrigins(acq, audit);
  audit.site.soft404 = await probeSoft404(acq, audit);
  audit.site.sitemap = await probeSitemap(acq, audit, audit.site.robots.sitemaps);
  audit.site.llms_txt = await probeLlmsTxt(acq, audit);
  audit.site.ai_bots = BOTS.map((b) => ({
    token: b.token, role: b.role, scored: b.scored,
    decisions: audit.pages.map((p) => ({ page_id: p.page_id, decision: acq.robots.decideWith(acq.robots.peek(new URL(p.url).origin), b.token, p.url) })),
  }));
  audit.optional_signals = [{ id: 'llms_txt', label: 'llms.txt (optional, proposed convention)', state: audit.site.llms_txt.state, note: audit.site.llms_txt.note, evidence_ids: [] }];
  audit.site_facts = observeSiteFacts(audit, works);
  stage(audit, 'acquisition', { state: ctx.stopReason ? 'PARTIAL' : 'DONE', detail: `${works.filter(anyValid).length} of ${works.length} page(s) returned a genuine response` });
  sync();

  // ---- Technical checks ------------------------------------------------------------------------------------------
  stage(audit, 'technical_checks', { state: 'RUNNING', completed: 0, total: works.length });
  await checkRobots(env);
  let n = 0;
  for (const w of works) {
    await checkCrawlPage(env, w);
    await checkOnPage(env, w);
    await checkStructured(env, w);
    await checkHreflang(env, w);
    await checkUxPage(env, w);
    deriveEligibility(env, w);
    stage(audit, 'technical_checks', { completed: ++n });
    sync();
  }
  await checkCrawlSite(env);
  await checkDuplicates(env);
  await checkLinkTargets(env);
  await checkTransportSite(env);
  const llms = rec.checks.find((c) => c.check_id === 'X-9.1');
  if (llms) audit.optional_signals[0].evidence_ids = llms.evidence_ids;
  stage(audit, 'technical_checks', { state: 'DONE' });
  sync();

  // ---- AI access and content review ---------------------------------------------------------------------------------
  stage(audit, 'ai_content', { state: 'RUNNING' });
  for (const w of works) await checkAiPage(env, w);
  await checkAiSite(env);
  audit.content_review = await runContentReview(env);
  stage(audit, 'ai_content', { state: 'DONE', detail: audit.content_review.state === 'LLM' ? 'Semantic review completed' : 'Semantic review unavailable; deterministic observations only' });
  sync();

  // ---- Performance ----------------------------------------------------------------------------------------------------
  stage(audit, 'performance', { state: 'RUNNING', completed: 0, total: null });
  await runPerformance(env, (done, total) => {
    stage(audit, 'performance', { completed: done, total });
    hooks.save(audit);
  });
  const fieldOk = audit.performance.field.some((f) => f.available);
  stage(audit, 'performance', { state: fieldOk ? 'DONE' : 'PARTIAL', detail: fieldOk ? 'Field data retrieved' : 'Field data unavailable; lab diagnostics only' });

  finalize(audit, acq, rec);
  hooks.save(audit);
}

export function finalize(audit: Audit, acq: Acquirer, rec: Recorder) {
  const ctx = acq.ctx;
  audit.evidence = rec.evidence;
  audit.checks = rec.checks;
  audit.root_issues = buildRootIssues(audit);
  audit.coverage = buildCoverage(audit);
  audit.scores = computeScores(audit.checks, audit.coverage.pages.valid);
  audit.summary = buildSummary(audit);
  audit.budgets_used = { ...ctx.counters, elapsed_ms: Date.now() - ctx.startedAt, browser_requests_blocked_by_guard: acq.browser.blockedRequests.length };
  const lim = new Set<string>([...audit.limitations, ...audit.discovery.limitations, ...ctx.limitations]);
  lim.add('This is an initial audit of a small representative sample (at most 10 pages). It is not a full-site audit and nothing is extrapolated to the whole site.');
  lim.add('Results reflect what this auditor received at the time of the run. Vendor crawlers may receive different responses from a CDN or firewall.');
  audit.limitations = [...lim];
  audit.stop_reason = ctx.stopReason;
  const p = audit.coverage.pages;
  audit.run_quality = p.valid === 0 ? 'INSUFFICIENT' : ctx.stopReason || p.valid < p.selected - p.error_pages - audit.pages.filter((x) => x.intent === 'intentional_restriction' && x.state === 'BLOCKED').length ? 'PARTIAL' : 'COMPLETE';
  audit.status = ctx.stopReason === 'CANCELLED' ? 'CANCELLED' : ctx.stopReason ? 'PARTIAL' : 'COMPLETED';
  audit.timings.finished_at = new Date().toISOString();
  audit.timings.elapsed_ms = Date.now() - new Date(audit.timings.started_at ?? audit.timings.created_at).getTime();
}

/** Client facts are recorded as observed, operator-supplied or unknown. Nothing about the site is assumed. */
function observeSiteFacts(audit: Audit, works: PageWork[]): Audit['site_facts'] {
  const home = works.find((w) => rawValid(w));
  const gen = home?.raw.text ? /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(home.raw.text)?.[1] : null;
  const compared = works.filter((w) => rawValid(w) && renValid(w));
  const hreflang = works.some((w) => (w.rec.raw_extract?.hreflang.length ?? 0) + (w.rec.rendered_extract?.hreflang.length ?? 0) > 0);
  return {
    cms: gen ? { value: `${gen} (meta generator tag)`, basis: 'observed' } : { value: 'unknown', basis: 'unknown' },
    rendering: compared.length ? { value: `RAW and RENDERED profiles were compared on ${compared.length} sampled page(s); see AI Access findings`, basis: 'observed' } : { value: 'unknown', basis: 'unknown' },
    environment: { value: audit.config.environment, basis: 'operator-supplied' },
    visibility_goal: { value: audit.config.visibility_goal, basis: 'operator-supplied' },
    multilingual: audit.config.multilingual ? { value: 'yes', basis: 'operator-supplied' } : hreflang ? { value: 'hreflang annotations observed in the sample', basis: 'observed' } : { value: 'unknown (no annotations observed in the sample)', basis: 'unknown' },
    country: { value: 'unknown', basis: 'unknown' },
    target_queries: { value: 'unknown', basis: 'unknown' },
    customer_segment: { value: 'unknown', basis: 'unknown' },
  };
}

export { Acquirer };
