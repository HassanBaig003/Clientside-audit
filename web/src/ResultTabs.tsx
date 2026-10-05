import { useEffect, useMemo, useRef, useState } from 'react';
import type { Audit, CheckStatus, PageRecord, RootIssue } from '../../server/src/types';
import { api, ApiError } from './api';
import { Banner, CopyButton, fmtTime, SevPill, StatusPill, STATUS_LABEL } from './ui';

const CATEGORY: Record<string, string> = { crawl_indexing: 'Crawl and indexing', onpage_links: 'On-page and links', structured_international: 'Structured data / international', field_performance: 'Performance', ai_access: 'AI access', ux_accessibility: 'UX and accessibility', https_transport: 'HTTPS / transport', optional_signals: 'Optional signals' };
const profile = (r: { acquisition: string; validity: string | null; status: number | null }) => (r.acquisition === 'OK' ? `${(r.validity ?? '').toLowerCase().replace(/_/g, ' ')}${r.status ? ` (${r.status})` : ''}` : r.acquisition.toLowerCase().replace(/_/g, ' '));
const eligibility = (p: PageRecord) => (p.technical_eligibility === 'ELIGIBLE' ? 'Eligible (observable signals)' : p.technical_eligibility === 'NOT_ELIGIBLE' ? 'Not eligible' : p.technical_eligibility === 'UNCERTAIN' ? 'Uncertain' : '–');

