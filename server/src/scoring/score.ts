import type { Audit, CategoryScore, CheckResult, RootIssue, ScoreBlock, Severity } from '../types';
import { AI_BUCKETS, CATEGORY_LABELS, RULES, TECH_WEIGHTS, ruleById } from '../checks/registry';

const VALUE: Record<string, number> = { PASS: 1, WARN: 0.5, FAIL: 0 };
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Wellows tool policy, shown as such in the UI and PDF:
 *  - PASS = 1, WARN = 0.5, FAIL = 0 for scored check units;
 *  - page units are averaged inside each check type first, so repeating page checks cannot dilute site checks;
 *  - check types are combined by rule weight inside a category/bucket, then categories by their weight;
 *  - NOT_APPLICABLE, NOT_TESTABLE, ERROR, derived composites, optional signals and lab data never enter a denominator;
 *  - the headline is suppressed without a genuine evaluated page or below 50% coverage.
 */
function block(id: ScoreBlock['id'], label: string, groups: { id: string; label: string; weight: number }[], checks: CheckResult[], validPages: number): ScoreBlock {
  const cats: CategoryScore[] = [];
  let evalUnits = 0;
  let applicableUnits = 0;
  for (const g of groups) {
    const rules = RULES.filter((r) => r.score === id && r.score_bucket === g.id);
    let wSum = 0;
    let acc = 0;
    let catEval = 0;
    let catApplicable = 0;
    const perCheck: CategoryScore['checks'] = [];
    for (const r of rules) {
      const units = checks.filter((c) => c.check_id === r.check_id && c.status !== 'NOT_APPLICABLE');
      const evaluated = units.filter((c) => c.status in VALUE);
      catApplicable += units.length;
      catEval += evaluated.length;
      const score = evaluated.length ? evaluated.reduce((a, c) => a + VALUE[c.status], 0) / evaluated.length : null;
      perCheck.push({ check_id: r.check_id, score: score === null ? null : round(score * 100), evaluated_units: evaluated.length, applicable_units: units.length, weight: r.weight });
      if (score !== null) {
        wSum += r.weight;
        acc += score * r.weight;
      }
    }
    evalUnits += catEval;
    applicableUnits += catApplicable;
    cats.push({ id: g.id, label: g.label, weight: g.weight, score: wSum ? round((acc / wSum) * 100) : null, evaluated_units: catEval, applicable_units: catApplicable, checks: perCheck });
  }
  const scored = cats.filter((c) => c.score !== null);
  const totalW = scored.reduce((a, c) => a + c.weight, 0);
  const raw = totalW ? scored.reduce((a, c) => a + (c.score as number) * c.weight, 0) / totalW : null;
  const pct = applicableUnits ? round((evalUnits / applicableUnits) * 100) : null;
  let suppressed: string | null = null;
  if (!validPages) suppressed = 'Insufficient evidence to score: no genuine page response was evaluated.';
  else if (raw === null) suppressed = 'Insufficient evidence to score: no scored check could be evaluated.';
  else if (pct === null || pct < 50) suppressed = `Insufficient evidence to score: only ${pct ?? 0}% of applicable check units could be evaluated.`;
  return {
    id, label, value: suppressed || raw === null ? null : Math.round(raw), suppressed_reason: suppressed, categories: cats,
    coverage: { evaluated_units: evalUnits, applicable_units: applicableUnits, pct },
    method: 'PASS = 1, WARN = 0.5, FAIL = 0. Page units are averaged within each check, checks are combined by rule weight within a category, and categories by the published weights, normalised over categories that have evaluated checks. Not applicable, not testable, tool-error, derived, optional and lab results are excluded from the score. Coverage = evaluated units / applicable planned units.',
    source_label: 'TOOL_POLICY',
  };
}

export function computeScores(checks: CheckResult[], validPages: number): Audit['scores'] {
  return {
    technical_health: block('technical_health', 'Initial Technical Health', TECH_WEIGHTS.map((w) => ({ id: w.id, label: CATEGORY_LABELS[w.id], weight: w.weight })), checks, validPages),
    ai_accessibility: block('ai_accessibility', 'AI Technical Accessibility', AI_BUCKETS, checks, validPages),
  };
}

