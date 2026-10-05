import { useEffect, useRef, useState } from 'react';
import { api, ACTIVE, type Progress } from './api';
import { Banner, fmtElapsed, Loading } from './ui';

const GLYPH: Record<string, string> = { DONE: '✓', PARTIAL: '!', FAILED: '✕', CANCELLED: '✕', SKIPPED: '–', PENDING: '' };

/** Screen 2: real stage states and counts from the job, with partial results as checks complete. */
export function Live({ id, onFinished }: { id: string; onFinished: () => void }) {
  const [p, setP] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(Date.now());
  const started = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.progress(id);
        if (!alive) return;
        setP(r);
        setError(null);
        if (started.current === null) started.current = Date.now() - r.elapsed_ms;
        if (!ACTIVE.includes(r.status)) return onFinished();
      } catch (e: any) {
        if (alive) setError(`Progress could not be loaded (${e.message}). Retrying…`);
      }
      if (alive) timer = window.setTimeout(poll, 1200);
    };
    let timer = window.setTimeout(poll, 0);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [id]);
  if (!p) return error ? <Banner kind="error">{error}</Banner> : <Loading what="audit progress" />;
  const elapsed = started.current ? now - started.current : p.elapsed_ms;
  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow">
          <h1>Audit in progress</h1>
          <div className="muted" aria-live="polite">Elapsed {fmtElapsed(elapsed)} · status {p.status.toLowerCase()}</div>
        </div>
        <button className="danger" disabled={cancelling} onClick={async () => { setCancelling(true); await api.cancel(id).catch(() => undefined); }}>{cancelling ? 'Cancelling…' : 'Cancel audit'}</button>
      </div>
      {p.mode === 'FIXTURE_DEMO' && <Banner kind="demo">Fixture / demo target. These are not client results.</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <div className="grid cols-2">
        <section className="card" aria-label="Audit stages">
          <h2>Stages</h2>
          {p.stages.map((s) => (
            <div key={s.id} className={`stage ${s.state}`}>
              <div className="dot" aria-hidden="true">{s.state === 'RUNNING' ? <span className="spin" /> : GLYPH[s.state]}</div>
              <div className="grow">
                <div><b>{s.label}</b> <span className="muted small">{s.state.toLowerCase()}</span></div>
                {/* Counts are shown only when the job reports a real total; no invented percentages. */}
                <div className="muted small">{s.completed !== null && s.total !== null ? `${s.completed} of ${s.total} · ` : ''}{s.detail ?? ''}</div>
              </div>
            </div>
          ))}
        </section>
        <section className="card" aria-label="Partial results">
          <h2>Results so far</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <span><b>{p.coverage.valid}</b> valid</span><span><b>{p.pages.length}</b> selected</span><span><b>{p.partial.checks}</b> checks</span><span><b>{p.partial.fail}</b> fail</span><span><b>{p.partial.warn}</b> warn</span>
          </div>
          {p.pages.length === 0 ? <p className="muted">Pages appear here once discovery has selected them.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Page</th><th>Type</th><th>RAW</th><th>Rendered</th></tr></thead>
                <tbody>
                  {p.pages.map((pg) => (
                    <tr key={pg.page_id}><td className="url">{new URL(pg.url).pathname}</td><td>{pg.page_type.replace('_', ' ')}</td><td className="small">{(pg.raw ?? '').replace('NOT_ATTEMPTED', 'pending').toLowerCase().replace(/_/g, ' ')}</td><td className="small">{(pg.rendered ?? '').replace('NOT_ATTEMPTED', 'pending').toLowerCase().replace(/_/g, ' ')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