// ---- Screen 4: page results ---------------------------------------------------------------------------------
export function PagesTab({ audit }: { audit: Audit }) {
  const [open, setOpen] = useState<PageRecord | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && ref.current && !ref.current.open) ref.current.showModal();
  }, [open]);
  const issuesFor = (id: string) => audit.root_issues.filter((i) => i.affected_page_ids.includes(id));
  const field = (id: string) => audit.performance.field.find((f) => f.page_id === id);
  return (
    <>
      <p className="muted small">Selected {audit.coverage.pages.selected} · fetched {audit.coverage.pages.fetched} · valid {audit.coverage.pages.valid} · blocked {audit.coverage.pages.blocked} · challenged {audit.coverage.pages.challenged} · error {audit.coverage.pages.error_pages} · unavailable {audit.coverage.pages.unavailable}. Findings describe these pages only.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>URL / type</th><th>Response validity</th><th>HTTP</th><th>Technical eligibility</th><th>RAW content</th><th className="num">Issues</th><th>Field data</th><th><span className="sr-only">Details</span></th></tr></thead>
          <tbody>
            {audit.pages.map((p) => {
              const raw = audit.checks.find((c) => c.check_id === 'A-5.1' && c.page_id === p.page_id);
              const f = field(p.page_id);
              return (
                <tr key={p.page_id}>
                  <td>{p.page_id}</td>
                  <td className="url"><a href={p.url} target="_blank" rel="noreferrer noopener">{p.url}</a><div className="muted small">{p.page_type.replace('_', ' ')} · {p.selection_reason}</div></td>
                  <td className="small">RAW {profile(p.raw)}<br />Rendered {profile(p.rendered)}</td>
                  <td>{p.raw.status ?? '–'}</td>
                  <td className="small">{eligibility(p)}</td>
                  <td>{raw ? <StatusPill status={raw.status} /> : '–'}</td>
                  <td className="num">{issuesFor(p.page_id).length}</td>
                  <td className="small">{f?.available ? f.assessment.toLowerCase().replace('_', ' ') : 'Unavailable'}</td>
                  <td><button className="sm" onClick={() => setOpen(p)}>Details</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && (
        <dialog ref={ref} aria-labelledby="pg-title" onClose={() => setOpen(null)}>
          <div className="dlg-head"><h2 id="pg-title" className="grow" style={{ margin: 0 }}>{open.page_id} · {new URL(open.url).pathname}</h2><button onClick={() => ref.current?.close()}>Close</button></div>
          <div className="dlg-body"><PageDetail audit={audit} p={open} issues={issuesFor(open.page_id)} /></div>
        </dialog>
      )}
    </>
  );
}

function PageDetail({ audit, p, issues }: { audit: Audit; p: PageRecord; issues: RootIssue[] }) {
  const row = (label: string, raw: React.ReactNode, ren: React.ReactNode) => <tr><th scope="row">{label}</th><td>{raw}</td><td>{ren}</td></tr>;
  const ex = (e: PageRecord['raw_extract'], f: (x: NonNullable<PageRecord['raw_extract']>) => React.ReactNode) => (e ? f(e) : <span className="muted">unavailable</span>);
  const links = (e: NonNullable<PageRecord['raw_extract']>) => `${e.links.filter((l) => l.crawlable && l.internal).length} internal · e.g. ${e.links.filter((l) => l.crawlable && l.internal).slice(0, 4).map((l) => l.text || new URL(l.url!).pathname).join(', ') || 'none'}`;
  const dirs = (e: NonNullable<PageRecord['raw_extract']>) => [...e.meta_robots.map((m) => `${m.name}: ${m.content}`), ...e.x_robots_tag.map((h) => `X-Robots-Tag: ${h}`)].join(' | ') || 'none';
  return (
    <div className="row top">
      <div className="grow">
        <p className="small muted">{p.url}<br />{p.selection_reason}{p.discovered_from ? ` · found on ${p.discovered_from}` : ''} · group {p.observed_group}</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Observation</th><th>RAW (server HTML)</th><th>RENDERED (browser)</th></tr></thead>
            <tbody>
              {row('Response', `${profile(p.raw)}${p.raw.hops.length ? ` after ${p.raw.hops.length} redirect(s)` : ''}`, profile(p.rendered))}
              {row('Title', ex(p.raw_extract, (e) => e.title ?? '(none)'), ex(p.rendered_extract, (e) => e.title ?? '(none)'))}
              {row('Meta description', ex(p.raw_extract, (e) => e.meta_description ?? '(none)'), ex(p.rendered_extract, (e) => e.meta_description ?? '(none)'))}
              {row('H1', ex(p.raw_extract, (e) => e.h1.join(' | ') || '(none)'), ex(p.rendered_extract, (e) => e.h1.join(' | ') || '(none)'))}
              {row('Canonical', ex(p.raw_extract, (e) => [...e.canonical_head, ...e.canonical_http].join(', ') || '(none)'), ex(p.rendered_extract, (e) => e.canonical_head.join(', ') || '(none)'))}
              {row('Directives', ex(p.raw_extract, dirs), ex(p.rendered_extract, dirs))}
              {row('Primary text', ex(p.raw_extract, (e) => `${e.word_count} words (${e.main_text_method}, ${e.main_text_confidence} confidence)`), ex(p.rendered_extract, (e) => `${e.word_count} words (${e.main_text_method}, ${e.main_text_confidence} confidence)`))}
              {row('Primary links', ex(p.raw_extract, links), ex(p.rendered_extract, links))}
              {row('Schema types', ex(p.raw_extract, (e) => [...new Set(e.structured.flatMap((s) => s.types))].join(', ') || '(none)'), ex(p.rendered_extract, (e) => [...new Set(e.structured.flatMap((s) => s.types))].join(', ') || '(none)'))}
              {row('robots.txt', `Auditor ${p.robots.auditor.decision}`, `Googlebot ${p.robots.googlebot.decision}${p.robots.googlebot.matched_rule ? ` · ${p.robots.googlebot.matched_rule}` : ''}`)}
            </tbody>
          </table>
        </div>
        <h3 style={{ marginTop: 14 }}>Findings on this page ({issues.length})</h3>
        {issues.length === 0 ? <p className="muted">None.</p> : <ul className="plain">{issues.map((i) => <li key={i.issue_id}>{i.issue_id} {i.title} <SevPill issue={i} /></li>)}</ul>}
        <p className="small"><a href={p.raw.body_ref ? api.assetUrl(audit.audit_id, p.raw.body_ref) : undefined}>{p.raw.body_ref ? 'Download RAW source (text)' : ''}</a></p>
      </div>
      <div>
        {p.screenshot_ref ? <img className="shot" src={api.assetUrl(audit.audit_id, p.screenshot_ref)} alt={`Mobile screenshot of ${p.url}`} /> : <div className="banner info" style={{ width: 206 }}>No screenshot: the page could not be rendered ({profile(p.rendered)}).</div>}
        <div className="muted small" style={{ width: 206, marginTop: 4 }}>412×915 viewport · {fmtTime(p.rendered.rendered_at)}</div>
      </div>
    </div>
  );
}

// ---- Screen 5: findings and evidence -----------------------------------------------------------------------------
export function FindingsTab({ audit }: { audit: Audit }) {
  const [cat, setCat] = useState('');
  const [sev, setSev] = useState('');
  const [page, setPage] = useState('');
  const [status, setStatus] = useState('');
  const [conf, setConf] = useState('');
  const evById = useMemo(() => new Map(audit.evidence.map((e) => [e.evidence_id, e])), [audit]);
  const srcById = useMemo(() => new Map(audit.sources.map((s) => [s.source_id, s])), [audit]);
  const list = audit.root_issues.filter((i) => (!cat || i.category === cat) && (!sev || (sev === 'OPP' ? i.classification !== 'ISSUE' : i.classification === 'ISSUE' && i.severity === sev)) && (!page || i.affected_page_ids.includes(page)) && (!status || i.finding_status === status) && (!conf || i.confidence === conf));
  const sel = (id: string, label: string, value: string, set: (v: string) => void, opts: [string, string][]) => (
    <div><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={(e) => set(e.target.value)}><option value="">All</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
  );
  return (
    <>
      <div className="filters">
        {sel('f-cat', 'Category', cat, setCat, [...new Set(audit.root_issues.map((i) => i.category))].map((c) => [c, CATEGORY[c] ?? c]))}
        {sel('f-sev', 'Severity', sev, setSev, [['CRITICAL', 'Critical'], ['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low'], ['OPP', 'Opportunity / advisory']])}
        {sel('f-page', 'Page', page, setPage, audit.pages.map((p) => [p.page_id, `${p.page_id} ${new URL(p.url).pathname}`]))}
        {sel('f-status', 'Status', status, setStatus, [['FAIL', 'Fail'], ['WARN', 'Warn']])}
        {sel('f-conf', 'Confidence', conf, setConf, [['OBSERVED', 'Observed'], ['DERIVED', 'Derived'], ['THIRD_PARTY', 'Third-party'], ['MODELLED', 'Modelled']])}
      </div>
      <p className="muted small" aria-live="polite">{list.length} of {audit.root_issues.length} root finding(s). Repeated issues are grouped by root cause with every affected sample URL.</p>
      {list.length === 0 && <div className="card muted">{audit.root_issues.length === 0 ? 'No finding was recorded for the evaluated sample.' : 'No finding matches these filters.'}</div>}
      {list.map((i) => (
        <article key={i.issue_id} className="finding">
          <h3><span className="muted">{i.issue_id}</span> {i.title} <SevPill issue={i} /> <StatusPill status={i.finding_status} />{!i.score_included && <span className="pill sev-LOW">unscored</span>}</h3>
          <p>{i.explanation}</p>
          <div className="kv"><b>Practical implication:</b> {i.practical_impact}</div>
          <div className="kv"><b>Fix:</b> {i.recommended_action}</div>
          <div className="kv"><b>Owner:</b> {i.suggested_owner} · <b>Effort:</b> {i.effort} · <b>Priority:</b> {i.priority} · <b>Check:</b> {i.check_id} · <b>Confidence:</b> {i.confidence.toLowerCase().replace('_', '-')}</div>
          {i.caveat && <div className="kv muted small">{i.caveat}</div>}
          <div className="kv"><b>Affected sample URLs ({i.affected_urls.length || 'site-level'}):</b></div>
          {i.affected_urls.length > 0 && <ul className="plain small">{i.affected_urls.map((u) => <li key={u}>{u}</li>)}</ul>}
          <details>
            <summary>Observed evidence ({i.evidence_ids.length})</summary>
            {i.evidence_ids.slice(0, 6).map((id) => {
              const e = evById.get(id);
              return e ? <div key={id} className="evi small"><b>{e.evidence_id}</b> · {e.profile} · {e.locator} · {fmtTime(e.captured_at)}{'\n'}{e.observed}{e.expected ? `\nExpected: ${e.expected}` : ''}</div> : null;
            })}
            {i.evidence_ids.length > 6 && <p className="muted small">{i.evidence_ids.length - 6} more in the Evidence tab.</p>}
          </details>
          {i.code && (
            <details>
              <summary>{i.code.label}</summary>
              {i.code.is_template && <Banner kind="info">Template: requires verified values. It is not ready to publish until every placeholder is replaced with a value that is visible on the page.</Banner>}
              <pre className="code">{i.code.content}</pre>
              <CopyButton text={i.code.content} label={i.code.is_template ? 'Copy template (requires verified values)' : 'Copy verified code'} />
            </details>
          )}
          <div className="kv small muted">Reference: {i.source_ids.map((s) => srcById.get(s)).filter(Boolean).map((s, n) => <span key={s!.source_id}>{n ? '; ' : ''}{s!.url.startsWith('http') ? <a href={s!.url} target="_blank" rel="noreferrer noopener">{s!.title}</a> : s!.title} [{s!.label.toLowerCase().replace('_', ' ')}]</span>)}</div>
        </article>
      ))}
    </>
  );
}

export function EvidenceTab({ audit }: { audit: Audit }) {
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const rules = useRules();
  const name = (id: string) => rules.get(id) ?? id;
  const checks = audit.checks.filter((c) => (!st || c.status === st) && (!q || `${c.check_id} ${name(c.check_id)} ${c.page_id ?? ''} ${c.notes.join(' ')} ${c.limitations.join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const evById = useMemo(() => new Map(audit.evidence.map((e) => [e.evidence_id, e])), [audit]);
  const tally = (s: CheckStatus) => audit.checks.filter((c) => c.status === s).length;
  return (
    <>
      <p className="muted small">Full rule and evidence detail for technical users. {audit.checks.length} check units: {(['PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'NOT_TESTABLE', 'ERROR'] as CheckStatus[]).map((s) => `${tally(s)} ${STATUS_LABEL[s].toLowerCase()}`).join(' · ')}. Rule registry {audit.rule_registry_version}; sources reviewed {audit.source_registry_reviewed}. <a href={api.exportUrl(audit.audit_id)}>Download audit JSON</a></p>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow"><label htmlFor="e-q">Search checks</label><input id="e-q" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="check ID, page ID or text" /></div>
        <div><label htmlFor="e-st">Status</label><select id="e-st" value={st} onChange={(e) => setSt(e.target.value)}><option value="">All</option>{Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Check</th><th>Page</th><th>Status</th><th>Scored</th><th>Evidence and notes</th></tr></thead>
          <tbody>
            {checks.slice(0, 400).map((c, n) => (
              <tr key={`${c.check_id}-${c.page_id}-${n}`}>
                <td><b>{c.check_id}</b><div className="small muted">{name(c.check_id)}</div></td>
                <td>{c.page_id ?? 'site'}</td>
                <td><StatusPill status={c.status} /></td>
                <td>{c.score_included ? 'Yes' : 'No'}</td>
                <td className="small">
                  {[...c.limitations, ...c.notes].slice(0, 3).map((t, k) => <div key={k}>{t}</div>)}
                  {c.evidence_ids.length > 0 && (
                    <details><summary>{c.evidence_ids.length} evidence item(s)</summary>{c.evidence_ids.slice(0, 5).map((id) => { const e = evById.get(id); return e ? <div key={id} className="evi"><b>{id}</b> · {e.profile} · {e.locator}{'\n'}{e.observed}</div> : null; })}</details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {checks.length > 400 && <p className="muted small">Showing the first 400 rows; narrow the search to see the rest.</p>}
    </>
  );
}

function useRules(): Map<string, string> {
  const [m, setM] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    api.rules().then((j) => setM(new Map(j.rules.map((r) => [r.check_id, r.name]))), () => undefined);
  }, []);
  return m;
}

// ---- Screen 6: PDF preview and export state --------------------------------------------------------------------------
export function ReportTab({ audit, reload }: { audit: Audit; reload: () => void }) {
  const [state, setState] = useState(audit.report);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(audit.config.branding.client_display_name ?? '');
  const [by, setBy] = useState(audit.config.branding.prepared_by ?? '');
  const [stamp, setStamp] = useState(Date.now());
  const finished = audit.status === 'COMPLETED' || audit.status === 'PARTIAL';
  useEffect(() => {
    if (state.state !== 'GENERATING') return;
    const t = setInterval(async () => {
      const r = await api.report(audit.audit_id).catch(() => null);
      if (r && r.state !== 'GENERATING') {
        setState(r);
        setStamp(Date.now());
        reload();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [state.state, audit.audit_id]);
  const regenerate = async () => {
    setError(null);
    try {
      setState(await api.regenerate(audit.audit_id, { client_display_name: name.trim() || null, prepared_by: by.trim() || null }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The report could not be generated.');
    }
  };
  if (!finished) return <Banner kind="info">A report is available only for a finished audit. This audit is {audit.status.toLowerCase()}.</Banner>;
  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="card">
        <div className="grid cols-2">
          <div className="field"><label htmlFor="r-name">Client display name (approved branding)</label><input id="r-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
          <div className="field"><label htmlFor="r-by">Prepared by</label><input id="r-by" type="text" value={by} onChange={(e) => setBy(e.target.value)} maxLength={120} /></div>
        </div>
        <div className="row">
          <button onClick={regenerate} disabled={state.state === 'GENERATING'}>{state.state === 'GENERATING' ? 'Generating…' : 'Regenerate PDF'}</button>
          {state.state === 'READY' && <a className="btn primary" href={api.pdfUrl(audit.audit_id)}>Download PDF</a>}
          <span className="muted small" aria-live="polite">
            {state.state === 'READY' ? `Ready · generated ${fmtTime(state.generated_at)} · ${Math.round((state.bytes ?? 0) / 1024)} KB` : state.state === 'GENERATING' ? 'Generating from the stored audit…' : state.state === 'FAILED' ? `Export failed: ${state.error}` : 'No report has been generated yet.'}
          </span>
        </div>
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>Regeneration uses the stored audit. It does not re-fetch the website and cannot change scores or findings; only the branding fields above are applied.</p>
      </div>
      {state.state === 'READY' && api.previewPages ? (
        <div className="card" style={{ background: '#e5e7eb' }}>
          <p className="small">Read-only preview: the pages below are images of the PDF generated from this stored audit.</p>
          {api.previewPages(audit.audit_id).map((src, n) => <img key={n} src={src} alt={`Report page ${n + 1}`} style={{ display: 'block', width: '100%', maxWidth: 760, margin: '0 auto 12px', border: '1px solid #d1d5db', background: '#fff' }} />)}
        </div>
      ) : state.state === 'READY' ? <iframe className="pdf-frame" title="PDF report preview" src={`${api.pdfUrl(audit.audit_id, true)}&t=${stamp}`} /> : state.state === 'FAILED' ? <Banner kind="error">The PDF could not be produced. The audit results above are unaffected. Try Regenerate PDF.</Banner> : state.state === 'GENERATING' ? <div className="card row" role="status"><span className="spin" aria-hidden="true" /> Building the report…</div> : null}
    </>
  );
}
