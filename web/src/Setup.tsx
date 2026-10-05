import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, ACTIVE, type AppConfig, type AuditListItem, type Project } from './api';
import { Banner, dash, fmtTime } from './ui';
import type { Audit } from '../../server/src/types';

function validateUrl(v: string): string | null {
  const t = v.trim();
  if (!t) return 'Enter a website URL.';
  if (/\s/.test(t)) return 'A URL cannot contain spaces.';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/:]+:\d+/.test(t) ? t : `https://${t}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http:// and https:// websites can be audited.';
    if (!u.hostname.includes('.')) return 'Enter a public hostname, for example example.com.';
  } catch {
    return 'That is not a valid URL.';
  }
  return null;
}

/** Screen 1: audit setup, optional page-selection review, and the client's audit history. */
export function Setup({ go, config, review, onStarted }: { go: (p: string) => void; config?: AppConfig | null; review?: Audit; onStarted?: () => void }) {
  if (review) return <Review audit={review} go={go} onStarted={onStarted!} />;
  return <SetupForm go={go} config={config ?? null} />;
}

function SetupForm({ go, config }: { go: (p: string) => void; config: AppConfig | null }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [newName, setNewName] = useState('');
  const [url, setUrl] = useState('');
  const [touched, setTouched] = useState(false);
  const [size, setSize] = useState(10);
  const [pages, setPages] = useState('');
  const [reviewFirst, setReviewFirst] = useState(false);
  const [goal, setGoal] = useState('search_ai_discovery');
  const [env, setEnv] = useState('production');
  const [multi, setMulti] = useState(false);
  const [display, setDisplay] = useState('');
  const [prepared, setPrepared] = useState('');
  const [restricted, setRestricted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<AuditListItem[] | null>(null);

  useEffect(() => {
    api.projects().then((r) => {
      setProjects(r.projects);
      if (r.projects[0]) setProjectId(r.projects[0].id);
      else setProjectId('__new');
    }, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!projectId || projectId === '__new') return setHistory([]);
    let alive = true;
    const load = () => api.audits(projectId).then((r) => alive && setHistory(r.audits), () => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId]);

  const urlError = validateUrl(url);
  const pageList = useMemo(() => pages.split(/\n/).map((s) => s.trim()).filter(Boolean), [pages]);
  const pagesError = pageList.length > 10 ? 'At most 10 page URLs can be supplied.' : pageList.map(validateUrl).find(Boolean) ? 'One of the page URLs is not a valid http(s) URL.' : null;
  const max = config?.max_pages ?? 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (urlError || pagesError) return;
    setBusy(true);
    setError(null);
    try {
      let pid = projectId;
      if (pid === '__new') {
        if (!newName.trim()) throw new ApiError(400, 'Enter a client or project name.');
        const p = await api.createProject(newName.trim(), url.trim());
        pid = p.id;
      }
      const r = await api.start({
        project_id: pid, url: url.trim(), sample_size: size, pages: pageList.length ? pageList : undefined, auto_run: !reviewFirst,
        visibility_goal: goal, environment: env, multilingual: multi,
        intentional_restrictions: restricted.split(/\n/).map((s) => s.trim()).filter(Boolean),
        branding: { client_display_name: display.trim() || undefined, prepared_by: prepared.trim() || undefined },
      });
      go(`audit/${r.audit_id}`);
    } catch (err) {
      setError(err instanceof ApiError ? [err.message, ...(err.details ?? [])].join(' ') : 'The audit could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>New initial audit</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Checks up to {max} representative public pages for technical SEO issues and for how accessible the content is to search and AI retrieval systems. It is not a full-site audit and does not measure AI citations, rankings or revenue.
      </p>
      {error && <Banner kind="error">{error}</Banner>}
      <form className="card" onSubmit={submit} noValidate>
        <div className="grid cols-2">
          <div className="field">
            <label htmlFor="project">Client / project</label>
            <select id="project" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!projects}>
              {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="__new">New client / project…</option>
            </select>
            {projectId === '__new' && (
              <div style={{ marginTop: 8 }}>
                <label htmlFor="newname">Client or project name</label>
                <input id="newname" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="url">Website URL</label>
            <input id="url" type="text" inputMode="url" placeholder="example.com or https://example.com/section/page" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && !!urlError} aria-describedby="url-hint" />
            {touched && urlError ? <div className="error-text" id="url-hint">{urlError}</div> : <div className="hint" id="url-hint">A deep URL is audited together with the homepage.</div>}
          </div>
        </div>
        <div className="grid cols-2">
          <div className="field">
            <label htmlFor="size">Sample size (1 to {max} pages)</label>
            <input id="size" type="number" min={1} max={max} value={size} onChange={(e) => setSize(Math.max(1, Math.min(max, Number(e.target.value) || 1)))} />
            <div className="hint">Pages are chosen from links observed on the homepage and section hubs. Sitemap contents are not used.</div>
          </div>
          <div className="field">
            <label htmlFor="pages">Specific pages to include (optional, one URL per line)</label>
            <textarea id="pages" value={pages} onChange={(e) => setPages(e.target.value)} aria-invalid={!!pagesError} placeholder="https://example.com/pricing" />
            {pagesError && <div className="error-text">{pagesError}</div>}
          </div>
        </div>
        <label className="check field">
          <input type="checkbox" checked={reviewFirst} onChange={(e) => setReviewFirst(e.target.checked)} />
          <span>Review the proposed pages before the audit runs <span className="muted">(off = one-click run with the default sample)</span></span>
        </label>
        <details className="field">
          <summary>Advanced options</summary>
          <div className="grid cols-2" style={{ marginTop: 12 }}>
            <div className="field">
              <label htmlFor="goal">Visibility goal</label>
              <select id="goal" value={goal} onChange={(e) => setGoal(e.target.value)}>
                <option value="search_ai_discovery">Public site: search and AI discovery</option>
                <option value="restricted">Intentionally restricted site</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="env">Environment</label>
              <select id="env" value={env} onChange={(e) => setEnv(e.target.value)}>
                <option value="production">Production</option>
                <option value="staging">Staging (restrictions are expected)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="display">Client display name for the report</label>
              <input id="display" type="text" value={display} onChange={(e) => setDisplay(e.target.value)} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="prepared">Prepared by</label>
              <input id="prepared" type="text" value={prepared} onChange={(e) => setPrepared(e.target.value)} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="restricted">Intentionally restricted paths (one per line)</label>
              <textarea id="restricted" value={restricted} onChange={(e) => setRestricted(e.target.value)} placeholder="/members/" />
              <div className="hint">noindex or robots blocks on these paths are recorded as policy choices, not defects.</div>
            </div>
            <div className="field">
              <label className="check"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> <span>The site is multilingual or multi-regional</span></label>
              <div className="hint">Report language: English. Assessment: mobile. Training-crawler policy stays the client's choice and never affects a score.</div>
            </div>
          </div>
        </details>
        <div className="row">
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Starting…' : reviewFirst ? 'Discover pages' : 'Run audit'}</button>
          <span className="muted small">
            Field data: {config?.field_data_configured ? 'configured' : 'not configured (reported as unavailable)'} · Semantic content review: {config?.semantic_review_configured ? 'configured' : 'not configured (deterministic observations only)'}
          </span>
        </div>
      </form>

      <h2>Audit history</h2>
      {history === null ? <p className="muted">Loading…</p> : history.length === 0 ? (
        <div className="card muted">No audits yet for this client.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Started</th><th>Website</th><th>Status</th><th className="num">Technical health</th><th className="num">AI accessibility</th><th className="num">Valid / selected</th><th>Report</th><th><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td>{fmtTime(a.created_at)}</td>
                  <td className="url">{a.summary?.host ?? a.input_url}{a.mode === 'FIXTURE_DEMO' && <span className="pill sev-MEDIUM" style={{ marginLeft: 6 }}>Demo</span>}{a.retry_of && <span className="muted small"> · retry {a.summary?.retry_count}</span>}</td>
                  <td>{ACTIVE.includes(a.status) ? <span className="row" style={{ gap: 6 }}><span className="spin" aria-hidden="true" />{a.status.toLowerCase()}</span> : a.status.toLowerCase().replace('_', ' ')}{a.summary && a.summary.run_quality !== 'COMPLETE' && a.summary.run_quality !== 'PENDING' ? <span className="muted small"> · {a.summary.run_quality.toLowerCase()}</span> : null}</td>
                  <td className="num">{dash(a.summary?.technical_health)}</td>
                  <td className="num">{dash(a.summary?.ai_accessibility)}</td>
                  <td className="num">{a.summary ? `${a.summary.pages.valid} / ${a.summary.pages.selected}` : '–'}</td>
                  <td>{a.summary?.report === 'READY' ? <a href={api.pdfUrl(a.id)}>Download PDF</a> : <span className="muted">{(a.summary?.report ?? 'none').toLowerCase()}</span>}</td>
                  <td><a href={`#/audit/${a.id}`}>Open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Optional page-selection review. It appears only when the operator asked for it. */
