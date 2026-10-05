import path from 'node:path';
import crypto from 'node:crypto';
import type { Budgets } from './types';

/** Product limits. These are not search-engine requirements and not a promised completion time. */
export const DEFAULT_BUDGETS: Budgets = {
  max_selected_pages: 10,
  max_discovery_documents: 30,
  max_discovery_depth: 2,
  max_links_per_document: 300,
  max_internal_link_targets: 20,
  max_canonical_target_fetches: 10,
  max_hreflang_alternate_fetches: 10,
  max_lab_performance_pages: 3,
  max_redirect_hops: 10,
  concurrency_per_host: 2,
  minimum_request_spacing_ms: 500,
  connect_timeout_ms: 5000,
  read_timeout_ms: 12000,
  render_timeout_ms: 10000,
  max_document_bytes: 10485760,
  run_hard_budget_seconds: 300,
  max_browser_resources_per_page: 250,
  max_browser_bytes_per_page: 25 * 1024 * 1024,
  max_query_variants_per_path: 2,
};

export interface TenantToken {
  tenant_id: string;
  label: string;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  webDir: string | null;
  sessionSecret: string;
  secureCookies: boolean;
  authTokens: Map<string, TenantToken>;
  auditor: { token: string; version: string; contactUrl: string | null };
  allowedPorts: number[];
  budgets: Budgets;
  maxConcurrentAudits: number;
  maxRetriesPerAudit: number;
  crux: { apiKey: string | null; baseUrl: string };
  llm: { apiKey: string | null; model: string | null; baseUrl: string; maxInputChars: number; maxOutputTokens: number; timeoutMs: number };
  chromium: { executablePath: string | null; noSandbox: boolean };
  /**
   * Fixture/demo mode. Hosts ending in `hostSuffix` are routed to local fixture servers.
   * Audits of those hosts are stamped FIXTURE_DEMO and can never be presented as a client audit.
   */
  fixture: { enabled: boolean; hostSuffix: string; httpPort: number; httpsPort: number; address: string };
  rateLimitStopThreshold: number;
  challengeStopThreshold: number;
}

function parseTokens(raw: string | undefined): Map<string, TenantToken> {
  const map = new Map<string, TenantToken>();
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    // token:tenant_id[:label]
    const [token, tenant, ...label] = part.split(':');
    if (!token || !tenant) continue;
    if (token.length < 16) throw new Error('AUDIT_API_TOKENS: each token must be at least 16 characters');
    map.set(token, { tenant_id: tenant, label: label.join(':') || tenant });
  }
  return map;
}

function int(v: string | undefined, d: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const budgets: Budgets = { ...DEFAULT_BUDGETS };
  for (const k of Object.keys(budgets) as (keyof Budgets)[]) {
    const v = env[`BUDGET_${k.toUpperCase()}`];
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) budgets[k] = Number(v);
  }
  // The 10-page ceiling is a product rule; configuration may lower it but never raise it.
  budgets.max_selected_pages = Math.max(1, Math.min(10, budgets.max_selected_pages));

  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 8080),
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : path.resolve('./dist/web'),
    sessionSecret: env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex'),
    secureCookies: env.SECURE_COOKIES !== '0',
    authTokens: parseTokens(env.AUDIT_API_TOKENS),
    auditor: {
      token: env.AUDITOR_ROBOTS_TOKEN ?? 'WellowsAuditBot',
      version: env.AUDITOR_VERSION ?? '1.0',
      contactUrl: env.AUDITOR_CONTACT_URL || null,
    },
    allowedPorts: (env.ALLOWED_PORTS ?? '80,443').split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
    budgets,
    maxConcurrentAudits: int(env.MAX_CONCURRENT_AUDITS, 1),
    maxRetriesPerAudit: int(env.MAX_RETRIES_PER_AUDIT, 2),
    crux: { apiKey: env.CRUX_API_KEY || null, baseUrl: env.CRUX_API_BASE ?? 'https://chromeuxreport.googleapis.com/v1' },
    llm: {
      apiKey: env.LLM_API_KEY || null,
      model: env.LLM_MODEL || null,
      baseUrl: env.LLM_API_BASE ?? 'https://api.anthropic.com',
      maxInputChars: int(env.LLM_MAX_INPUT_CHARS, 40000),
      maxOutputTokens: int(env.LLM_MAX_OUTPUT_TOKENS, 3000),
      timeoutMs: int(env.LLM_TIMEOUT_MS, 60000),
    },
    chromium: { executablePath: env.CHROMIUM_EXECUTABLE_PATH || null, noSandbox: env.CHROMIUM_NO_SANDBOX === '1' },
    fixture: {
      enabled: env.FIXTURE_MODE === '1',
      hostSuffix: env.FIXTURE_HOST_SUFFIX ?? '.test',
      httpPort: int(env.FIXTURE_HTTP_PORT, 18080),
      httpsPort: int(env.FIXTURE_HTTPS_PORT, 18443),
      address: '127.0.0.1',
    },
    rateLimitStopThreshold: int(env.RATE_LIMIT_STOP_THRESHOLD, 2),
    challengeStopThreshold: int(env.CHALLENGE_STOP_THRESHOLD, 3),
  };
}

export function auditorUserAgent(cfg: AppConfig): string {
  const contact = cfg.auditor.contactUrl ? ` (+${cfg.auditor.contactUrl})` : '';
  return `${cfg.auditor.token}/${cfg.auditor.version}${contact}`;
}

/** The rendering profile is real Chromium; it says so and appends the auditor token. It never claims to be a vendor crawler. */
export function browserUserAgent(cfg: AppConfig): string {
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 ${auditorUserAgent(cfg)}`;
}