const SEV_RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Group repeated findings by root cause (check + reason code) with every affected sample URL. */
export function buildRootIssues(audit: Pick<Audit, 'checks' | 'pages'>): RootIssue[] {
  const urlOf = new Map(audit.pages.map((p) => [p.page_id, p.url]));
  const map = new Map<string, RootIssue>();
  for (const c of audit.checks) {
    for (const f of c.findings) {
      const key = `${f.check_id}|${f.reason_code}`;
      let r = map.get(key);
      if (!r) {
        r = {
          issue_id: '', check_id: f.check_id, reason_code: f.reason_code, category: c.category, finding_status: f.finding_status, classification: f.classification,
          severity: f.severity, confidence: f.confidence, caveat: f.caveat, priority: f.priority, title: f.title, explanation: f.explanation, practical_impact: f.practical_impact,
          recommended_action: f.recommended_action, suggested_owner: f.suggested_owner, effort: f.effort, affected_page_ids: [], affected_urls: [], finding_ids: [], evidence_ids: [],
          source_ids: f.source_ids, related_issue_ids: [], score_included: c.score_included, code: f.code ?? null,
        };
        map.set(key, r);
      }
      if (SEV_RANK[f.severity] < SEV_RANK[r.severity]) (r.severity = f.severity), (r.priority = f.priority);
      if (f.finding_status === 'FAIL') r.finding_status = 'FAIL';
      for (const pid of f.affected_page_ids) if (!r.affected_page_ids.includes(pid)) r.affected_page_ids.push(pid);
      r.finding_ids.push(f.finding_id);
      for (const e of f.evidence_ids) if (!r.evidence_ids.includes(e)) r.evidence_ids.push(e);
    }
  }
  const list = [...map.values()].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || Number(a.classification !== 'ISSUE') - Number(b.classification !== 'ISSUE') || b.affected_page_ids.length - a.affected_page_ids.length || (a.check_id < b.check_id ? -1 : 1));
  list.forEach((r, i) => {
    r.issue_id = `I-${String(i + 1).padStart(3, '0')}`;
    r.affected_urls = r.affected_page_ids.map((p) => urlOf.get(p) ?? p);
    if (r.affected_page_ids.length > 1) r.title = r.title.replace(/^\d+ /, '');
  });
  // Dependent consequences stay visible without being counted twice: link issues that share an affected page
  // with a crawl blocker point at it.
  const blockers = list.filter((r) => ['UNEXPECTED_NOINDEX', 'GOOGLEBOT_DISALLOWED', 'NOT_FOUND_STATUS', 'SERVER_ERROR_STATUS'].includes(r.reason_code));
  for (const b of blockers) {
    for (const r of list) {
      if (r === b || !r.affected_page_ids.length || !r.affected_page_ids.every((p) => b.affected_page_ids.includes(p))) continue;
      if (!r.related_issue_ids.includes(b.issue_id)) r.related_issue_ids.push(b.issue_id);
    }
  }
  for (const c of audit.checks) for (const f of c.findings) f.related_findings = list.find((r) => r.finding_ids.includes(f.finding_id))?.related_issue_ids ?? [];
  return list;
}

export function buildCoverage(audit: Audit): Audit['coverage'] {
  const pages = audit.pages;
  const count = (s: string) => pages.filter((p) => p.state === s).length;
  return {
    pages: {
      requested: audit.config.sample_size,
      selected: pages.length,
      fetched: pages.filter((p) => p.raw.acquisition === 'OK' || p.rendered.acquisition === 'OK').length,
      valid: count('VALID'),
      blocked: count('BLOCKED'),
      unavailable: count('UNAVAILABLE'),
      challenged: count('CHALLENGED'),
      error_pages: count('ERROR_PAGE'),
    },
    omitted_checks: audit.checks
      .filter((c) => c.status === 'NOT_TESTABLE' || c.status === 'ERROR')
      .map((c) => ({ check_id: c.check_id, page_id: c.page_id, status: c.status, reason: (c.limitations[0] ?? c.notes[0] ?? 'unavailable').slice(0, 300) })),
  };
}

