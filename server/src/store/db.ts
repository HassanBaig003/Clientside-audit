import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Audit, AuditStatus } from '../types';
import type { BlobStore } from '../net/context';

export interface ProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  website: string | null;
  created_at: string;
}
export interface AuditRow {
  id: string;
  tenant_id: string;
  project_id: string;
  status: AuditStatus;
  mode: string;
  input_url: string;
  retry_of: string | null;
  created_at: string;
  updated_at: string;
  summary_json: string | null;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

class FileBlobStore implements BlobStore {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private safe(name: string) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  }
  put(name: string, data: Buffer | string): string {
    const n = this.safe(name);
    fs.writeFileSync(path.join(this.dir, n), data);
    return n;
  }
  get(ref: string): Buffer | null {
    const f = path.join(this.dir, this.safe(ref));
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }
}

/**
 * Persistence boundary. Every read takes a tenant id and filters on it, so results, evidence, screenshots,
 * history and downloads are tenant-scoped at the storage layer, not only in the routes.
 */
export class Store {
  readonly db: Database.Database;
  constructor(readonly dataDir: string) {
    fs.mkdirSync(path.join(dataDir, 'audits'), { recursive: true });
    this.db = new Database(path.join(dataDir, 'audit.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, website TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS projects_tenant ON projects(tenant_id);
      CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL,
        input_url TEXT NOT NULL, retry_of TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, summary_json TEXT);
      CREATE INDEX IF NOT EXISTS audits_tenant_project ON audits(tenant_id, project_id, created_at);
    `);
  }

  close() {
    this.db.close();
  }

  createProject(tenant: string, name: string, website: string | null): ProjectRow {
    const row: ProjectRow = { id: newId('prj'), tenant_id: tenant, name, website, created_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO projects VALUES (@id,@tenant_id,@name,@website,@created_at)').run(row);
    return row;
  }
  listProjects(tenant: string): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects WHERE tenant_id = ? ORDER BY created_at DESC').all(tenant) as ProjectRow[];
  }
  getProject(tenant: string, id: string): ProjectRow | null {
    return (this.db.prepare('SELECT * FROM projects WHERE tenant_id = ? AND id = ?').get(tenant, id) as ProjectRow) ?? null;
  }

  private dir(auditId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(auditId)) throw new Error('invalid audit id');
    return path.join(this.dataDir, 'audits', auditId);
  }
  blobs(auditId: string): BlobStore {
    return new FileBlobStore(path.join(this.dir(auditId), 'assets'));
  }

  saveAudit(audit: Audit) {
    const dir = this.dir(audit.audit_id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'audit.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(audit));
    fs.renameSync(tmp, path.join(dir, 'audit.json'));
    const summary = {
      client_name: audit.client_name, host: audit.target.host, run_quality: audit.run_quality,
      technical_health: audit.scores.technical_health.value, ai_accessibility: audit.scores.ai_accessibility.value,
      pages: audit.coverage.pages, counts: audit.summary.counts, report: audit.report.state, finished_at: audit.timings.finished_at, retry_count: audit.retry_count,
    };
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO audits (id,tenant_id,project_id,status,mode,input_url,retry_of,created_at,updated_at,summary_json) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, mode=excluded.mode, updated_at=excluded.updated_at, summary_json=excluded.summary_json`)
      .run(audit.audit_id, audit.tenant_id, audit.project_id, audit.status, audit.mode, audit.target.input_url, audit.retry_of, audit.timings.created_at, now, JSON.stringify(summary));
  }

  getAuditRow(tenant: string, id: string): AuditRow | null {
    return (this.db.prepare('SELECT * FROM audits WHERE tenant_id = ? AND id = ?').get(tenant, id) as AuditRow) ?? null;
  }
  listAudits(tenant: string, projectId?: string): AuditRow[] {
    return projectId
      ? (this.db.prepare('SELECT * FROM audits WHERE tenant_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 200').all(tenant, projectId) as AuditRow[])
      : (this.db.prepare('SELECT * FROM audits WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200').all(tenant) as AuditRow[]);
  }
  loadAudit(tenant: string, id: string): Audit | null {
    if (!this.getAuditRow(tenant, id)) return null;
    const f = path.join(this.dir(id), 'audit.json');
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Audit) : null;
  }
  /** Internal load for the worker that already owns the audit. */
  loadAuditInternal(id: string): Audit | null {
    const f = path.join(this.dir(id), 'audit.json');
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Audit) : null;
  }

  assetPath(tenant: string, auditId: string, name: string): string | null {
    if (!this.getAuditRow(tenant, auditId)) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) return null;
    const f = path.join(this.dir(auditId), 'assets', name);
    return fs.existsSync(f) ? f : null;
  }
  reportPath(auditId: string) {
    return path.join(this.dir(auditId), 'report.pdf');
  }

  /**
   * After a worker crash or restart, audits left in an active state are marked INTERRUPTED with their
   * partial evidence preserved. A stopped job is never labelled complete.
   */
  recoverInterrupted(): string[] {
    const rows = this.db.prepare("SELECT id FROM audits WHERE status IN ('QUEUED','DISCOVERING','RUNNING')").all() as { id: string }[];
    for (const r of rows) {
      const a = this.loadAuditInternal(r.id);
      if (a) {
        a.status = 'INTERRUPTED';
        a.run_quality = a.pages.some((p) => p.state === 'VALID') ? 'PARTIAL' : 'INSUFFICIENT';
        a.stop_reason = 'The worker stopped before this audit finished. Partial evidence was kept.';
        for (const s of a.stages) if (s.state === 'RUNNING') (s.state = 'FAILED'), (s.detail = 'Interrupted by a worker restart');
        if (a.report.state === 'GENERATING') (a.report.state = 'FAILED'), (a.report.error = 'Interrupted by a worker restart');
        this.saveAudit(a);
      } else this.db.prepare("UPDATE audits SET status='INTERRUPTED' WHERE id = ?").run(r.id);
    }
    return rows.map((r) => r.id);
  }
}
