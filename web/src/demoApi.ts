/**
 * Read-only stand-in for api.ts, used only by the static preview build (vite.demo.config.ts).
 * It serves stored FIXTURE / DEMO audits that were embedded in the page; nothing here can run an audit.
 */
import type { Audit } from '../../server/src/types';
import { ApiError, ACTIVE, type AppConfig, type AuditListItem, type Progress, type Project } from './api';

export { ApiError, ACTIVE };
export type { AppConfig, AuditListItem, Progress, Project };

interface DemoData {
  audits: Audit[];
  assets: Record<string, string>;
  report_pages: Record<string, string[]>;
  rules: { check_id: string; name: string }[];
  files: { path: string; content: string }[];
}
export const DEMO: DemoData = (globalThis as any).__WA_DEMO__;
const READ_ONLY = 'This preview is read-only. Running or changing an audit needs the deployed server; see the Deploy screen.';
const find = (id: string): Audit => {
  const a = DEMO.audits.find((x) => x.audit_id === id);
  if (!a) throw new ApiError(404, 'Audit not found.');
  return a;
};
const ok = <T,>(v: T) => Promise.resolve(v);
const no = () => Promise.reject(new ApiError(0, READ_ONLY));

export const api = {
  config: () => ok<AppConfig>({ fixture_mode: true, fixture_host_suffix: '.test', field_data_configured: true, semantic_review_configured: false, max_pages: 10 }),
  me: () => ok({ tenant_id: 'preview' }),
  login: (_t: string) => ok({ tenant_id: 'preview' }),
  logout: () => ok({}),
  projects: () => ok<{ projects: Project[] }>({ projects: [{ id: DEMO.audits[0].project_id, name: 'Fixture clients (preview)', website: null, created_at: DEMO.audits[0].timings.created_at }] }),
  createProject: (_n: string, _w: string | null): Promise<Project> => no(),
  audits: (_p?: string) =>
    ok<{ audits: AuditListItem[] }>({
      audits: DEMO.audits.map((a) => ({
        id: a.audit_id, project_id: a.project_id, status: a.status, mode: a.mode, input_url: a.target.input_url, retry_of: a.retry_of, created_at: a.timings.created_at,
        summary: { client_name: a.client_name, host: a.target.host, run_quality: a.run_quality, technical_health: a.scores.technical_health.value, ai_accessibility: a.scores.ai_accessibility.value, pages: a.coverage.pages, counts: a.summary.counts, report: a.report.state, finished_at: a.timings.finished_at, retry_count: a.retry_count },
      })),
    }),
  start: (_b: Record<string, unknown>): Promise<{ audit_id: string; status: string }> => no(),
  audit: (id: string) => new Promise<Audit>((res, rej) => { try { res(find(id)); } catch (e) { rej(e); } }),
  progress: (_id: string): Promise<Progress> => no(),
  runSelected: (_id: string, _pages: string[]): Promise<{ audit_id: string }> => no(),
  cancel: (_id: string) => no(),
  retry: (_id: string): Promise<{ audit_id: string }> => no(),
  report: (id: string) => ok(find(id).report),
  regenerate: (_id: string, _b?: Record<string, unknown>): Promise<Audit['report']> => no(),
  assetUrl: (_id: string, name: string) => DEMO.assets[name] ?? '',
  pdfUrl: (_id: string, _inline = false) => '#/deploy',
  exportUrl: (_id: string) => '#/code',
  previewPages: ((id: string) => DEMO.report_pages[id] ?? []) as undefined | ((id: string) => string[]),
  rules: () => ok({ rules: DEMO.rules }),
};