/** Summary, strengths and the proposed action plan. Built once and stored, so UI and PDF show identical content. */
export function buildSummary(audit: Audit): Audit['summary'] {
  const issues = audit.root_issues;
  const real = issues.filter((i) => i.classification === 'ISSUE');
  const counts = {
    critical: real.filter((i) => i.severity === 'CRITICAL').length,
    high: real.filter((i) => i.severity === 'HIGH').length,
    medium: real.filter((i) => i.severity === 'MEDIUM').length,
    low: real.filter((i) => i.severity === 'LOW').length,
    opportunities: issues.filter((i) => i.classification !== 'ISSUE').length,
  };
  const strengths: string[] = [];
  const pageUnits = (id: string) => audit.checks.filter((c) => c.check_id === id && c.status !== 'NOT_APPLICABLE');
  const allPass = (id: string) => {
    const u = pageUnits(id);
    return u.length > 0 && u.every((c) => c.status === 'PASS') ? u.length : 0;
  };
  const say = (id: string, text: (n: number) => string) => {
    const n = allPass(id);
    if (n) strengths.push(text(n));
  };
  say('C-1.2', (n) => `robots.txt allows Googlebot on all ${n} sampled page path(s).`);
  say('C-1.3', (n) => `All ${n} fetched sample page(s) return HTTP 200.`);
  say('C-1.8', (n) => `No unexpected noindex on the ${n} evaluated page(s).`);
  say('C-1.7', (n) => `Canonical signals are consistent on the ${n} evaluated page(s).`);
  say('O-2.1', (n) => `Every evaluated page (${n}) has a title.`);
  say('A-5.1', (n) => `Primary content is present in the server HTML on the ${n} compared page(s).`);
  say('A-5.3', (n) => `robots.txt allows the documented AI search crawlers on ${n} sampled page(s) (robots-level only).`);
  say('T-8.1', () => 'The preferred origin serves over HTTPS with a valid certificate.');
  say('U-7.1', (n) => `Mobile viewport is configured on the ${n} evaluated page(s).`);
  say('C-1.12', () => 'The parent sitemap endpoint opens (contents not inspected).');

  const top = [...real.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH'), ...real.filter((i) => i.severity === 'MEDIUM'), ...issues.filter((i) => i.severity === 'LOW' || i.classification !== 'ISSUE')].slice(0, 3).map((i) => i.issue_id);
  const phases: Audit['summary']['action_plan'] = [];
  const now = real.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH');
  const next = real.filter((i) => i.severity === 'MEDIUM');
  const later = issues.filter((i) => !now.includes(i) && !next.includes(i));
  if (now.length) phases.push({ phase: '0-7 days', label: 'Immediate: verified blockers', issue_ids: now.map((i) => i.issue_id) });
  if (next.length) phases.push({ phase: '1-2 weeks', label: 'Next: technical and content corrections', issue_ids: next.map((i) => i.issue_id) });
  if (later.length) phases.push({ phase: '3-4 weeks', label: 'Then: optional improvements', issue_ids: later.map((i) => i.issue_id) });

  const cov = audit.coverage.pages;
  const narrative = [
    `This initial audit evaluated ${cov.valid} valid page(s) out of ${cov.selected} selected (${cov.blocked} blocked for the auditor, ${cov.challenged} challenged, ${cov.error_pages} error page(s), ${cov.unavailable} unavailable). Findings describe this sample only and are not extrapolated to the whole site.`,
    counts.critical + counts.high
      ? `${counts.critical + counts.high} verified critical/high root issue(s) were found.`
      : 'No verified critical or high issue was found in the evaluated sample.',
    'The audit assesses technical readiness for search and AI retrieval. It does not measure actual AI citations, rankings, traffic or revenue.',
  ];
  return { strengths, top_issue_ids: top, counts, action_plan: phases, narrative };
}

export function ruleName(checkId: string): string {
  return ruleById.get(checkId)?.name ?? checkId;
}
