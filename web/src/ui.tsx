import { useEffect, useState, type ReactNode } from 'react';
import type { CheckStatus, RootIssue } from '../../server/src/types';

export const STATUS_LABEL: Record<CheckStatus, string> = { PASS: 'Pass', WARN: 'Warn', FAIL: 'Fail', NOT_APPLICABLE: 'N/A', NOT_TESTABLE: 'Unavailable', ERROR: 'Tool error' };
const GLYPH: Record<CheckStatus, string> = { PASS: '✓', WARN: '!', FAIL: '✕', NOT_APPLICABLE: '–', NOT_TESTABLE: '?', ERROR: '⚠' };

/** Status is always text plus a glyph, never colour alone. */
export function StatusPill({ status }: { status: CheckStatus }) {
  return (
    <span className={`pill st-${status}`}>
      <span aria-hidden="true">{GLYPH[status]}</span> {STATUS_LABEL[status]}
    </span>
  );
}

export function SevPill({ issue }: { issue: Pick<RootIssue, 'severity' | 'classification'> }) {
  const isIssue = issue.classification === 'ISSUE';
  const label = isIssue ? issue.severity : issue.classification;
  return <span className={`pill sev-${isIssue ? issue.severity : 'OPP'}`}>{label.charAt(0) + label.slice(1).toLowerCase()}</span>;
}

export function Banner({ kind, children }: { kind: 'demo' | 'info' | 'error' | 'ok'; children: ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
/** Excluded or suppressed values are a dash, never 0 or 100. */
export const dash = (v: number | null | undefined) => (v === null || v === undefined ? '–' : String(v));

export function useHashRoute(): [string[], (path: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [parts, (path) => (window.location.hash = `#/${path}`)];
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="card row" role="status">
      <span className="spin" aria-hidden="true" /> Loading {what}…
    </div>
  );
}
