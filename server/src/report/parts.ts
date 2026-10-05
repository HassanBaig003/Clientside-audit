import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Audit, CheckStatus, RootIssue, ScoreBlock } from '../types';

const require = createRequire(import.meta.url);

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Long URLs and code must wrap in print; zero-width break opportunities after URL punctuation. */
export const wrapUrl = (s: string) => esc(s).replace(/([/?&=._-])/g, '$1&#8203;');

let fontCss: string | null = null;
export function fontFaces(): string {
  if (fontCss !== null) return fontCss;
  const out: string[] = [];
  for (const [weight, sets] of [[400, ['latin', 'latin-ext']], [500, ['latin']], [600, ['latin', 'latin-ext']], [700, ['latin']]] as [number, string[]][]) {
    for (const set of sets) {
      try {
        const file = require.resolve(`@fontsource/inter/files/inter-${set}-${weight}-normal.woff2`);
        const b64 = fs.readFileSync(file).toString('base64');
        const range = set === 'latin' ? 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' : 'U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF';
        out.push(`@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${range};}`);
      } catch {
        /* font file missing: the system fallback stack is used */
      }
    }
  }
  fontCss = out.join('\n');
  return fontCss;
}

export const STATUS_LABEL: Record<CheckStatus, string> = { PASS: 'Pass', WARN: 'Warn', FAIL: 'Fail', NOT_APPLICABLE: 'N/A', NOT_TESTABLE: 'Unavailable', ERROR: 'Tool error' };
export const STATUS_GLYPH: Record<CheckStatus, string> = { PASS: '✓', WARN: '!', FAIL: '✕', NOT_APPLICABLE: '–', NOT_TESTABLE: '?', ERROR: '⚠' };

export function statusPill(s: CheckStatus): string {
  return `<span class="pill st-${s}">${STATUS_GLYPH[s]} ${STATUS_LABEL[s]}</span>`;
}
export function sevPill(i: Pick<RootIssue, 'severity' | 'classification'>): string {
  const label = i.classification === 'ISSUE' ? i.severity : i.classification === 'OPPORTUNITY' ? 'OPPORTUNITY' : i.classification;
  const cls = i.classification === 'ISSUE' ? i.severity : 'OPP';
  return `<span class="pill sev-${cls}">${label.charAt(0) + label.slice(1).toLowerCase()}</span>`;
}

/** Score headline. Excluded or suppressed values render as a dash, never 0 or 100. */
export function scoreCard(s: ScoreBlock): string {
  const v = s.value === null ? '–' : String(s.value);
  const cov = s.coverage.pct === null ? '–' : `${s.coverage.pct}%`;
  return `<div class="score">
    <div class="score-label">${esc(s.label)}</div>
    <div class="score-value">${v}<span class="score-of">${s.value === null ? '' : ' / 100'}</span></div>
    <div class="score-meta">${s.suppressed_reason ? esc(s.suppressed_reason) : `Test coverage ${cov} (${s.coverage.evaluated_units} of ${s.coverage.applicable_units} applicable check units evaluated)`}</div>
    <div class="score-foot">Wellows tool policy. Not a Google score or an industry benchmark.</div>
  </div>`;
}

/** Horizontal bars for category assessment. One hue, thin marks, value labels in text ink, sample sizes shown. */
export function categoryBars(s: ScoreBlock): string {
  const rows = s.categories
    .map((c) => {
      const w = c.score === null ? 0 : Math.max(0, Math.min(100, c.score));
      return `<tr>
        <td class="cb-name">${esc(c.label)}<span class="muted"> · weight ${c.weight}</span></td>
        <td class="cb-bar"><div class="track">${c.score === null ? '' : `<div class="fill" style="width:${w}%"></div>`}</div></td>
        <td class="cb-val">${c.score === null ? '–' : Math.round(c.score)}</td>
        <td class="cb-n muted">${c.evaluated_units}/${c.applicable_units} units</td>
      </tr>`;
    })
    .join('');
  return `<table class="bars" aria-label="${esc(s.label)} by category"><tbody>${rows}</tbody></table>
  <div class="caption">${esc(s.label)}: score per category (0–100) with evaluated / applicable check units. A dash means nothing in that category could be evaluated; it is excluded, not scored as zero.</div>`;
}

