import { useMemo, useRef, useState } from 'react';
import { DEMO } from '../demoApi';

function useCopy(): [string | null, (key: string, text: string, el?: HTMLElement | null) => void] {
  const [done, setDone] = useState<string | null>(null);
  return [done, async (key, text, el) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard can be refused in some viewers: select the text so it can be copied by hand.
      if (el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(r);
      }
    }
    setDone(key);
    setTimeout(() => setDone(null), 1600);
  }];
}

/** Every source file of the deployable repository, readable and copyable. */
export function CodeBrowser() {
  const files = DEMO.files;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(files.find((f) => f.path === 'README.md')?.path ?? files[0].path);
  const [done, copy] = useCopy();
  const pre = useRef<HTMLPreElement>(null);
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of files) {
      if (q && !f.path.toLowerCase().includes(q.toLowerCase()) && !f.content.toLowerCase().includes(q.toLowerCase())) continue;
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(root)';
      if (!m.has(dir)) m.set(dir, []);
      m.get(dir)!.push(f.path);
    }
    return [...m.entries()].sort((a, b) => (a[0] === '(root)' ? -1 : b[0] === '(root)' ? 1 : a[0] < b[0] ? -1 : 1));
  }, [files, q]);
  const file = files.find((f) => f.path === open)!;
  const lines = files.reduce((n, f) => n + f.content.split('\n').length, 0);
  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Source code</h1>
      <p className="muted" style={{ marginBottom: 16 }}>{files.length} files, about {lines.toLocaleString()} lines. This is the same code as the zip delivered in the conversation. Dependencies are listed in package.json; run <code>npm install</code> to create the lockfile, which is not shown here.</p>
      <div className="code-layout">
        <nav className="card code-tree" aria-label="Files">
          <label htmlFor="code-q">Filter files or contents</label>
          <input id="code-q" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. robots, SSRF, Dockerfile" />
          {groups.length === 0 && <p className="muted small" style={{ marginTop: 10 }}>No file matches.</p>}
          {groups.map(([dir, paths]) => (
            <div key={dir} style={{ marginTop: 10 }}>
              <div className="small muted" style={{ fontWeight: 600 }}>{dir}</div>
              {paths.map((p) => (
                <button key={p} type="button" className={`tree-item${p === open ? ' on' : ''}`} aria-current={p === open} onClick={() => setOpen(p)}>{p.slice(p.lastIndexOf('/') + 1)}</button>
              ))}
            </div>
          ))}
        </nav>
        <section className="card code-view" aria-label={file.path}>
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 className="grow mono" style={{ margin: 0, fontSize: 13, overflowWrap: 'anywhere' }}>{file.path}</h2>
            <span className="muted small">{file.content.split('\n').length} lines</span>
            <button type="button" className="sm" onClick={() => copy(file.path, file.content, pre.current)}>{done === file.path ? 'Copied' : 'Copy file'}</button>
          </div>
          <pre className="code code-pre" ref={pre} tabIndex={0}>{file.content}</pre>
        </section>
      </div>
    </>
  );
}

const STEPS: { title: string; body: string; cmd?: string }[] = [
  { title: 'Unpack the zip from the conversation', body: 'It contains the server, the web UI, the fixtures and tests, the Dockerfile and the docs. Node.js 22 or newer is required.', cmd: 'unzip wellows-initial-audit.zip && cd wellows-audit\nnpm install' },
  { title: 'Set the two required values', body: 'AUDIT_API_TOKENS holds token:tenant pairs (tokens need 16+ characters). SESSION_SECRET signs the session cookie. Everything else has a default; .env.example lists it all.', cmd: 'cp .env.example .env\n# edit .env: AUDIT_API_TOKENS, SESSION_SECRET, AUDITOR_CONTACT_URL' },
  { title: 'Try it on the fixture sites first', body: 'Fixture mode routes hosts ending in .test to local test sites, so you can run real audits without touching a client website. Sign in with the token below and audit demo.test.', cmd: 'npx playwright install chromium\nnpm run build\nnpm run fixtures &\nFIXTURE_MODE=1 SECURE_COOKIES=0 SESSION_SECRET=dev \\\n  AUDIT_API_TOKENS="fixture-token-tenant-a-0001:demo" npm start\n# open http://localhost:8080' },
  { title: 'Run the checks yourself', body: 'The suite covers the 20 required cases against the fixtures. The verify script drives the real UI in Chromium and writes screenshots, the audit JSON and the PDF to ./verification.', cmd: 'npm test\nnpm run verify' },
  { title: 'Deploy the container', body: 'The image includes Chromium and runs as a non-root user. Mount /data for the SQLite index, evidence and PDFs, put it behind TLS, and give it outbound internet only. Turn FIXTURE_MODE off.', cmd: 'docker build -t wellows-initial-audit .\ndocker run -d -p 8080:8080 -v audit-data:/data \\\n  -e AUDIT_API_TOKENS="<long-random-token>:acme:Acme" \\\n  -e SESSION_SECRET="$(openssl rand -hex 32)" \\\n  -e AUDITOR_CONTACT_URL="https://your-domain.example/audit-bot" \\\n  wellows-initial-audit' },
  { title: 'Optional: field data and semantic review', body: 'Without these keys the dependent checks report "unavailable" and everything else still works.', cmd: 'CRUX_API_KEY=...            # Chrome UX Report field data\nLLM_API_KEY=... LLM_MODEL=...   # one bounded content-review call per audit' },
];

export function Deploy() {
  const [done, copy] = useCopy();
  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Deploy and test</h1>
      <p className="muted" style={{ marginBottom: 16, maxWidth: 760 }}>The audit engine fetches websites and runs a headless browser on a server, so it cannot run inside this page. This page shows the real interface with stored fixture results; to run audits, deploy the code.</p>
      <div className="banner info" style={{ maxWidth: 860 }}>
        <b>What you can test here:</b> every results screen (overview, pages, page detail, findings with filters, evidence, report pages), the page-selection review, a blocked-site state and the setup form's validation. <b>What needs the deployed app:</b> running an audit, the live progress screen, cancelling, retrying and downloading the PDF.
      </div>
      <ol className="steps">
        {STEPS.map((s, n) => (
          <li key={s.title} className="card">
            <h2>{n + 1}. {s.title}</h2>
            <p style={{ maxWidth: 760 }}>{s.body}</p>
            {s.cmd && (
              <div className="row top">
                <pre className="code grow" style={{ margin: 0 }} id={`cmd-${n}`}>{s.cmd}</pre>
                <button type="button" className="sm" onClick={() => copy(`c${n}`, s.cmd!, document.getElementById(`cmd-${n}`))}>{done === `c${n}` ? 'Copied' : 'Copy'}</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="card" style={{ maxWidth: 860 }}>
        <h2>Not verified in the build session</h2>
        <ul className="plain">
          <li>The Docker image was written but not built: no Docker daemon was available.</li>
          <li>No real public website was audited. All results on this page come from local fixture sites and are labelled as demo data.</li>
          <li>The CrUX API and the LLM review were exercised against local mock endpoints, not the live services.</li>
          <li>No Wellows application repository was supplied, so auth, the client/project model and the design tokens are documented fallbacks.</li>
        </ul>
        <p className="muted small" style={{ marginBottom: 0 }}>docs/VERIFICATION.md in the source lists everything that was and was not verified.</p>
      </div>
    </>
  );
}
