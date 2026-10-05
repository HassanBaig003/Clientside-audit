import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, ACTIVE, type AppConfig } from './api';
import { Banner, Loading, useHashRoute } from './ui';
import { Setup } from './Setup';
import { Live } from './Live';
import { Results } from './Results';
import type { Audit } from '../../server/src/types';

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card login" onSubmit={submit}>
      <div className="wordmark" style={{ marginBottom: 12 }}>Wellows</div>
      <h1 style={{ marginBottom: 6 }}>Initial Website Audit</h1>
      <p className="muted">Sign in with your workspace access token. In the Wellows app this step is replaced by the existing session.</p>
      <div className="field">
        <label htmlFor="token">Access token</label>
        <input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-invalid={!!error} aria-describedby={error ? 'token-err' : undefined} required />
        {error && <div className="error-text" id="token-err">{error}</div>}
      </div>
      <button className="primary" type="submit" disabled={busy || !token.trim()}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}

/** Decides between the selection review, the live view and the results for one audit. */
function AuditRoute({ id, tab, go }: { id: string; tab: string | undefined; go: (p: string) => void }) {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    api.audit(id).then((a) => alive && setAudit(a), (e) => alive && setError(e instanceof ApiError && e.status === 404 ? 'This audit does not exist or is not in your workspace.' : e.message));
    return () => {
      alive = false;
    };
  }, [id, tick]);
  if (error) return <Banner kind="error">{error} <button className="link" onClick={() => go('')}>Back to audits</button></Banner>;
  if (!audit || audit.audit_id !== id) return <Loading what="audit" />;
  if (ACTIVE.includes(audit.status)) return <Live id={id} onFinished={() => setTick((t) => t + 1)} />;
  if (audit.status === 'AWAITING_SELECTION') return <Setup go={go} review={audit} onStarted={() => setTick((t) => t + 1)} />;
  return <Results audit={audit} tab={tab ?? 'overview'} go={go} reload={() => setTick((t) => t + 1)} />;
}

/** Extra top-level screens. The read-only artifact preview uses this to add its source browser; the product passes none. */
export interface ExtraScreen { path: string; label: string; render: () => ReactNode }

export function App({ extra = [] }: { extra?: ExtraScreen[] }) {
  const [parts, go] = useHashRoute();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  useEffect(() => {
    api.me().then(() => setAuthed(true), () => setAuthed(false));
    api.config().then(setCfg, () => setCfg(null));
  }, []);
  if (authed === null) return <div className="shell"><Loading what="workspace" /></div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="#/">Wellows</a>
        <span className="crumb">Initial Website Audit</span>
        <span className="spacer" />
        <a href="#/">Audits</a>
        {extra.map((x) => <a key={x.path} href={`#/${x.path}`}>{x.label}</a>)}
        <button className="sm" onClick={async () => { await api.logout(); setAuthed(false); }}>Sign out</button>
      </header>
      <main className="shell">
        {cfg?.fixture_mode && parts[0] !== 'audit' && <Banner kind="demo">Fixture / demo mode is on. Hosts ending in {cfg.fixture_host_suffix} are controlled test sites; their results are labelled as demo data and are never a client audit.</Banner>}
        {extra.find((x) => x.path === parts[0])?.render() ?? (parts[0] === 'audit' && parts[1] ? <AuditRoute id={parts[1]} tab={parts[2]} go={go} /> : <Setup go={go} config={cfg} />)}
      </main>
    </>
  );
}
