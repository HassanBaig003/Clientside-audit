import fs from 'node:fs';
import type { AppConfig } from '../config';
import { RunContext, decodeBody, type RawResult } from '../net/context';
import type { RenderResult } from '../net/browser';
import { renderPdf } from '../net/browser';
import { Acquirer } from '../net/acquire';
import { Store, newId } from '../store/db';
import type { Audit, AuditConfig, Budgets } from '../types';
import { applyOperatorSelection, newAudit, runChecks, runDiscovery, type Reuse } from './pipeline';
import { InputError, fetchKey, parseTargetUrl } from '../util/url';
import { buildReportHtml } from '../report/html';
import ipaddr from 'ipaddr.js';
import { isPublicAddress } from '../net/ssrf';

export interface StartInput {
  project_id: string;
  url: string;
  client_name?: string;
  sample_size?: number;
  pages?: string[];
  visibility_goal?: AuditConfig['visibility_goal'];
  environment?: AuditConfig['environment'];
  multilingual?: boolean;
  report_language?: string;
  intentional_restrictions?: string[];
  branding?: Partial<AuditConfig['branding']>;
  auto_run?: boolean;
  budgets?: Partial<Budgets>;
}

/** Obvious non-public destinations are refused at input. Names that resolve to private addresses are refused at fetch time. */
function assertPublicTarget(u: URL, cfg: AppConfig) {
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (cfg.fixture.enabled && host.endsWith(cfg.fixture.hostSuffix)) return;
  if (ipaddr.isValid(host) ? !isPublicAddress(host) : host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) {
    throw new InputError('That address is not a public website. Private, loopback and link-local destinations cannot be audited.');
  }
}

export class ServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Background job runner with persisted stage transitions, cancellation and bounded retries.
 * The audit JSON is saved after every stage and page, so partial results survive a timeout or worker failure.
 */
export class AuditService {
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private contexts = new Map<string, RunContext>();
  private idle: (() => void)[] = [];

  constructor(readonly cfg: AppConfig, readonly store: Store) {}

