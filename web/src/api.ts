import type { Audit, AuditStatus, StageRecord } from '../../server/src/types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: string[]) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'The audit service could not be reached. Check your connection and try again.');
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status}).`, json.details);
  return json as T;
}

export interface Project { id: string; name: string; website: string | null; created_at: string }
export interface AuditListItem {
  id: string; project_id: string; status: AuditStatus; mode: string; input_url: string; retry_of: string | null; created_at: string;
  summary: { client_name: string; host: string; run_quality: string; technical_health: number | null; ai_accessibility: number | null; pages: Audit['coverage']['pages']; counts: Audit['summary']['counts']; report: string; finished_at: string | null; retry_count: number } | null;
}
export interface Progress {
  audit_id: string; status: AuditStatus; mode: string; run_quality: string; stop_reason: string | null; stages: StageRecord[]; elapsed_ms: number;
  pages: { page_id: string; url: string; page_type: string; state: string; raw: string | null; rendered: string | null }[];
  coverage: Audit['coverage']['pages']; partial: { checks: number; findings: number; fail: number; warn: number }; report: Audit['report'];
}
export interface AppConfig { fixture_mode: boolean; fixture_host_suffix: string | null; field_data_configured: boolean; semantic_review_configured: boolean; max_pages: number }

export const api = {
  config: () => call<AppConfig>('GET', '/config'),
  me: () => call<{ tenant_id: string }>('GET', '/auth/me'),
  login: (token: string) => call<{ tenant_id: string }>('POST', '/auth/login', { token }),
  logout: () => call('POST', '/auth/logout', {}),
  projects: () => call<{ projects: Project[] }>('GET', '/projects'),
  createProject: (name: string, website: string | null) => call<Project>('POST', '/projects', { name, website }),
  audits: (projectId?: string) => call<{ audits: AuditListItem[] }>('GET', `/audits${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  start: (body: Record<string, unknown>) => call<{ audit_id: string; status: string }>('POST', '/audits', body),
  audit: (id: string) => call<Audit>('GET', `/audits/${id}`),
  progress: (id: string) => call<Progress>('GET', `/audits/${id}/progress`),
  runSelected: (id: string, pages: string[]) => call<{ audit_id: string }>('POST', `/audits/${id}/run`, { pages }),
  cancel: (id: string) => call('POST', `/audits/${id}/cancel`, {}),
  retry: (id: string) => call<{ audit_id: string }>('POST', `/audits/${id}/retry`, {}),
  report: (id: string) => call<Audit['report']>('GET', `/audits/${id}/report`),
  regenerate: (id: string, branding?: Record<string, unknown>) => call<Audit['report']>('POST', `/audits/${id}/report`, branding ? { branding } : {}),
  assetUrl: (id: string, name: string) => `/api/v1/audits/${id}/assets/${encodeURIComponent(name)}`,
  pdfUrl: (id: string, inline = false) => `/api/v1/audits/${id}/report/download${inline ? '?inline=1' : ''}`,
  exportUrl: (id: string) => `/api/v1/audits/${id}/export`,
  /** Rasterised report pages. Only the read-only preview build provides this; the product shows the PDF itself. */
  previewPages: undefined as undefined | ((id: string) => string[]),
  rules: () => call<{ rules: { check_id: string; name: string }[] }>('GET', '/registry/rules'),
};

export const ACTIVE: AuditStatus[] = ['QUEUED', 'DISCOVERING', 'RUNNING'];