/** Deduplicated issue counts by severity. Status colour is paired with a label and number, never colour alone. */
export function severityChart(audit: Audit): string {
  const c = audit.summary.counts;
  const rows: [string, number, string][] = [['Critical', c.critical, 'CRITICAL'], ['High', c.high, 'HIGH'], ['Medium', c.medium, 'MEDIUM'], ['Low', c.low, 'LOW'], ['Opportunities / advisories', c.opportunities, 'OPP']];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<table class="bars" aria-label="Root issues by severity"><tbody>${rows
    .map((r) => `<tr><td class="cb-name">${r[0]}</td><td class="cb-bar"><div class="track">${r[1] ? `<div class="fill sevfill-${r[2]}" style="width:${(r[1] / max) * 100}%"></div>` : ''}</div></td><td class="cb-val">${r[1]}</td><td class="cb-n"></td></tr>`)
    .join('')}</tbody></table>
  <div class="caption">Deduplicated root issues in the evaluated sample of ${audit.coverage.pages.valid} valid page(s). Each root cause is counted once, however many sampled pages it affects.</div>`;
}

/** Field metrics against the documented "good" threshold. Only drawn when CrUX returned data. */
export function fieldChart(audit: Audit): string {
  const rows = audit.performance.field.filter((f) => f.available);
  if (!rows.length) return `<p class="unavail">Field data: unavailable for this run. ${esc(audit.performance.field[0]?.reason ?? 'No CrUX record was returned.')} Unavailable is not the same as poor.</p>`;
  const metric = (label: string, v: number | null, good: number, poor: number, fmt: (n: number) => string) => {
    if (v === null) return `<td class="fm"><div class="fm-label">${label}</div><div class="fm-val">–</div><div class="muted">not reported</div></td>`;
    const scale = poor * 1.25;
    const pos = Math.min(100, (v / scale) * 100);
    const state = v <= good ? 'Good' : v <= poor ? 'Needs improvement' : 'Poor';
    return `<td class="fm"><div class="fm-label">${label}</div><div class="fm-val">${fmt(v)}</div>
      <div class="fm-track"><div class="fm-good" style="width:${(good / scale) * 100}%"></div><div class="fm-mark" style="left:${pos}%"></div></div>
      <div class="muted">${state} · good ≤ ${fmt(good)}</div></td>`;
  };
  return `<table class="grid"><thead><tr><th>Key</th><th>LCP (p75)</th><th>INP (p75)</th><th>CLS (p75)</th><th>Period</th></tr></thead><tbody>${rows
    .map((f) => `<tr><td>${f.scope === 'ORIGIN' ? '<b>Origin (context only)</b><br>' : ''}${wrapUrl(f.key)}</td>
      ${metric('LCP', f.metrics.lcp_ms, 2500, 4000, (n) => `${(n / 1000).toFixed(2)} s`)}
      ${metric('INP', f.metrics.inp_ms, 200, 500, (n) => `${Math.round(n)} ms`)}
      ${metric('CLS', f.metrics.cls, 0.1, 0.25, (n) => n.toFixed(2))}
      <td class="muted">${esc(f.collection_period?.first ?? '')} to ${esc(f.collection_period?.last ?? '')}<br>${esc(f.form_factor ?? '')}</td></tr>`)
    .join('')}</tbody></table>
  <div class="caption">Chrome UX Report p75 field values (third-party data). The shaded band is the "good" range; the marker is the measured value. ${rows.length} record(s) returned.</div>`;
}

export const REPORT_CSS = `
@page { size: A4; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #111827; margin: 0; background: #fff; }
h1 { font-size: 24pt; line-height: 1.2; margin: 0 0 8pt; font-weight: 700; letter-spacing: -0.01em; }
h2 { font-size: 15pt; margin: 0 0 8pt; padding-bottom: 5pt; border-bottom: 1.5pt solid #0452F0; font-weight: 700; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 14pt 0 5pt; font-weight: 600; break-after: avoid; }
h4 { font-size: 10.5pt; margin: 0 0 3pt; font-weight: 600; }
p { margin: 0 0 7pt; }
ul { margin: 0 0 7pt; padding-left: 15pt; }
li { margin-bottom: 2.5pt; }
section { break-before: page; }
section.cover { break-before: auto; height: 250mm; display: flex; flex-direction: column; justify-content: space-between; }
.muted { color: #6B7280; }
.small { font-size: 8.5pt; }
.brand { font-weight: 700; font-size: 14pt; color: #0452F0; letter-spacing: -0.01em; }
.cover-meta td { padding: 3pt 14pt 3pt 0; vertical-align: top; }
.cover-meta td:first-child { color: #6B7280; white-space: nowrap; }
.demo { border: 1.5pt solid #B54708; background: #FFFAEB; color: #7A2E0E; padding: 7pt 10pt; border-radius: 5pt; font-weight: 600; margin-bottom: 10pt; }
.scores { display: flex; gap: 10pt; margin: 8pt 0 10pt; }
.score { flex: 1; border: 0.75pt solid #E5E7EB; border-radius: 7pt; padding: 10pt 12pt; break-inside: avoid; }
.score-label { font-size: 9pt; color: #6B7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.score-value { font-size: 30pt; font-weight: 700; line-height: 1.15; }
.score-of { font-size: 11pt; color: #6B7280; font-weight: 500; }
.score-meta { font-size: 8.5pt; color: #374151; }
.score-foot { font-size: 7.5pt; color: #6B7280; margin-top: 3pt; }
table { border-collapse: collapse; width: 100%; }
table.grid { margin: 4pt 0 8pt; font-size: 8.8pt; table-layout: fixed; }
table.grid th { text-align: left; background: #F4F5F7; font-weight: 600; padding: 4.5pt 6pt; border-bottom: 0.75pt solid #D1D5DB; }
table.grid td { padding: 4.5pt 6pt; border-bottom: 0.5pt solid #E5E7EB; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
table.grid thead { display: table-header-group; }
table.grid tr { break-inside: avoid; }
table.bars td { padding: 3pt 5pt 3pt 0; font-size: 9pt; vertical-align: middle; }
.cb-name { width: 44%; }
.cb-bar { width: 34%; }
.cb-val { width: 8%; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.cb-n { width: 14%; text-align: right; font-size: 8pt; }
.track { height: 7pt; background: #EEF0F3; border-radius: 4pt; overflow: hidden; }
.fill { height: 100%; background: #0452F0; border-radius: 0 4pt 4pt 0; }
.sevfill-CRITICAL { background: #d03b3b; } .sevfill-HIGH { background: #ec835a; } .sevfill-MEDIUM { background: #fab219; } .sevfill-LOW { background: #9CA3AF; } .sevfill-OPP { background: #0452F0; }
.caption { font-size: 8pt; color: #6B7280; margin: 2pt 0 9pt; }
.pill { display: inline-block; font-size: 7.8pt; font-weight: 600; padding: 1pt 5.5pt; border-radius: 9pt; border: 0.75pt solid; white-space: nowrap; }
.st-PASS { color: #05603A; border-color: #6CE9A6; background: #ECFDF3; }
.st-WARN { color: #93370D; border-color: #FEC84B; background: #FFFAEB; }
.st-FAIL { color: #912018; border-color: #FDA29B; background: #FEF3F2; }
.st-NOT_APPLICABLE { color: #475467; border-color: #D0D5DD; background: #F9FAFB; }
.st-NOT_TESTABLE { color: #3538CD; border-color: #C7D7FE; background: #EEF4FF; }
.st-ERROR { color: #6941C6; border-color: #D6BBFB; background: #F9F5FF; }
.sev-CRITICAL { color: #fff; border-color: #912018; background: #B42318; }
.sev-HIGH { color: #912018; border-color: #FDA29B; background: #FEF3F2; }
.sev-MEDIUM { color: #93370D; border-color: #FEC84B; background: #FFFAEB; }
.sev-LOW { color: #475467; border-color: #D0D5DD; background: #F9FAFB; }
.sev-OPP { color: #1D4ED8; border-color: #BFDBFE; background: #EFF6FF; }
.card { border: 0.75pt solid #E5E7EB; border-radius: 6pt; padding: 9pt 11pt; margin: 0 0 8pt; break-inside: avoid; }
.card h4 { display: flex; gap: 6pt; align-items: baseline; flex-wrap: wrap; }
.card .id { color: #6B7280; font-weight: 500; font-size: 8.5pt; }
.kv { font-size: 9pt; margin: 2pt 0; }
.kv b { font-weight: 600; }
.urls { font-size: 8.5pt; color: #374151; overflow-wrap: anywhere; }
.mono { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 7.6pt; }
.evi { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 7.8pt; background: #F9FAFB; border: 0.5pt solid #E5E7EB; border-radius: 4pt; padding: 5pt 6pt; margin: 3pt 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
pre.code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 7.8pt; background: #F9FAFB; border: 0.5pt solid #E5E7EB; border-radius: 4pt; padding: 6pt; white-space: pre-wrap; overflow-wrap: anywhere; margin: 3pt 0 8pt; }
.tpl { color: #93370D; font-weight: 600; font-size: 8.5pt; }
.unavail { border: 0.75pt dashed #C7D7FE; background: #F5F8FF; color: #3538CD; border-radius: 5pt; padding: 6pt 9pt; font-size: 9pt; }
.shots { display: flex; flex-wrap: wrap; gap: 9pt; }
.shot { width: 18.4%; break-inside: avoid; }
.shot img { width: 100%; border: 0.75pt solid #D1D5DB; border-radius: 4pt; display: block; }
.shot .cap { font-size: 6.6pt; color: #4B5563; margin-top: 3pt; overflow-wrap: anywhere; }
.fm-label { font-size: 7.5pt; color: #6B7280; } .fm-val { font-weight: 600; }
.fm-track { position: relative; height: 5pt; background: #EEF0F3; border-radius: 3pt; margin: 2pt 0; }
.fm-good { position: absolute; left: 0; top: 0; height: 100%; background: #B7E3B7; border-radius: 3pt 0 0 3pt; }
.fm-mark { position: absolute; top: -2pt; width: 2pt; height: 9pt; background: #111827; }
.cta { border-left: 2.5pt solid #0452F0; padding: 6pt 10pt; background: #F5F8FF; margin-top: 12pt; break-inside: avoid; }
.legend span { margin-right: 7pt; }
.matrix td, .matrix th { text-align: center; padding: 3pt 2pt !important; font-size: 7.6pt; }
.matrix td:first-child, .matrix th:first-child { text-align: left; }
.m-PASS { color: #05603A; } .m-WARN { color: #93370D; font-weight: 700; } .m-FAIL { color: #912018; font-weight: 700; } .m-NOT_APPLICABLE { color: #98A2B3; } .m-NOT_TESTABLE { color: #3538CD; } .m-ERROR { color: #6941C6; font-weight: 700; }
`;