function Review({ audit, go, onStarted }: { audit: Audit; go: (p: string) => void; onStarted: () => void }) {
  const max = audit.config.budgets.max_selected_pages;
  const proposed = audit.pages.map((p) => p.url);
  const [chosen, setChosen] = useState<string[]>(proposed);
  const [extra, setExtra] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: { url: string; type: string; source: string; reason: string; note: string | null }[] = [];
    for (const p of audit.pages) {
      seen.add(p.url);
      out.push({ url: p.url, type: p.page_type, source: p.discovered_from ? `Linked from ${new URL(p.discovered_from).pathname}` : p.operator_override ?? 'Observed origin', reason: p.selection_reason, note: null });
    }
    for (const c of audit.discovery.candidates) {
      if (seen.has(c.url) || c.verification === 'alias') continue;
      out.push({ url: c.url, type: c.page_type, source: `${c.zone} link on ${c.discovered_from.startsWith('http') ? new URL(c.discovered_from).pathname : c.discovered_from}`, reason: c.excluded_reason ?? c.verification_note ?? 'Not selected: another page represents this group', note: c.robots_auditor !== 'ALLOW' ? 'robots.txt does not allow the auditor' : c.verification === 'failed' ? 'not a verified page' : c.excluded_reason ? 'excluded' : null });
    }
    return out;
  }, [audit]);
  const toggle = (u: string) => setChosen((c) => (c.includes(u) ? c.filter((x) => x !== u) : c.length < max ? [...c, u] : c));
  const add = () => {
    const err = validateUrl(extra);
    if (err) return setError(err);
    if (chosen.length >= max) return setError(`The sample is limited to ${max} pages.`);
    const u = new URL(/^https?:/i.test(extra.trim()) ? extra.trim() : `https://${extra.trim()}`).toString();
    setChosen((c) => (c.includes(u) ? c : [...c, u]));
    setExtra('');
    setError(null);
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.runSelected(audit.audit_id, chosen);
      onStarted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The audit could not be started.');
      setBusy(false);
    }
  };
  const added = chosen.filter((u) => !rows.some((r) => r.url === u));
  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Proposed pages for {audit.target.host}</h1>
      <p className="muted" style={{ marginBottom: 16 }}>{audit.target.origin_note} {chosen.length} of {max} pages selected.</p>
      {audit.mode === 'FIXTURE_DEMO' && <Banner kind="demo">Fixture / demo target.</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead><tr><th>Include</th><th>URL</th><th>Page type</th><th>Source</th><th>Selection reason</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.url}>
                <td><input type="checkbox" aria-label={`Include ${r.url}`} checked={chosen.includes(r.url)} disabled={!!r.note || (!chosen.includes(r.url) && chosen.length >= max)} onChange={() => toggle(r.url)} /></td>
                <td className="url">{r.url}</td>
                <td>{r.type.replace('_', ' ')}</td>
                <td>{r.source}</td>
                <td>{r.reason}{r.note && <span className="muted"> ({r.note})</span>}</td>
              </tr>
            ))}
            {added.map((u) => (
              <tr key={u}><td><input type="checkbox" aria-label={`Include ${u}`} checked onChange={() => toggle(u)} /></td><td className="url">{u}</td><td>–</td><td>Added by operator</td><td>Public URL added by the operator</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="row">
          <div className="grow"><label htmlFor="extra">Add a public URL</label><input id="extra" type="text" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="https://…" /></div>
          <button type="button" onClick={add} style={{ alignSelf: 'flex-end' }}>Add</button>
        </div>
        <details style={{ marginTop: 12 }}>
          <summary>Discovery limitations ({audit.discovery.limitations.length})</summary>
          <ul className="plain small" style={{ marginTop: 8 }}>{audit.discovery.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </details>
      </div>
      <div className="row">
        <button className="primary" disabled={busy || chosen.length === 0} onClick={run}>{busy ? 'Starting…' : `Run audit with ${chosen.length} page${chosen.length === 1 ? '' : 's'}`}</button>
        <button onClick={async () => { await api.cancel(audit.audit_id); go(''); }}>Discard</button>
      </div>
    </>
  );
}
