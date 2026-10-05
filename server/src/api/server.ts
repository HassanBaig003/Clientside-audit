import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { Store } from '../store/db';
import { AuditService, ServiceError } from '../jobs/service';
import { InputError } from '../util/url';
import { RULES, RULE_REGISTRY_VERSION, TECH_WEIGHTS, AI_BUCKETS, CATEGORY_LABELS } from '../checks/registry';
import { BOTS, FEATURES, FEATURE_REGISTRY_REVIEWED, FEATURE_REGISTRY_VERSION, SOURCES, SOURCE_REGISTRY_REVIEWED } from '../sources/registry';
import type { Audit } from '../types';

const COOKIE = 'wa_session';
const SESSION_HOURS = 12;

const StartSchema = z.object({
  project_id: z.string().min(1).max(64),
  url: z.string().min(3).max(2048),
  client_name: z.string().max(120).optional(),
  sample_size: z.number().int().min(1).max(10).optional(),
  pages: z.array(z.string().max(2048)).max(10).optional(),
  visibility_goal: z.enum(['search_ai_discovery', 'restricted']).optional(),
  environment: z.enum(['production', 'staging']).optional(),
  multilingual: z.boolean().optional(),
  report_language: z.string().max(12).optional(),
  intentional_restrictions: z.array(z.string().max(2048)).max(20).optional(),
  branding: z.object({ client_display_name: z.string().max(120).nullable().optional(), logo_data_uri: z.string().max(400000).nullable().optional(), prepared_by: z.string().max(120).nullable().optional() }).optional(),
  auto_run: z.boolean().optional(),
  budgets: z.record(z.number()).optional(),
});

export interface App {
  fastify: FastifyInstance;
  service: AuditService;
  store: Store;
}

