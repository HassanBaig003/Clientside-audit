import type { Acquirer } from '../net/acquire';
import type { RawResult } from '../net/context';
import type { RenderResult } from '../net/browser';
import type { Audit, AuditConfig, CheckResult, CheckStatus, Confidence, Evidence, Extracted, Finding, PageRecord, Profile, Severity } from '../types';
import { ruleById } from './registry';
import { sourceById } from '../sources/registry';
import { truncate } from '../util/url';

export interface PageWork {
  rec: PageRecord;
  raw: RawResult;
  rendered: RenderResult;
}

export interface Env {
  acq: Acquirer;
  config: AuditConfig;
  audit: Audit;
  pages: PageWork[];
  rec: Recorder;
}

export interface FindingInput {
  check_id: string;
  status: 'WARN' | 'FAIL';
  reason_code: string;
  severity: Severity;
  title: string;
  explanation: string;
  impact: string;
  action: string;
  owner: string;
  effort: 'S' | 'M' | 'L';
  pages: string[];
  evidence: string[];
  sources?: string[];
  confidence?: Confidence;
  classification?: Finding['classification'];
  caveat?: string | null;
  code?: Finding['code'];
}

export class ContractError extends Error {}

/**
 * Enforces the evidence/result contract mechanically:
 *  - every PASS carries evidence,
 *  - every WARN/FAIL finding is traceable to observed evidence,
 *  - a FAIL needs a DOCUMENTED source (heuristics and tool policy can only support warnings/advisories),
 *  - third-party and modelled findings carry a local caveat.
 * A breach turns the check into ERROR (a tool defect), never into a website defect.
 */
export class Recorder {
  evidence: Evidence[] = [];
  checks: CheckResult[] = [];
  private evSeq = 0;
  private fSeq = 0;

  ev(e: { url: string; profile: Profile; locator: string; observed: string; expected?: string | null; body_ref?: string | null; screenshot_ref?: string | null; at?: string }): string {
    const id = `EV-${String(++this.evSeq).padStart(4, '0')}`;
    this.evidence.push({
      evidence_id: id,
      source_url: e.url,
      profile: e.profile,
      locator: e.locator,
      observed: truncate(String(e.observed ?? ''), 1200),
      expected: e.expected ?? null,
      captured_at: e.at ?? new Date().toISOString(),
      body_ref: e.body_ref ?? null,
      screenshot_ref: e.screenshot_ref ?? null,
    });
    return id;
  }

  finding(f: FindingInput): Finding {
    const rule = ruleById.get(f.check_id);
    if (!rule) throw new ContractError(`Unknown check ${f.check_id}`);
    const sources = f.sources ?? rule.source_ids;
    if (!f.evidence.length) throw new ContractError(`${f.check_id}/${f.reason_code}: a finding needs observed evidence`);
    if (f.status === 'FAIL' && !sources.some((s) => sourceById.get(s)?.label === 'DOCUMENTED')) {
      throw new ContractError(`${f.check_id}/${f.reason_code}: a FAIL needs a documented official source`);
    }
    const confidence = f.confidence ?? 'OBSERVED';
    if ((confidence === 'THIRD_PARTY' || confidence === 'MODELLED') && !f.caveat) {
      throw new ContractError(`${f.check_id}/${f.reason_code}: third-party/modelled findings need a caveat`);
    }
    const classification = f.classification ?? 'ISSUE';
    const priority: Finding['priority'] =
      classification === 'OPTIONAL' ? 'P4' : classification !== 'ISSUE' ? 'P3' : f.severity === 'CRITICAL' || f.severity === 'HIGH' ? 'P1' : f.severity === 'MEDIUM' ? 'P2' : 'P3';
    return {
      finding_id: `F-${String(++this.fSeq).padStart(4, '0')}`,
      check_id: f.check_id,
      finding_status: f.status,
      classification,
      reason_code: f.reason_code,
      severity: f.severity,
      confidence,
      caveat: f.caveat ?? null,
      affected_page_ids: f.pages,
      evidence_ids: f.evidence,
      source_ids: sources,
      title: f.title,
      explanation: f.explanation,
      practical_impact: f.impact,
      recommended_action: f.action,
      suggested_owner: f.owner,
      effort: f.effort,
      priority,
      related_findings: [],
      code: f.code ?? null,
    };
  }