  private enqueue(job: () => Promise<void>) {
    this.queue.push(job);
    this.pump();
  }
  private pump() {
    while (this.active < this.cfg.maxConcurrentAudits && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      job()
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.pump();
          if (!this.active && !this.queue.length) this.idle.splice(0).forEach((f) => f());
        });
    }
  }
  /** Resolves when no job is queued or running (used by tests and the demo script). */
  whenIdle(): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  private buildConfig(input: StartInput, clientName: string): AuditConfig {
    const budgets: Budgets = { ...this.cfg.budgets };
    // Operators may tighten budgets per run; they can never exceed the configured product limits.
    for (const [k, v] of Object.entries(input.budgets ?? {})) {
      const key = k as keyof Budgets;
      if (key in budgets && typeof v === 'number' && Number.isFinite(v) && v >= 0) budgets[key] = Math.min(budgets[key], v);
    }
    const size = Math.max(1, Math.min(budgets.max_selected_pages, Math.floor(input.sample_size ?? budgets.max_selected_pages)));
    const pages = (input.pages ?? []).slice(0, 10).map((u) => fetchKey(parseTargetUrl(u)));
    const logo = input.branding?.logo_data_uri ?? null;
    if (logo && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new InputError('The logo must be a base64 data URI of an approved PNG, JPEG, WebP or SVG image.');
    return {
      sample_size: size, operator_urls: pages, visibility_goal: input.visibility_goal ?? 'search_ai_discovery', environment: input.environment ?? 'production',
      multilingual: !!input.multilingual, report_language: input.report_language ?? 'en', form_factor: 'mobile', intentional_restrictions: (input.intentional_restrictions ?? []).slice(0, 20),
      branding: { client_display_name: input.branding?.client_display_name ?? clientName, logo_data_uri: logo, prepared_by: input.branding?.prepared_by ?? null },
      budgets, auto_run: input.auto_run !== false,
    };
  }

  start(tenant: string, input: StartInput): Audit {
    const project = this.store.getProject(tenant, input.project_id);
    if (!project) throw new ServiceError(404, 'Project not found.');
    const url = parseTargetUrl(input.url); // rejects non-HTTP(S) schemes before anything is queued
    assertPublicTarget(url, this.cfg);
    for (const p of input.pages ?? []) assertPublicTarget(parseTargetUrl(p), this.cfg);
    const clientName = (input.client_name ?? project.name).slice(0, 120);
    const audit = newAudit({ audit_id: newId('aud'), tenant_id: tenant, project_id: project.id, client_name: clientName, input_url: input.url.trim(), config: this.buildConfig(input, clientName), cfg: this.cfg });
    audit.target.host = url.hostname;
    this.store.saveAudit(audit);
    this.enqueue(() => this.execute(audit.audit_id, 'full'));
    return audit;
  }

  /** Continue after the optional page-selection review. */
  runSelected(tenant: string, auditId: string, pages?: string[]): Audit {
    const audit = this.store.loadAudit(tenant, auditId);
    if (!audit) throw new ServiceError(404, 'Audit not found.');
    if (audit.status !== 'AWAITING_SELECTION') throw new ServiceError(409, `The audit is ${audit.status}; it is not waiting for page selection.`);
    if (pages && pages.length) applyOperatorSelection(audit, pages, audit.config.budgets.max_selected_pages);
    if (!audit.pages.length) throw new ServiceError(400, 'Select at least one page.');
    audit.status = 'QUEUED';
    this.store.saveAudit(audit);
    this.enqueue(() => this.execute(auditId, 'checks'));
    return audit;
  }

  cancel(tenant: string, auditId: string): Audit {
    const audit = this.store.loadAudit(tenant, auditId);
    if (!audit) throw new ServiceError(404, 'Audit not found.');
    const ctx = this.contexts.get(auditId);
    if (ctx) ctx.cancel();
    else if (['QUEUED', 'AWAITING_SELECTION', 'DISCOVERING', 'RUNNING'].includes(audit.status)) {
      audit.status = 'CANCELLED';
      audit.stop_reason = 'CANCELLED';
      audit.timings.finished_at = new Date().toISOString();
      for (const s of audit.stages) if (s.state === 'PENDING' || s.state === 'RUNNING') s.state = 'CANCELLED';
      this.store.saveAudit(audit);
    }
    return this.store.loadAudit(tenant, auditId)!;
  }

  /**
   * Bounded retry of unavailable checks: a new run over the same sample that reuses stored evidence for pages
   * whose RAW and RENDERED profiles were both genuine, and re-acquires only what was unavailable.
   */
  retry(tenant: string, auditId: string): Audit {
    const prev = this.store.loadAudit(tenant, auditId);
    if (!prev) throw new ServiceError(404, 'Audit not found.');
    if (!['COMPLETED', 'PARTIAL', 'CANCELLED', 'INTERRUPTED', 'FAILED'].includes(prev.status)) throw new ServiceError(409, 'The audit is still running.');
    if (prev.retry_count >= this.cfg.maxRetriesPerAudit) throw new ServiceError(409, `The retry limit (${this.cfg.maxRetriesPerAudit}) for this audit has been reached. Start a new audit instead.`);
    if (!prev.pages.length) throw new ServiceError(409, 'There is no sample to retry. Start a new audit instead.');
    const audit = newAudit({ audit_id: newId('aud'), tenant_id: tenant, project_id: prev.project_id, client_name: prev.client_name, input_url: prev.target.input_url, config: { ...prev.config, auto_run: true }, cfg: this.cfg, retry_of: prev.audit_id, retry_count: prev.retry_count + 1 });
    audit.target = prev.target;
    audit.mode = prev.mode;
    audit.discovery = prev.discovery;
    audit.pages = prev.pages.map((p) => ({ ...p }));
    const d = audit.stages.find((s) => s.id === 'discovery')!;
    d.state = 'SKIPPED';
    d.detail = `Sample reused from ${prev.audit_id}`;
    this.store.saveAudit(audit);
    this.enqueue(() => this.execute(audit.audit_id, 'checks', prev));
    return audit;
  }

  private loadReuse(prev: Audit, ctx: RunContext): Reuse {
    const from = this.store.blobs(prev.audit_id);
    const reuse: Reuse = { raw: new Map(), rendered: new Map() };
    for (const p of prev.pages) {
      const ok = p.state === 'VALID' && p.raw.validity === 'VALID_PAGE' && p.rendered.validity === 'VALID_PAGE' && p.raw.body_ref && p.rendered.dom_ref;
      if (!ok) continue;
      const body = from.get(p.raw.body_ref!);
      const dom = from.get(p.rendered.dom_ref!);
      if (!body || !dom) continue;
      ctx.blobs.put(p.raw.body_ref!, body);
      ctx.blobs.put(p.rendered.dom_ref!, dom);
      const shot = p.rendered.screenshot_ref ? from.get(p.rendered.screenshot_ref) : null;
      if (shot && p.rendered.screenshot_ref) ctx.blobs.put(p.rendered.screenshot_ref, shot);
      const raw: RawResult = { record: { ...p.raw, from_cache: true }, body, text: decodeBody(body, p.raw.content_type) };
      const rendered: RenderResult = { record: { ...p.rendered }, dom: dom.toString('utf8') };
      reuse.raw.set(fetchKey(p.url), raw);
      reuse.rendered.set(fetchKey(p.url), rendered);
      ctx.cache.set(fetchKey(p.url), raw);
    }
    return reuse;
  }

  private async execute(auditId: string, mode: 'full' | 'checks', prev?: Audit) {
    const audit = this.store.loadAuditInternal(auditId);
    if (!audit || audit.status === 'CANCELLED') return;
    const ctx = new RunContext(this.cfg, audit.config.budgets, this.store.blobs(auditId));
    this.contexts.set(auditId, ctx);
    const acq = new Acquirer(ctx);
    const hooks = { save: (a: Audit) => this.store.saveAudit(a) };
    try {
      if (mode === 'full') {
        await runDiscovery(audit, acq, hooks);
        if (ctx.stopReason === 'CANCELLED') return this.finishCancelled(audit);
        if (!audit.config.auto_run) {
          audit.status = 'AWAITING_SELECTION';
          hooks.save(audit);
          return;
        }
      }
      if (!audit.pages.length) {
        audit.status = 'FAILED';
        audit.run_quality = 'INSUFFICIENT';
        audit.stop_reason = 'No page could be selected for this target.';
        audit.timings.finished_at = new Date().toISOString();
        hooks.save(audit);
        return;
      }
      const reuse = prev ? this.loadReuse(prev, ctx) : undefined;
      if (prev && reuse) audit.limitations.push(`Bounded retry ${audit.retry_count} of ${this.cfg.maxRetriesPerAudit}: evidence for ${reuse.raw.size} previously valid page(s) was reused from ${prev.audit_id}; the remaining pages and all site-level and third-party checks were re-run.`);
      await runChecks(audit, acq, hooks, reuse);
      if ((audit.status as string) === 'CANCELLED') return this.finishCancelled(audit);
      // Release the audit browser before the PDF browser starts, so only one Chromium is ever in memory.
      await acq.close();
      await this.generateReportFor(audit);
    } catch (e: any) {
      audit.status = 'FAILED';
      audit.stop_reason = `Tool error: ${String(e?.message ?? e).slice(0, 300)}`;
      audit.run_quality = audit.pages.some((p) => p.state === 'VALID') ? 'PARTIAL' : 'INSUFFICIENT';
      audit.timings.finished_at = new Date().toISOString();
      for (const s of audit.stages) if (s.state === 'RUNNING') (s.state = 'FAILED'), (s.finished_at = new Date().toISOString());
      hooks.save(audit);
    } finally {
      this.contexts.delete(auditId);
      await acq.close();
    }
  }

  private finishCancelled(audit: Audit) {
    audit.status = 'CANCELLED';
    audit.stop_reason = 'CANCELLED';
    audit.timings.finished_at = audit.timings.finished_at ?? new Date().toISOString();
    for (const s of audit.stages) if (s.state === 'PENDING' || s.state === 'RUNNING') (s.state = 'CANCELLED'), (s.finished_at = new Date().toISOString());
    this.store.saveAudit(audit);
  }

  /** PDF generation reads the stored, completed audit. It never re-runs the website and never changes scores. */
  async generateReportFor(audit: Audit): Promise<void> {
    const s = audit.stages.find((x) => x.id === 'report')!;
    s.state = 'RUNNING';
    s.started_at = new Date().toISOString();
    audit.report = { state: 'GENERATING', generated_at: null, error: null, bytes: null };
    this.store.saveAudit(audit);
    try {
      const html = buildReportHtml(audit, (ref) => this.store.blobs(audit.audit_id).get(ref));
      const pdf = await renderPdf(html, { executablePath: this.cfg.chromium.executablePath, noSandbox: this.cfg.chromium.noSandbox, footerLeft: `${audit.client_name} - Initial Website SEO and AI Content Readiness Audit${audit.mode === 'FIXTURE_DEMO' ? ' - FIXTURE / DEMO DATA' : ''}` });
      fs.writeFileSync(this.store.reportPath(audit.audit_id), pdf);
      audit.report = { state: 'READY', generated_at: new Date().toISOString(), error: null, bytes: pdf.length };
      s.state = 'DONE';
    } catch (e: any) {
      audit.report = { state: 'FAILED', generated_at: null, error: String(e?.message ?? e).split('\n')[0].slice(0, 300), bytes: null };
      s.state = 'FAILED';
      s.detail = 'PDF export failed; the audit results are unaffected.';
    }
    s.finished_at = new Date().toISOString();
    this.store.saveAudit(audit);
  }

  regenerateReport(tenant: string, auditId: string, branding?: Partial<AuditConfig['branding']>): Audit {
    const audit = this.store.loadAudit(tenant, auditId);
    if (!audit) throw new ServiceError(404, 'Audit not found.');
    if (branding) {
      // Only approved presentation fields can change; findings, counts and scores are never touched.
      const logo = branding.logo_data_uri;
      if (logo && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new ServiceError(400, 'The logo must be a base64 data URI of an approved PNG, JPEG, WebP or SVG image.');
      audit.config.branding = { ...audit.config.branding, ...Object.fromEntries(Object.entries(branding).filter(([, v]) => v !== undefined)) };
    }
    if (!['COMPLETED', 'PARTIAL'].includes(audit.status)) throw new ServiceError(409, `A report can be generated only for a finished audit (this one is ${audit.status}).`);
    if (audit.report.state === 'GENERATING') return audit;
    audit.report = { state: 'GENERATING', generated_at: null, error: null, bytes: null };
    this.store.saveAudit(audit);
    this.enqueue(() => this.generateReportFor(audit));
    return audit;
  }
}