export async function buildApp(cfg: AppConfig): Promise<App> {
  const store = new Store(cfg.dataDir);
  const interrupted = store.recoverInterrupted();
  const service = new AuditService(cfg, store);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  if (interrupted.length) console.warn(`[audit] ${interrupted.length} audit(s) were interrupted by a restart and marked INTERRUPTED.`);

  const sign = (payload: string) => crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url');
  const makeSession = (tenant: string) => {
    const payload = `${tenant}.${Date.now() + SESSION_HOURS * 3600_000}`;
    return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  };
  const readSession = (value: string | undefined): string | null => {
    if (!value) return null;
    const [b64, mac] = value.split('.');
    if (!b64 || !mac) return null;
    const payload = Buffer.from(b64, 'base64url').toString();
    const expected = sign(payload);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    const idx = payload.lastIndexOf('.');
    return Number(payload.slice(idx + 1)) > Date.now() ? payload.slice(0, idx) : null;
  };
  const tokenTenant = (token: string): string | null => {
    for (const [known, t] of cfg.authTokens) {
      if (known.length === token.length && crypto.timingSafeEqual(Buffer.from(known), Buffer.from(token))) return t.tenant_id;
    }
    return null;
  };

  /** Integration boundary: replace this with the host application's auth and it must return the tenant id. */
  const tenantOf = (req: FastifyRequest): string | null => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return tokenTenant(auth.slice(7).trim());
    return readSession(req.cookies[COOKIE]);
  };

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; object-src 'self'; font-src 'self' data:; base-uri 'none'; frame-ancestors 'self'");
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof InputError) return reply.code(400).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request.', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error('[api]', err);
    return reply.code(500).send({ error: 'Internal error.' });
  });

  const api = async (r: FastifyInstance) => {
    r.addHook('preHandler', async (req, reply) => {
      const open = req.url.startsWith('/api/v1/health') || req.url.startsWith('/api/v1/auth/login') || req.url.startsWith('/api/v1/config');
      if (open) return;
      const tenant = tenantOf(req);
      if (!tenant) return reply.code(401).send({ error: 'Authentication required.' });
      (req as any).tenant = tenant;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Cookie sessions: same-origin JSON only.
        const origin = req.headers.origin;
        if (origin && !req.headers.authorization && new URL(origin).host !== req.headers.host) return reply.code(403).send({ error: 'Cross-origin request refused.' });
      }
    });
    const T = (req: FastifyRequest) => (req as any).tenant as string;
    const need = (tenant: string, id: string): Audit => {
      const a = store.loadAudit(tenant, id);
      if (!a) throw new ServiceError(404, 'Audit not found.'); // same answer for "missing" and "another tenant's"
      return a;
    };

    r.get('/health', async () => ({ ok: true }));
    r.get('/config', async () => ({
      fixture_mode: cfg.fixture.enabled, fixture_host_suffix: cfg.fixture.enabled ? cfg.fixture.hostSuffix : null,
      field_data_configured: !!cfg.crux.apiKey, semantic_review_configured: !!(cfg.llm.apiKey && cfg.llm.model),
      max_pages: cfg.budgets.max_selected_pages, budgets: cfg.budgets, auditor_user_agent: undefined,
    }));

    r.post('/auth/login', async (req, reply) => {
      const body = z.object({ token: z.string().min(1).max(200) }).parse(req.body);
      const tenant = tokenTenant(body.token);
      if (!tenant) return reply.code(401).send({ error: 'Invalid access token.' });
      reply.setCookie(COOKIE, makeSession(tenant), { httpOnly: true, sameSite: 'strict', secure: cfg.secureCookies, path: '/', maxAge: SESSION_HOURS * 3600 });
      return { tenant_id: tenant };
    });
    r.post('/auth/logout', async (_req, reply) => {
      reply.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });
    r.get('/auth/me', async (req) => ({ tenant_id: T(req) }));

    r.get('/projects', async (req) => ({ projects: store.listProjects(T(req)) }));
    r.post('/projects', async (req, reply) => {
      const b = z.object({ name: z.string().min(1).max(120), website: z.string().max(2048).nullable().optional() }).parse(req.body);
      return reply.code(201).send(store.createProject(T(req), b.name.trim(), b.website ?? null));
    });

    r.post('/audits', async (req, reply) => {
      const audit = service.start(T(req), StartSchema.parse(req.body));
      return reply.code(202).send({ audit_id: audit.audit_id, job_id: audit.audit_id, status: audit.status });
    });
    r.get('/audits', async (req) => {
      const q = z.object({ project_id: z.string().optional() }).parse(req.query);
      return { audits: store.listAudits(T(req), q.project_id).map((a) => ({ ...a, summary: a.summary_json ? JSON.parse(a.summary_json) : null, summary_json: undefined })) };
    });
    r.get('/audits/:id', async (req) => need(T(req), (req.params as any).id));
    r.get('/audits/:id/export', async (req, reply) => {
      const a = need(T(req), (req.params as any).id);
      reply.header('Content-Disposition', `attachment; filename="audit-${a.audit_id}.json"`).type('application/json');
      return JSON.stringify(a, null, 2);
    });
    r.get('/audits/:id/progress', async (req) => {
      const a = need(T(req), (req.params as any).id);
      const started = a.timings.started_at ? new Date(a.timings.started_at).getTime() : null;
      return {
        audit_id: a.audit_id, status: a.status, mode: a.mode, run_quality: a.run_quality, stop_reason: a.stop_reason, stages: a.stages,
        elapsed_ms: a.timings.elapsed_ms ?? (started ? Date.now() - started : 0),
        pages: a.pages.map((p) => ({ page_id: p.page_id, url: p.url, page_type: p.page_type, state: p.state, raw: p.raw.acquisition === 'OK' ? p.raw.validity : p.raw.acquisition, rendered: p.rendered.acquisition === 'OK' ? p.rendered.validity : p.rendered.acquisition })),
        coverage: a.coverage.pages,
        partial: { checks: a.checks.length, findings: a.checks.reduce((n, c) => n + c.findings.length, 0), fail: a.checks.filter((c) => c.status === 'FAIL').length, warn: a.checks.filter((c) => c.status === 'WARN').length },
        report: a.report,
      };
    });
    r.post('/audits/:id/run', async (req, reply) => {
      const b = z.object({ pages: z.array(z.string().max(2048)).max(10).optional() }).parse(req.body ?? {});
      const a = service.runSelected(T(req), (req.params as any).id, b.pages);
      return reply.code(202).send({ audit_id: a.audit_id, job_id: a.audit_id, status: a.status });
    });
    r.post('/audits/:id/cancel', async (req) => {
      const a = service.cancel(T(req), (req.params as any).id);
      return { audit_id: a.audit_id, status: a.status };
    });
    r.post('/audits/:id/retry', async (req, reply) => {
      const a = service.retry(T(req), (req.params as any).id);
      return reply.code(202).send({ audit_id: a.audit_id, job_id: a.audit_id, status: a.status, retry_of: a.retry_of });
    });

    r.get('/audits/:id/assets/:name', async (req, reply) => {
      const { id, name } = req.params as any;
      const f = store.assetPath(T(req), id, name);
      if (!f) return reply.code(404).send({ error: 'Not found.' });
      if (/\.jpe?g$/i.test(name)) return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=3600').send(fs.createReadStream(f));
      // Fetched HTML is untrusted: it is only ever served as a plain-text download, never rendered on this origin.
      return reply.type('text/plain; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.txt"`).header('Content-Security-Policy', "sandbox; default-src 'none'").send(fs.createReadStream(f));
    });

    r.get('/audits/:id/report', async (req) => need(T(req), (req.params as any).id).report);
    r.post('/audits/:id/report', async (req, reply) => {
      const b = z.object({ branding: StartSchema.shape.branding }).parse(req.body ?? {});
      const a = service.regenerateReport(T(req), (req.params as any).id, b.branding ?? undefined);
      return reply.code(202).send(a.report);
    });
    r.get('/audits/:id/report/download', async (req, reply) => {
      const a = need(T(req), (req.params as any).id);
      const f = store.reportPath(a.audit_id);
      if (a.report.state !== 'READY' || !fs.existsSync(f)) return reply.code(409).send({ error: `The report is not ready (state: ${a.report.state}).` });
      const q = z.object({ inline: z.string().optional() }).parse(req.query);
      const safe = a.target.host.replace(/[^a-z0-9.-]/gi, '_');
      reply.header('Content-Disposition', `${q.inline ? 'inline' : 'attachment'}; filename="wellows-initial-audit-${safe}-${a.audit_id}.pdf"`);
      return reply.type('application/pdf').send(fs.createReadStream(f));
    });

    r.get('/registry/rules', async () => ({ version: RULE_REGISTRY_VERSION, category_labels: CATEGORY_LABELS, technical_weights: TECH_WEIGHTS, ai_weights: AI_BUCKETS, rules: RULES }));
    r.get('/registry/sources', async () => ({ reviewed: SOURCE_REGISTRY_REVIEWED, sources: SOURCES, features: { version: FEATURE_REGISTRY_VERSION, reviewed: FEATURE_REGISTRY_REVIEWED, items: FEATURES }, bots: BOTS }));
  };
  await app.register(api, { prefix: '/api/v1' });

  if (cfg.webDir && fs.existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply: FastifyReply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
      return reply.sendFile('index.html');
    });
  }
  return { fastify: app, service, store };
}
