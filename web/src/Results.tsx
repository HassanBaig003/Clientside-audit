import { useState } from 'react';
import type { Audit, RootIssue, ScoreBlock } from '../../server/src/types';
import { api, ApiError } from './api';
import { Banner, dash, fmtElapsed, fmtTime, SevPill } from './ui';
import { EvidenceTab, FindingsTab, PagesTab, ReportTab } from './ResultTabs';

const TABS: [string, string][] = [['overview', 'Overview'], ['pages', 'Pages'], ['findings', 'Findings'], ['evidence', 'Evidence'], ['report', 'Report']];

function ScoreCard({ s }: { s: ScoreBlock }) {
  return (
    <div className="card stat">
      <div className="label">{s.label}</div>
      <div className="value">{dash(s.value)}{s.value !== null && <small> / 100</small>}</div>
      <div className="meta">{s.suppressed_reason ?? `Coverage ${dash(s.coverage.pct)}% · ${s.coverage.evaluated_units} of ${s.coverage.applicable_units} applicable check units`}</div>
      <div className="muted small">Wellows tool policy; not a Google score or benchmark.</div>
    </div>
  );
}

function CategoryBars({ s }: { s: ScoreBlock }) {
  return (
    <div className="table-wrap" style={{ marginBottom: 12 }}>
      <table>
        <caption className="sr-only">{s.label} by category</caption>
        <thead><tr><th>{s.label}</th><th className="num">Weight</th><th style={{ width: '30%' }}>Score</th><th className="num">Value</th><th className="num">Units evaluated</th></tr></thead>
        <tbody>
          {s.categories.map((c) => (
            <tr key={c.id}>
              <td>{c.label}</td><td className="num">{c.weight}</td>
              <td><div className="bar-track" aria-hidden="true">{c.score !== null && <div className="bar-fill" style={{ width: `${c.score}%` }} />}</div></td>
              <td className="num">{c.score === null ? '–' : Math.round(c.score)}</td><td className="num">{c.evaluated_units} / {c.applicable_units}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ audit, go }: { audit: Audit; go: (p: string) => void }) {
  const byId = new Map(audit.root_issues.map((i) => [i.issue_id, i]));
  const top = audit.summary.top_issue_ids.map((id) => byId.get(id)).filter((i): i is RootIssue => !!i);
  const c = audit.summary.counts;
  return (
    <>
      <div className="grid cols-4">
        <ScoreCard s={audit.scores.technical_health} />
        <ScoreCard s={audit.scores.ai_accessibility} />
        <div className="card stat">
          <div className="label">Verified critical / high issues</div>
          <div className="value">{c.critical + c.high}</div>
          <div className="meta">{c.critical} critical · {c.high} high · {c.medium} medium · {c.low} low</div>
          <div className="muted small">Root causes, each counted once. {c.opportunities} opportunities/advisories.</div>
        </div>
        <div className="card stat">
          <div className="label">Evaluated coverage</div>
          <div className="value">{audit.coverage.pages.valid}<small> / {audit.coverage.pages.selected} pages valid</small></div>
          <div className="meta">{audit.coverage.pages.blocked} blocked · {audit.coverage.pages.challenged} challenged · {audit.coverage.pages.error_pages} error · {audit.coverage.pages.unavailable} unavailable</div>
          <div className="muted small">{audit.coverage.omitted_checks.length} check unit(s) unavailable and excluded from scores.</div>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>These scores describe technical readiness in this sample only. They do not measure whether AI services cite the site, and they are not a content-quality score.</p>
      <div className="grid cols-2">
        <section className="card">
          <h2>Top findings</h2>
          {top.length === 0 ? <Banner kind="ok">No verified issue was found in the evaluated sample.</Banner> : top.map((i) => (
            <div key={i.issue_id} className="finding">
              <h3><span className="muted">{i.issue_id}</span> {i.title} <SevPill issue={i} /></h3>
              <p className="small">{i.practical_impact}</p>
              <div className="small muted">{i.affected_urls.length ? `${i.affected_urls.length} sampled page(s)` : 'Site-level'} · {i.suggested_owner} · effort {i.effort}</div>
            </div>
          ))}
          <button className="link" onClick={() => go(`audit/${audit.audit_id}/findings`)}>View all {audit.root_issues.length} findings</button>
        </section>
        <section className="card">
          <h2>Observed strengths</h2>
          {audit.summary.strengths.length ? <ul className="plain">{audit.summary.strengths.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted">No strength could be confirmed from the evidence available in this run.</p>}
          <h2 style={{ marginTop: 16 }}>Proposed action plan</h2>
          {audit.summary.action_plan.length === 0 ? <p className="muted">No phased work is needed for the evaluated sample.</p> : audit.summary.action_plan.map((ph) => (
            <div key={ph.phase} className="kv"><b>{ph.phase}</b> <span className="muted">{ph.label}</span>
              <ul className="plain small">{ph.issue_ids.map((id) => <li key={id}>{id} {byId.get(id)?.title}</li>)}</ul>
            </div>
          ))}
          <p className="muted small">Timing is an estimate, not a commitment or a promised result.</p>
        </section>
      </div>
      <section className="card">
        <h2>Category assessment</h2>
        <CategoryBars s={audit.scores.technical_health} />
        <CategoryBars s={audit.scores.ai_accessibility} />
        <p className="muted small">A dash means nothing in that category could be evaluated; it is excluded, not scored as zero. {audit.scores.technical_health.method}</p>
      </section>
      <section className="card">
        <h2>Optional signals <span className="pill sev-LOW">unscored</span></h2>
        {audit.optional_signals.map((o) => <p key={o.id}><b>{o.label}:</b> {o.state.toLowerCase().replace(/_/g, ' ')}. {o.note}</p>)}
        <h2 style={{ marginTop: 14 }}>Content review <span className="pill sev-OPP">content-review advisory · unscored</span></h2>
        <p className="muted small">{audit.content_review.note}</p>
        {audit.content_review.summary && <p>{audit.content_review.summary}</p>}
        {audit.content_review.observations.map((o) => (
          <div key={o.observation_id} className="finding">
            <h3><span className="muted">{o.observation_id}</span> {o.area.replace(/_/g, ' ')} <span className="pill sev-OPP">{o.origin === 'LLM' ? 'modelled' : 'deterministic'}</span></h3>
            <div className="small muted">{o.url}</div>
            <div className="evi small">“{o.excerpt}”</div>
            <div className="kv"><b>Observation:</b> {o.observation}</div>
            <div className="kv"><b>Suggestion:</b> {o.suggestion}</div>
          </div>
        ))}
      </section>
      <details className="card">
        <summary>Scope and limitations ({audit.limitations.length})</summary>
        <ul className="plain small" style={{ marginTop: 10 }}>{audit.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </>
  );
}

/** Screens 3 to 6: results overview, pages, findings, evidence, report. All read the stored audit object. */
export function Results({ audit, tab, go, reload }: { audit: Audit; tab: string; go: (p: string) => void; reload: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const finished = audit.status === 'COMPLETED' || audit.status === 'PARTIAL';
  const retry = async () => {
    try {
      const r = await api.retry(audit.audit_id);
      go(`audit/${r.audit_id}`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Retry failed.');
    }
  };
  const unavailable = audit.coverage.omitted_checks.length;
  return (
    <>
      <div className="row top" style={{ marginBottom: 14 }}>
        <div className="grow">
          <h1>{audit.config.branding.client_display_name ?? audit.client_name}</h1>
          <div className="muted">{audit.target.host} · audited {fmtTime(audit.timings.finished_at ?? audit.timings.started_at)} · {audit.coverage.pages.valid} valid of {audit.coverage.pages.selected} sampled page(s) · run quality {audit.run_quality.toLowerCase()}{audit.timings.elapsed_ms ? ` · ${fmtElapsed(audit.timings.elapsed_ms)}` : ''}</div>
        </div>
        {unavailable > 0 && finished && <button onClick={retry} title="Re-runs only what was unavailable; valid evidence is reused">Retry unavailable checks</button>}
        <button onClick={() => go('')}>New audit</button>
        {audit.report.state === 'READY' ? <a className="btn primary" href={api.pdfUrl(audit.audit_id)}>Download PDF</a> : <button className="primary" disabled={!finished} onClick={() => go(`audit/${audit.audit_id}/report`)}>PDF report</button>}
      </div>
      {audit.mode === 'FIXTURE_DEMO' && <Banner kind="demo">Fixture / demo data. This audit ran against a controlled test site and is not a client audit.</Banner>}
      {msg && <Banner kind="error">{msg}</Banner>}
      {audit.status === 'CANCELLED' && <Banner kind="info">This audit was cancelled. Evidence collected before cancellation is kept; it is not a completed audit and has no report.</Banner>}
      {audit.status === 'FAILED' && <Banner kind="error">The audit stopped because of a tool error: {audit.stop_reason}. This is a tool defect, not a website defect.</Banner>}
      {audit.status === 'INTERRUPTED' && <Banner kind="error">The worker stopped before this audit finished. Partial evidence was kept; start a new audit or retry.</Banner>}
      {audit.status === 'PARTIAL' && <Banner kind="info">Partial audit: {audit.stop_reason === 'STOPPED_RATE_LIMITED' ? 'the site rate-limited the auditor' : audit.stop_reason === 'STOPPED_ACCESS_CHALLENGES' ? 'the site returned repeated access challenges to the auditor' : audit.stop_reason === 'BUDGET_EXHAUSTED' ? 'the run budget was reached' : audit.stop_reason}. Scores cover only what was evaluated and are not proof of a healthy whole site.</Banner>}
      {finished && audit.coverage.pages.valid === 0 && <Banner kind="error">No page returned a genuine response to this auditor, so there is nothing to score. The site may be blocking automated clients; this does not show what search crawlers receive.</Banner>}
      {audit.report.state === 'FAILED' && <Banner kind="error">PDF export failed ({audit.report.error}). The audit results are unaffected; regenerate the report from the Report tab.</Banner>}
      <div className="tabs" role="tablist" aria-label="Audit sections">
        {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => go(`audit/${audit.audit_id}/${id}`)}>{label}{id === 'findings' ? ` (${audit.root_issues.length})` : id === 'pages' ? ` (${audit.pages.length})` : ''}</button>)}
      </div>
      <div role="tabpanel">
        {tab === 'pages' ? <PagesTab audit={audit} /> : tab === 'findings' ? <FindingsTab audit={audit} /> : tab === 'evidence' ? <EvidenceTab audit={audit} /> : tab === 'report' ? <ReportTab audit={audit} reload={reload} /> : <Overview audit={audit} go={go} />}
      </div>
    </>
  );
}
