import type { Audit, CategoryId, CheckStatus, RootIssue } from '../types';
import { CATEGORY_LABELS, RULES, ruleById } from '../checks/registry';
import { FEATURE_REGISTRY_REVIEWED, FEATURE_REGISTRY_VERSION, BOT_REGISTRY_VERSION } from '../sources/registry';
import { REPORT_CSS, STATUS_GLYPH, STATUS_LABEL, categoryBars, esc, fieldChart, fontFaces, scoreCard, sevPill, severityChart, statusPill, wrapUrl } from './parts';

const DETAIL_ORDER: CategoryId[] = ['crawl_indexing', 'onpage_links', 'structured_international', 'field_performance', 'ai_access', 'ux_accessibility', 'https_transport'];
const fmtTime = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '–');
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Builds the standalone report document from the stored audit object. It reads nothing else:
 * no live site, no dashboard markup. Every count, score and affected page comes from the same JSON the UI shows.
 */
export function buildReportHtml(audit: Audit, blob: (ref: string) => Buffer | null): string {
  const pageById = new Map(audit.pages.map((p) => [p.page_id, p]));
  const pageIdOf = new Map(audit.pages.map((p) => [p.url, p.page_id]));
  const evById = new Map(audit.evidence.map((e) => [e.evidence_id, e]));
  const srcById = new Map(audit.sources.map((s) => [s.source_id, s]));
  const issues = audit.root_issues;
  const priority = issues.filter((i) => i.classification === 'ISSUE' && (i.severity === 'CRITICAL' || i.severity === 'HIGH'));
  const cov = audit.coverage.pages;
  const demo = audit.mode === 'FIXTURE_DEMO';
  const client = audit.config.branding.client_display_name ?? audit.client_name;
  const demoBanner = demo ? '<div class="demo">FIXTURE / DEMO DATA. This report was generated from a controlled test site, not from a client website.</div>' : '';

  const urls = (i: RootIssue) => (i.affected_urls.length ? i.affected_urls.map((u) => `<span style="white-space:nowrap">${pageIdOf.get(u) ?? ''}</span> ${wrapUrl(u)}`).join(' &nbsp;·&nbsp; ') : 'Site-level (not tied to one sampled page)');
  const srcLabel = (l: string) => l.charAt(0) + l.slice(1).toLowerCase().replace('_', ' ');
  const evidenceBlock = (ids: string[], max = 2) =>
    ids.slice(0, max).map((id) => {
      const e = evById.get(id);
      return e ? `<div class="evi"><b>${e.evidence_id}</b> · ${esc(e.profile)} · ${esc(e.locator)} · ${fmtTime(e.captured_at)}\n${esc(e.observed)}${e.expected ? `\nExpected: ${esc(e.expected)}` : ''}</div>` : '';
    }).join('');
  const refs = (i: RootIssue) => i.source_ids.map((s) => srcById.get(s)).filter(Boolean).map((s) => `${esc(s!.title)} [${srcLabel(s!.label)}]`).join('; ');

  const meta = (i: RootIssue) => `<div class="kv muted">Check ${i.check_id} · ${esc(i.confidence.toLowerCase().replace('_', '-'))}${i.caveat ? ` · ${esc(i.caveat)}` : ''}${i.score_included ? '' : ' · unscored'}${i.related_issue_ids.length ? ` · related to ${i.related_issue_ids.join(', ')}` : ''}</div>`;
  const head = (i: RootIssue) => `<h4><span class="id">${i.issue_id}</span> ${esc(i.title)} ${sevPill(i)} <span class="pill st-${i.finding_status}">${STATUS_LABEL[i.finding_status]}</span></h4>`;
  /** Section 2: impact and first action. Section 3: explanation and evidence (the action table is section 5). */
  const priorityCard = (i: RootIssue) => `<div class="card">${head(i)}
    <p>${esc(i.explanation)}</p>
    <div class="kv"><b>Practical impact:</b> ${esc(i.practical_impact)}</div>
    <div class="kv"><b>Recommended first action:</b> ${esc(i.recommended_action)}</div>
    <div class="kv"><b>Affected sample pages:</b> <span class="urls">${urls(i)}</span></div>${meta(i)}</div>`;
  const detailCard = (i: RootIssue) => `<div class="card">${head(i)}
    ${priority.includes(i) ? '<div class="kv muted">Explanation, impact and first action: see section 2.</div>' : `<p>${esc(i.explanation)}</p><div class="kv"><b>Practical impact:</b> ${esc(i.practical_impact)}</div>`}
    <div class="kv"><b>Affected sample pages:</b> <span class="urls">${urls(i)}</span></div>
    ${evidenceBlock(i.evidence_ids, 1)}${i.evidence_ids.length > 1 ? `<div class="kv small muted">${i.evidence_ids.length - 1} further evidence item(s): ${i.evidence_ids.slice(1, 9).join(', ')}${i.evidence_ids.length > 9 ? ', …' : ''} (in the audit JSON export).</div>` : ''}
    ${meta(i)}<div class="kv small muted">Reference: ${refs(i)}</div></div>`;
  /** Low-severity findings, opportunities and advisories: one compact row each, visibly separate from issues. */
  const minorTable = (list: RootIssue[]) => `<table class="grid"><thead><tr><th style="width:7%">ID</th><th style="width:30%">Finding</th><th style="width:13%">Pages</th><th>Observed evidence</th></tr></thead><tbody>${list.map((i) => {
    const e = evById.get(i.evidence_ids[0]);
    return `<tr><td>${i.issue_id}</td><td><b>${esc(i.title)}</b> ${sevPill(i)}${i.score_included ? '' : ' <span class="muted">unscored</span>'}<br><span class="muted">${esc(short(i.practical_impact, 150))}</span></td><td>${i.affected_page_ids.join(', ') || 'Site-level'}</td><td><span class="mono">${e ? `${e.evidence_id} · ${esc(e.profile)} · ${esc(short(e.observed, 210))}` : ''}</span></td></tr>`;
  }).join('')}</tbody></table>`;

  // ---- Cover -----------------------------------------------------------------------------------------------
  const cover = `<section class="cover">
    <div>
      <div class="brand">Wellows</div>
      ${audit.config.branding.logo_data_uri ? `<img src="${audit.config.branding.logo_data_uri}" alt="${esc(client)} logo" style="max-height:44pt;max-width:160pt;margin-top:14pt">` : ''}
    </div>
    <div>
      ${demoBanner}
      <div class="muted" style="font-weight:600;letter-spacing:.05em;text-transform:uppercase;font-size:9pt">${esc(client)} · ${esc(audit.target.host)}</div>
      <h1>Initial Website SEO and AI Content Readiness Audit</h1>
      <p style="font-size:12pt;color:#374151">Up to 10 representative public pages · ${cov.valid} valid page(s) evaluated of ${cov.selected} selected</p>
      <table class="cover-meta" style="width:auto;margin-top:14pt">
        <tr><td>Audited</td><td>${fmtTime(audit.timings.finished_at ?? audit.timings.started_at)}</td></tr>
        <tr><td>Website</td><td>${wrapUrl(audit.target.preferred_origin ?? audit.target.normalized_url)}</td></tr>
        <tr><td>Assessment</td><td>Mobile, public website, search and AI discovery readiness</td></tr>
        <tr><td>Run quality</td><td>${esc(audit.run_quality)}${audit.stop_reason ? ` (${esc(audit.stop_reason)})` : ''}</td></tr>
        ${audit.config.branding.prepared_by ? `<tr><td>Prepared by</td><td>${esc(audit.config.branding.prepared_by)}</td></tr>` : ''}
      </table>
    </div>
    <div class="small muted">This is an initial audit of a small representative sample. It is not a full-site audit, a measurement of AI citations, or a prediction of rankings, leads or revenue.</div>
  </section>`;

  // ---- 1. Executive summary ---------------------------------------------------------------------------------
  const unavailable = audit.coverage.omitted_checks;
  const s1 = `<section><h2>1. Executive summary</h2>
    ${demoBanner}
    <p><b>Scope.</b> ${esc(audit.summary.narrative[0] ?? '')}</p>
    ${audit.run_quality !== 'COMPLETE' ? `<p class="unavail"><b>Partial scope.</b> Run quality is ${esc(audit.run_quality)}${audit.stop_reason ? ` (${esc(audit.stop_reason)})` : ''}. Scores describe only what could be evaluated and are not proof of a healthy whole site.</p>` : ''}
    <div class="scores">${scoreCard(audit.scores.technical_health)}${scoreCard(audit.scores.ai_accessibility)}</div>
    <p class="small muted">Initial Technical Health covers the applicable technical checks in this sample. AI Technical Accessibility covers RAW text availability, RAW important-link availability and search-crawler robots access only. Neither is a content-quality score or a measured LLM visibility score. This audit assesses readiness; it does not measure whether AI services actually cite the site.</p>
    <h3>Observed strengths</h3>
    ${audit.summary.strengths.length ? `<ul>${audit.summary.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p class="muted">No strength could be confirmed from the evidence available in this run.</p>'}
    <h3>Main risks</h3>
    ${audit.summary.top_issue_ids.length ? `<ul>${audit.summary.top_issue_ids.map((id) => issues.find((i) => i.issue_id === id)).filter(Boolean).map((i) => `<li><b>${i!.issue_id}</b> ${esc(i!.title)} ${sevPill(i!)} <span class="muted">(${i!.affected_urls.length || 'site-level'}${i!.affected_urls.length ? ' sample page(s)' : ''})</span></li>`).join('')}</ul>` : '<p>No verified issue was found in the evaluated sample.</p>'}
    <p>${esc(audit.summary.narrative[1] ?? '')}</p>
    <h3>Root issues by severity</h3>${severityChart(audit)}
    <h3>Unavailable evidence</h3>
    ${unavailable.length ? `<p>${unavailable.length} check unit(s) could not be evaluated and are excluded from the scores (shown as “Unavailable” in the appendix matrix). Most common reasons:</p><ul>${[...new Set(unavailable.map((u) => short(u.reason, 190)))].slice(0, 5).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p>Every applicable check unit was evaluated.</p>'}
  </section>`;

  // ---- 2. Priority issues ---------------------------------------------------------------------------------------
  const s2 = `<section><h2>2. Priority issues</h2>
    <p class="muted">Deduplicated, verified critical and high issues. Each root cause appears once with every affected sample URL.</p>
    ${priority.length ? priority.map(priorityCard).join('') : '<p class="unavail" style="color:#05603A;border-color:#6CE9A6;background:#ECFDF3">No verified critical or high issue was found in the evaluated sample. The findings in section 3 are proportionate improvements, not urgent blockers.</p>'}
  </section>`;

  // ---- 3. Detailed findings ---------------------------------------------------------------------------------------
  const detail = DETAIL_ORDER.map((cat) => {
    const list = issues.filter((i) => i.category === cat);
    const checks = audit.checks.filter((c) => c.category === cat);
    const tally = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
    const catHead = `<h3>${esc(CATEGORY_LABELS[cat])}</h3><p class="small muted">${checks.length} check unit(s): ${tally('PASS')} pass, ${tally('WARN')} warn, ${tally('FAIL')} fail, ${tally('NOT_APPLICABLE')} n/a, ${tally('NOT_TESTABLE')} unavailable, ${tally('ERROR')} tool error.</p>`;
    let extra = '';
    if (cat === 'field_performance') {
      extra = fieldChart(audit) + (audit.performance.lab.length
        ? `<h4>Lab diagnostics (unscored)</h4><table class="grid"><thead><tr><th style="width:30%">Page</th><th>LCP</th><th>CLS</th><th>TBT</th><th style="width:34%">LCP element / resource</th></tr></thead><tbody>${audit.performance.lab.map((l) => `<tr><td>${wrapUrl(l.url)}</td><td>${l.available ? `${l.lcp_ms ?? '–'} ms` : 'Unavailable'}</td><td>${l.available ? l.cls ?? '–' : '–'}</td><td>${l.available ? `${l.tbt_ms} ms` : '–'}</td><td>${esc(l.lcp_element ?? '–')}${l.lcp_resource ? `<br>${wrapUrl(short(l.lcp_resource, 90))}` : ''}${!l.available ? esc(l.reason ?? '') : ''}</td></tr>`).join('')}</tbody></table><div class="caption">${esc(audit.performance.lab[0].environment)}. Lab measurements are diagnostics; they do not decide the Core Web Vitals verdict, and TBT is not INP.</div>`
        : '');
    }
    if (cat === 'ai_access') {
      extra = `<p class="small">This area describes access and content readiness. A website audit alone does not measure inclusion, mentions or citations in any LLM service. Google's AI features use ordinary Search requirements and need no AI text file or special schema.</p>
      <table class="grid"><thead><tr><th style="width:20%">Token</th><th style="width:27%">Role</th><th>Robots decision per sampled page</th><th style="width:12%">Scored</th></tr></thead><tbody>${audit.site.ai_bots.map((b) => {
        const d = b.decisions.map((x) => x.decision.decision);
        const sum = ['ALLOW', 'DISALLOW', 'UNKNOWN'].map((k) => (d.filter((x) => x === k).length ? `${k} ×${d.filter((x) => x === k).length}` : '')).filter(Boolean).join(', ');
        return `<tr><td><b>${esc(b.token)}</b></td><td>${esc(b.role)}</td><td>${esc(sum || '–')}</td><td>${b.scored ? 'Yes' : 'No'}</td></tr>`;
      }).join('')}</tbody></table><div class="caption">Robots-level access only. A robots allow cannot establish that a vendor's real crawler IPs pass the site's CDN or firewall. Training and user-triggered tokens are policy choices and never lower a score. Bot registry ${BOT_REGISTRY_VERSION}.</div>`;
    }
    const major = list.filter((i) => i.classification === 'ISSUE' && i.severity !== 'LOW');
    const minor = list.filter((i) => !major.includes(i));
    return `${catHead}${extra}${list.length ? `${major.map(detailCard).join('')}${minor.length ? `<h4 style="margin-top:6pt">Low-severity findings, opportunities and advisories</h4>${minorTable(minor)}` : ''}` : '<p class="muted">No finding in this category for the evaluated sample.</p>'}`;
  }).join('');
  const cr = audit.content_review;
  const contentBlock = `<h3>Focused content review <span class="pill sev-OPP">content-review advisory · unscored</span></h3>
    <p class="small muted">${esc(cr.note)}</p>${cr.summary ? `<p>${esc(cr.summary)}</p>` : ''}
    ${cr.observations.length ? cr.observations.map((o) => `<div class="card"><h4><span class="id">${o.observation_id}</span> ${esc(o.area.replace(/_/g, ' '))} <span class="pill sev-OPP">${o.origin === 'LLM' ? 'modelled' : 'deterministic'}</span></h4><div class="urls">${wrapUrl(o.url)}</div><div class="evi">“${esc(o.excerpt)}”</div><div class="kv"><b>Observation:</b> ${esc(o.observation)}</div><div class="kv"><b>Suggestion:</b> ${esc(o.suggestion)}</div><div class="kv muted">Confidence: ${o.confidence}. Advisory only; not measured LLM behaviour and not part of either score.</div></div>`).join('') : '<p class="muted">No content-review observation was recorded.</p>'}
    <h3>Optional signals <span class="pill sev-LOW">optional · unscored</span></h3>
    ${audit.optional_signals.map((o) => `<p><b>${esc(o.label)}:</b> ${esc(o.state)}. ${esc(o.note)}</p>`).join('')}`;
  const s3 = `<section><h2>3. Detailed audit findings</h2>
    <h3 style="margin-top:0">Category assessment</h3>${categoryBars(audit.scores.technical_health)}${categoryBars(audit.scores.ai_accessibility)}
    ${detail}${contentBlock}</section>`;

  // ---- 4. Screenshots and evidence -----------------------------------------------------------------------------------
  const shots = audit.pages.filter((p) => p.screenshot_ref).map((p) => {
    const b = blob(p.screenshot_ref as string);
    if (!b) return '';
    const related = issues.filter((i) => i.affected_page_ids.includes(p.page_id)).map((i) => i.issue_id).slice(0, 6).join(', ') || 'no finding';
    return `<div class="shot"><img src="data:image/jpeg;base64,${b.toString('base64')}" alt="Mobile screenshot of ${esc(p.url)}"><div class="cap"><b>${p.page_id}</b> ${wrapUrl(short(p.url, 80))}<br>Rendered ${fmtTime(p.rendered.rendered_at)} · 412×915 · ${esc(related)}</div></div>`;
  }).join('');
  const sm = audit.site.sitemap;
  const s4 = `<section><h2>4. Screenshots and evidence</h2>
    <h3 style="margin-top:0">Rendered page screenshots (mobile viewport)</h3>
    ${shots ? `<div class="shots">${shots}</div>` : '<p class="unavail">No screenshot is available: no page could be rendered in this run.</p>'}
    <h3>RAW versus RENDERED comparison</h3>
    <table class="grid"><thead><tr><th style="width:8%">Page</th><th style="width:22%">RAW response</th><th style="width:22%">RENDERED response</th><th>RAW words</th><th>RENDERED words</th><th>RAW links</th><th>RENDERED links</th></tr></thead><tbody>${audit.pages.map((p) => `<tr><td>${p.page_id}</td><td>${esc(p.raw.acquisition === 'OK' ? `${p.raw.validity} (HTTP ${p.raw.status})` : p.raw.acquisition)}</td><td>${esc(p.rendered.acquisition === 'OK' ? `${p.rendered.validity} (HTTP ${p.rendered.status ?? '–'})` : p.rendered.acquisition)}</td><td>${p.raw_extract?.word_count ?? '–'}</td><td>${p.rendered_extract?.word_count ?? '–'}</td><td>${p.raw_extract ? p.raw_extract.links.filter((l) => l.crawlable && l.internal).length : '–'}</td><td>${p.rendered_extract ? p.rendered_extract.links.filter((l) => l.crawlable && l.internal).length : '–'}</td></tr>`).join('')}</tbody></table>
    <div class="caption">A dash means that profile was not a genuine page response, so no content conclusion is drawn from it.</div>
    <h3>robots.txt</h3>
    <div class="evi">${wrapUrl(audit.site.robots.url ?? '–')}\n${esc(audit.site.robots.note)}${audit.site.robots.unsupported_fields.length ? `\nUnsupported fields (not indexing directives): ${esc(audit.site.robots.unsupported_fields.join(', '))}` : ''}</div>
    <table class="grid"><thead><tr><th style="width:8%">Page</th><th style="width:36%">Path</th><th>Auditor</th><th>Googlebot</th><th style="width:28%">Matching rule (Googlebot)</th></tr></thead><tbody>${audit.pages.map((p) => `<tr><td>${p.page_id}</td><td>${wrapUrl(new URL(p.url).pathname + new URL(p.url).search)}</td><td>${p.robots.auditor.decision}</td><td>${p.robots.googlebot.decision}</td><td>${esc(p.robots.googlebot.matched_rule ?? p.robots.googlebot.reason)}</td></tr>`).join('')}</tbody></table>
    <h3>Parent sitemap status matrix</h3>
    <p class="small">${esc(sm.scope_statement)}</p>
    ${sm.matrix.length ? `<table class="grid"><thead><tr><th style="width:29%">Requested URL</th><th style="width:8%">Initial</th><th style="width:7%">Hops</th><th style="width:24%">Final URL</th><th style="width:7%">Final</th><th>Network error</th><th style="width:15%">Result</th></tr></thead><tbody>${sm.matrix.map((m) => `<tr><td>${wrapUrl(m.requested_url)}<br><span class="muted">${m.role}</span></td><td>${m.initial_status ?? '–'}</td><td>${m.hops.length}</td><td>${m.final_url ? wrapUrl(m.final_url) : '–'}</td><td>${m.final_status ?? '–'}</td><td>${esc(m.network_error ? short(m.network_error, 60) : '–')}</td><td><b>${m.result.replace('_', ' ')}</b></td></tr>`).join('')}</tbody></table>` : '<p class="unavail">The sitemap endpoint was not tested in this run.</p>'}
    <div class="caption">Chosen endpoint: ${sm.chosen ? wrapUrl(sm.chosen) : 'none found'} (${esc(sm.chosen_basis.replace(/_/g, ' '))}). Variants that do not open are observations, not failures.</div>
  </section>`;

  // ---- 5. Recommendations -----------------------------------------------------------------------------------------------
  const s5 = `<section><h2>5. Recommendations</h2>
    ${issues.length ? `<table class="grid"><thead><tr><th style="width:7%">ID</th><th style="width:36%">Action</th><th style="width:17%">Affected sample pages</th><th style="width:19%">Priority</th><th>Suggested owner</th><th style="width:7%">Effort</th></tr></thead><tbody>${issues.map((i) => `<tr><td>${i.issue_id}</td><td>${esc(i.recommended_action)}</td><td>${i.affected_page_ids.length ? i.affected_page_ids.join(', ') : 'Site-level'}</td><td style="white-space:nowrap">${i.priority} ${sevPill(i)}</td><td>${esc(i.suggested_owner)}</td><td>${i.effort}</td></tr>`).join('')}</tbody></table><div class="caption">Effort is indicative: S = hours, M = days, L = a planned project. Page IDs refer to the audited page list in the appendix. Longer code is in the appendix.</div>` : '<p>No corrective recommendation arises from the evaluated sample.</p>'}
  </section>`;

  // ---- 6. Action plan ----------------------------------------------------------------------------------------------------
  const s6 = `<section style="break-before:auto;margin-top:16pt"><h2>6. Action plan</h2>
    <p class="muted">Suggested sequence. Timing and effort are estimates, not commitments, and no result is promised.</p>
    ${audit.summary.action_plan.length ? audit.summary.action_plan.map((ph) => `<div class="card"><h4>${esc(ph.phase)} <span class="muted" style="font-weight:500">${esc(ph.label)}</span></h4><ul>${ph.issue_ids.map((id) => issues.find((i) => i.issue_id === id)).filter(Boolean).map((i) => `<li><b>${i!.issue_id}</b> ${esc(i!.title)} <span class="muted">· ${esc(i!.suggested_owner)} · effort ${i!.effort}</span></li>`).join('')}</ul></div>`).join('') : '<p>No phased work is needed for the evaluated sample. Re-audit after significant site changes.</p>'}
    <div class="cta">If it is useful, the Wellows team can review these prioritised findings with you and help implement them.</div>
  </section>`;

  // ---- 7. Appendix ----------------------------------------------------------------------------------------------------------
  const pageChecks = RULES.filter((r) => r.scope === 'PAGE');
  const cell = (cid: string, pid: string | null) => {
    const c = audit.checks.find((x) => x.check_id === cid && x.page_id === pid);
    return c ? `<td class="m-${c.status}" title="${STATUS_LABEL[c.status]}">${STATUS_GLYPH[c.status]}</td>` : '<td class="m-NOT_APPLICABLE">·</td>';
  };
  const matrix = `<table class="grid matrix"><thead><tr><th style="width:36%">Check</th>${audit.pages.map((p) => `<th>${p.page_id}</th>`).join('')}</tr></thead><tbody>${pageChecks.map((r) => `<tr><td>${r.check_id} ${esc(r.name)}${r.score ? '' : ' <span class="muted">(unscored)</span>'}</td>${audit.pages.map((p) => cell(r.check_id, p.page_id)).join('')}</tr>`).join('')}</tbody></table>`;
  const siteRows = RULES.filter((r) => r.scope !== 'PAGE').map((r) => {
    const c = audit.checks.find((x) => x.check_id === r.check_id);
    return `<tr><td>${r.check_id} ${esc(r.name)}${r.score ? '' : ' <span class="muted">(unscored)</span>'}</td><td>${c ? statusPill(c.status) : '<span class="muted">not run</span>'}</td><td>${esc(short(c?.findings[0]?.title ?? c?.limitations[0] ?? c?.notes[0] ?? '', 230))}</td></tr>`;
  }).join('');
  const codeBlocks = issues.filter((i) => i.code).map((i) => `<h4>${i.issue_id} · ${esc(i.code!.label)}</h4>${i.code!.is_template ? '<div class="tpl">Template: requires verified values. Not ready to publish.</div>' : ''}<pre class="code">${esc(i.code!.content)}</pre>`).join('');
  const usedSources = new Set(issues.flatMap((i) => i.source_ids).concat(audit.checks.flatMap((c) => ruleById.get(c.check_id)?.source_ids ?? [])));
  const s7 = `<section><h2>7. Appendix</h2>
    <h3 style="margin-top:0">A. Audited pages and selection reasons</h3>
    <table class="grid"><thead><tr><th style="width:6%">ID</th><th style="width:34%">URL</th><th>Type</th><th style="width:26%">Selection reason</th><th>Group</th><th>State</th></tr></thead><tbody>${audit.pages.map((p) => `<tr><td>${p.page_id}</td><td>${wrapUrl(p.url)}</td><td>${esc(p.page_type)}</td><td>${esc(p.selection_reason)}${p.operator_override ? ` (${esc(p.operator_override)})` : ''}</td><td>${wrapUrl(p.observed_group)}</td><td>${esc(p.state)}${p.technical_eligibility ? `<br><span class="muted">${esc(p.technical_eligibility.toLowerCase().replace('_', ' '))}</span>` : ''}</td></tr>`).join('')}</tbody></table>
    <div class="caption">Selected ${cov.selected} · fetched ${cov.fetched} · valid ${cov.valid} · blocked ${cov.blocked} · challenged ${cov.challenged} · error pages ${cov.error_pages} · unavailable ${cov.unavailable}. Page type is a heuristic label from the observed URL and link text. “Eligible” means technically eligible based on observable signals, not confirmed as indexed.</div>
    <h3>B. Check-status matrix: sampled pages</h3>${matrix}
    <div class="caption legend"><span class="m-PASS">✓ Pass</span><span class="m-WARN">! Warn</span><span class="m-FAIL">✕ Fail</span><span class="m-NOT_APPLICABLE">– N/A</span><span class="m-NOT_TESTABLE">? Unavailable (not testable)</span><span class="m-ERROR">⚠ Tool error (a tool defect, not a website defect)</span></div>
    <h3>C. Check-status matrix: site-level and sample-level checks</h3>
    <table class="grid"><thead><tr><th style="width:38%">Check</th><th style="width:13%">Status</th><th>Note</th></tr></thead><tbody>${siteRows}</tbody></table>
    <h3>D. Scoring method</h3>
    <p class="small">${esc(audit.scores.technical_health.method)}</p>
    <p class="small">Initial Technical Health category weights: ${audit.scores.technical_health.categories.map((c) => `${esc(c.label)} ${c.weight}`).join('; ')}. AI Technical Accessibility weights: ${audit.scores.ai_accessibility.categories.map((c) => `${esc(c.label)} ${c.weight}`).join('; ')}. The headline is withheld when no genuine page was evaluated or coverage is below 50%. These weights are Wellows tool policy.</p>
    <h3>E. Versions, timings and limits</h3>
    <table class="grid"><tbody>
      <tr><td style="width:32%">Tool / schema / rule registry</td><td>${esc(audit.tool_version)} / ${esc(audit.schema_version)} / ${esc(audit.rule_registry_version)}</td></tr>
      <tr><td>Google feature registry</td><td>${FEATURE_REGISTRY_VERSION}, reviewed ${FEATURE_REGISTRY_REVIEWED}</td></tr>
      <tr><td>Source registry reviewed</td><td>${esc(audit.source_registry_reviewed)}</td></tr>
      <tr><td>Audit / run ID</td><td>${esc(audit.audit_id)}${audit.retry_of ? ` (bounded retry ${audit.retry_count} of ${esc(audit.retry_of)})` : ''}</td></tr>
      <tr><td>Started / finished</td><td>${fmtTime(audit.timings.started_at)} / ${fmtTime(audit.timings.finished_at)} (${audit.timings.elapsed_ms !== null ? `${Math.round(audit.timings.elapsed_ms / 1000)} s` : '–'})</td></tr>
      <tr><td>Auditor user agent</td><td>${esc(audit.auditor.user_agent)}</td></tr>
      <tr><td>Crawl limits (product limits)</td><td>${esc(Object.entries(audit.config.budgets).map(([k, v]) => `${k}=${v}`).join(', '))}</td></tr>
      <tr><td>Budget used</td><td>${esc(Object.entries(audit.budgets_used).map(([k, v]) => `${k}=${v}`).join(', '))}</td></tr>
      <tr><td>Performance scope</td><td>${esc(audit.performance.note)}</td></tr>
      <tr><td>Site facts</td><td>${Object.entries(audit.site_facts).map(([k, v]) => `${esc(k)}: ${esc(v.value)} <span class="muted">[${v.basis}]</span>`).join('<br>')}</td></tr>
    </tbody></table>
    <h3>F. Limitations and unavailable checks</h3>
    <ul class="small">${audit.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    ${unavailable.length ? `<table class="grid"><thead><tr><th style="width:10%">Check</th><th style="width:8%">Page</th><th style="width:13%">Status</th><th>Reason</th></tr></thead><tbody>${unavailable.slice(0, 60).map((u) => `<tr><td>${u.check_id}</td><td>${u.page_id ?? 'site'}</td><td>${statusPill(u.status)}</td><td>${esc(short(u.reason, 240))}</td></tr>`).join('')}</tbody></table>${unavailable.length > 60 ? `<div class="caption">${unavailable.length - 60} further unavailable units are listed in the audit JSON export.</div>` : ''}` : ''}
    ${codeBlocks ? `<h3>G. Supporting code</h3>${codeBlocks}` : ''}
    <h3>${codeBlocks ? 'H' : 'G'}. Source references</h3>
    <table class="grid"><thead><tr><th style="width:29%">Source</th><th style="width:13%">Label</th><th>Supports</th><th style="width:17%">Reviewed</th></tr></thead><tbody>${audit.sources.filter((s) => usedSources.has(s.source_id)).map((s) => `<tr><td><b>${esc(s.title)}</b><br><span class="muted">${wrapUrl(s.url)}</span></td><td>${srcLabel(s.label)}</td><td>${esc(s.supports)}</td><td>${esc(s.reviewed)}</td></tr>`).join('')}</tbody></table>
  </section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(client)} - Initial Website SEO and AI Content Readiness Audit</title><style>${fontFaces()}${REPORT_CSS}</style></head><body>${cover}${s1}${s2}${s3}${s4}${s5}${s6}${s7}</body></html>`;
}