  /**
   * Status precedence inside an applicable check: verified FAIL, verified WARN, missing required evidence
   * -> NOT_TESTABLE, otherwise PASS. Missing sub-checks stay visible as limitations either way.
   */
  result(c: { check_id: string; page_id?: string | null; evidence: string[]; findings?: Finding[]; notes?: string[]; limitations?: string[]; missing?: boolean; status?: CheckStatus; derivedStatus?: CheckStatus }): CheckResult {
    const rule = ruleById.get(c.check_id);
    if (!rule) throw new ContractError(`Unknown check ${c.check_id}`);
    const findings = c.findings ?? [];
    let status: CheckStatus;
    if (c.status === 'NOT_APPLICABLE' || c.status === 'NOT_TESTABLE' || c.status === 'ERROR') status = c.status;
    // Derived, unscored composites restate the outcome of other checks; they carry no findings of their own.
    else if (c.derivedStatus && rule.score === null) status = c.derivedStatus;
    else if (findings.some((f) => f.finding_status === 'FAIL')) status = 'FAIL';
    else if (findings.some((f) => f.finding_status === 'WARN')) status = 'WARN';
    else if (c.missing) status = 'NOT_TESTABLE';
    else status = 'PASS';
    const notes = [...(c.notes ?? [])];
    if (status === 'PASS' && !c.evidence.length) {
      status = 'ERROR';
      notes.push('Tool defect: a PASS was produced without supporting evidence.');
    }
    const res: CheckResult = {
      check_id: c.check_id,
      rule_version: rule.rule_version,
      category: rule.category,
      scope: rule.scope,
      page_id: c.page_id ?? null,
      status,
      score_included: rule.score !== null,
      evidence_ids: [...new Set([...c.evidence, ...findings.flatMap((f) => f.evidence_ids)])],
      findings: status === 'NOT_APPLICABLE' || status === 'ERROR' ? [] : findings,
      notes,
      limitations: c.limitations ?? [],
    };
    this.checks.push(res);
    return res;
  }

  na(check_id: string, page_id: string | null, reason: string) {
    return this.result({ check_id, page_id, evidence: [], status: 'NOT_APPLICABLE', notes: [reason] });
  }
  untestable(check_id: string, page_id: string | null, reason: string, evidence: string[] = []) {
    return this.result({ check_id, page_id, evidence, status: 'NOT_TESTABLE', limitations: [reason] });
  }

  /** Runs one check; an exception becomes ERROR for that unit and the rest of the audit continues. */
  async guard(check_id: string, page_id: string | null, fn: () => Promise<unknown> | unknown) {
    const before = this.checks.length;
    try {
      await fn();
    } catch (e: any) {
      this.checks.length = before;
      const rule = ruleById.get(check_id)!;
      this.checks.push({
        check_id, rule_version: rule.rule_version, category: rule.category, scope: rule.scope, page_id, status: 'ERROR', score_included: rule.score !== null,
        evidence_ids: [], findings: [], notes: [`Tool error while evaluating this check: ${String(e?.message ?? e).slice(0, 240)}`], limitations: ['This is a tool defect, not a website defect.'],
      });
    }
  }
}

export const rawValid = (p: PageWork) => p.raw.record.acquisition === 'OK' && p.raw.record.validity === 'VALID_PAGE' && p.raw.record.status === 200;
export const renValid = (p: PageWork) => p.rendered.record.acquisition === 'OK' && p.rendered.record.validity === 'VALID_PAGE' && (p.rendered.record.status === null || p.rendered.record.status === 200 || p.rendered.record.status === 304);
export const anyValid = (p: PageWork) => rawValid(p) || renValid(p);

/** Extract used for content conclusions: the rendered DOM when genuine, otherwise the genuine RAW document. */
export function bestExtract(p: PageWork): { ex: Extracted; profile: 'RAW' | 'RENDERED'; url: string } | null {
  if (renValid(p) && p.rec.rendered_extract) return { ex: p.rec.rendered_extract, profile: 'RENDERED', url: p.rendered.record.final_url ?? p.rec.url };
  if (rawValid(p) && p.rec.raw_extract) return { ex: p.rec.raw_extract, profile: 'RAW', url: p.raw.record.final_url ?? p.rec.url };
  return null;
}

/** Why content checks cannot be evaluated on this page, or null when they can. */
export function contentGate(p: PageWork): { status: 'NOT_TESTABLE' | 'NOT_APPLICABLE'; reason: string } | null {
  if (anyValid(p)) return null;
  switch (p.rec.state) {
    case 'BLOCKED':
      return { status: 'NOT_TESTABLE', reason: 'ROBOTS_DISALLOWED_FOR_AUDITOR: robots.txt does not allow this auditor to fetch the page, so its content was not read.' };
    case 'CHALLENGED':
      return { status: 'NOT_TESTABLE', reason: 'ACCESS_CHALLENGE_DETECTED: this auditor received an access challenge instead of the page. No content conclusion is drawn; this does not show that Googlebot or other vendor crawlers are challenged.' };
    case 'ERROR_PAGE':
      return { status: 'NOT_APPLICABLE', reason: `The page returned HTTP ${p.raw.record.status ?? p.rendered.record.status}; content checks do not apply to an error document.` };
    default:
      return {
        status: 'NOT_TESTABLE',
        reason: `No genuine page response was available (RAW: ${describeProfile(p.raw.record)}; RENDERED: ${describeProfile(p.rendered.record)}).`,
      };
  }
}

export function describeProfile(r: { acquisition: string; validity: string | null; status: number | null }): string {
  if (r.acquisition !== 'OK') return r.acquisition;
  return `${r.validity ?? 'UNKNOWN'}${r.status !== null ? ` (HTTP ${r.status})` : ''}`;
}

export function isIntentional(p: PageWork, config: AuditConfig): boolean {
  return p.rec.intent === 'intentional_restriction' || config.environment === 'staging' || config.visibility_goal === 'restricted';
}
