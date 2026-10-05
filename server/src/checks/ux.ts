import type { Env, PageWork } from './engine';
import { bestExtract, contentGate, describeProfile, renValid } from './engine';
import { truncate } from '../util/url';
import type { Finding } from '../types';

export async function checkUxPage(env: Env, p: PageWork) {
  const { rec } = env;
  const id = p.rec.page_id;
  const gate = contentGate(p);
  const best = bestExtract(p);
  const skip = (cid: string) => (gate!.status === 'NOT_APPLICABLE' ? rec.na(cid, id, gate!.reason) : rec.untestable(cid, id, gate!.reason));
  const rr = p.rendered.record;
  const noRender = `RENDERED profile unavailable (${describeProfile(rr)}); this check needs a genuine rendered page.`;

  // U-7.1 viewport meta ------------------------------------------------------------------------------------------
  await rec.guard('U-7.1', id, () => {
    if (gate || !best) return skip('U-7.1');
    const v = best.ex.viewport_meta;
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'meta[name=viewport]', observed: v ?? '(absent)', expected: 'width=device-width, initial-scale=1' });
    const findings: Finding[] = [];
    if (!v) {
      findings.push(rec.finding({
        check_id: 'U-7.1', status: 'FAIL', reason_code: 'VIEWPORT_META_MISSING', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'No mobile viewport meta tag', explanation: 'The page has no meta viewport tag, so mobile browsers lay it out at desktop width and scale it down.',
        impact: 'Text and controls are small on phones, which hurts usability on the device type Google primarily crawls with.', action: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', owner: 'Developer', effort: 'S',
      }));
    } else {
      const noZoom = /user-scalable\s*=\s*(no|0)/i.test(v) || /maximum-scale\s*=\s*1(\.0)?(\s|,|$)/i.test(v);
      if (!/width\s*=\s*device-width/i.test(v)) {
        findings.push(rec.finding({
          check_id: 'U-7.1', status: 'WARN', reason_code: 'VIEWPORT_NOT_DEVICE_WIDTH', severity: 'LOW', pages: [id], evidence: [ev],
          title: 'Viewport is not set to device width', explanation: `The viewport value is "${truncate(v, 100)}", without width=device-width.`,
          impact: 'The layout may not adapt to the phone screen.', action: 'Use width=device-width, initial-scale=1.', owner: 'Developer', effort: 'S',
        }));
      } else if (noZoom) {
        findings.push(rec.finding({
          check_id: 'U-7.1', status: 'WARN', reason_code: 'VIEWPORT_ZOOM_DISABLED', severity: 'LOW', pages: [id], evidence: [ev], sources: ['SRC-WEBDEV-VIEWPORT', 'SRC-W3C-STRUCT'],
          title: 'Pinch-zoom is disabled', explanation: `The viewport value "${truncate(v, 100)}" prevents users from zooming.`,
          impact: 'People with low vision cannot enlarge the page.', action: 'Remove user-scalable=no and maximum-scale=1.', owner: 'Developer', effort: 'S',
        }));
      }
    }
    rec.result({ check_id: 'U-7.1', page_id: id, evidence: [ev], findings });
  });

  // U-7.2 viewport overflow ----------------------------------------------------------------------------------------
  await rec.guard('U-7.2', id, () => {
    if (gate) return skip('U-7.2');
    if (!renValid(p) || !rr.overflow) return rec.untestable('U-7.2', id, noRender);
    const o = rr.overflow;
    const ev = rec.ev({ url: rr.final_url ?? p.rec.url, profile: 'RENDERED', locator: 'document scroll width at 412 px viewport', observed: `scrollWidth ${o.scroll_width}px in a ${o.viewport_width}px viewport${o.offenders.length ? `; widest offenders: ${o.offenders.map((x) => `${x.selector} (right edge ${x.right}px)`).join(', ')}` : ''}`, expected: `scrollWidth <= ${o.viewport_width}px`, screenshot_ref: rr.screenshot_ref, at: rr.rendered_at });
    if (o.scroll_width <= o.viewport_width + 2) return rec.result({ check_id: 'U-7.2', page_id: id, evidence: [ev] });
    if (!o.offenders.length) return rec.untestable('U-7.2', id, 'The document is wider than the viewport, but no offending element could be identified, so the overflow is not reported as a confirmed finding.', [ev]);
    rec.result({
      check_id: 'U-7.2', page_id: id, evidence: [ev],
      findings: [rec.finding({
        check_id: 'U-7.2', status: 'WARN', reason_code: 'HORIZONTAL_OVERFLOW', severity: 'MEDIUM', pages: [id], evidence: [ev],
        title: 'Content overflows the mobile viewport', explanation: `At a 412 px wide viewport the page is ${o.scroll_width}px wide. The widest overflowing element is ${o.offenders[0].selector}.`,
        impact: 'Mobile users must scroll sideways and may miss content.', action: 'Constrain the listed elements (max-width: 100%, wrapping or overflow handling).', owner: 'Developer', effort: 'S',
      })],
    });
  });

  // U-7.3 automated accessibility ---------------------------------------------------------------------------------------
  await rec.guard('U-7.3', id, () => {
    if (gate) return skip('U-7.3');
    if (!renValid(p)) return rec.untestable('U-7.3', id, noRender);
    if (!rr.axe) return rec.untestable('U-7.3', id, 'The automated accessibility checker could not run on this page.');
    const a = rr.axe;
    const url = rr.final_url ?? p.rec.url;
    const scope = `Scope: ${a.rules_run.length} automated axe-core rules (${a.rules_run.join(', ')}). This is not a WCAG conformance assessment.`;
    const notes = [scope];
    if (a.incomplete.length) notes.push(`Manual review suggested (not confirmed failures): ${a.incomplete.map((i) => `${i.id} x${i.count}`).join(', ')}.`);
    if (!a.violations.length) {
      const ev = rec.ev({ url, profile: 'RENDERED', locator: 'axe-core bounded rule set', observed: `0 violations across ${a.rules_run.length} rules`, at: rr.rendered_at });
      return rec.result({ check_id: 'U-7.3', page_id: id, evidence: [ev], notes });
    }
    const findings = a.violations.map((v) => {
      const ev = rec.ev({ url, profile: 'RENDERED', locator: `axe-core rule ${v.id}`, observed: `${v.nodes.length} element(s): ${v.nodes.slice(0, 3).map((n) => `${n.target} :: ${n.html}`).join(' || ')}`, expected: v.help, at: rr.rendered_at });
      return rec.finding({
        check_id: 'U-7.3', status: 'WARN', reason_code: `A11Y_${v.id.toUpperCase().replace(/-/g, '_')}`, severity: 'MEDIUM', pages: [id], evidence: [ev],
        sources: v.id.includes('image') || v.id.includes('alt') ? ['SRC-W3C-IMG'] : v.id === 'label' || v.id === 'select-name' ? ['SRC-W3C-LABELS'] : ['SRC-W3C-STRUCT', 'SRC-W3C-LABELS'],
        title: v.help, explanation: `Automated check "${v.id}" found ${v.nodes.length} element(s) on this page, for example ${v.nodes[0]?.target ?? 'n/a'}. Images marked decorative (empty alt) are not counted.`,
        impact: 'People using assistive technology cannot identify or operate these elements.', action: `${v.help}. Reference: ${v.help_url}`, owner: 'Developer', effort: 'S',
      });
    });
    rec.result({ check_id: 'U-7.3', page_id: id, evidence: [], findings, notes });
  });

  // U-7.4 landmarks and headings (advisory, unscored) ----------------------------------------------------------------------
  await rec.guard('U-7.4', id, () => {
    if (gate || !best) return skip('U-7.4');
    const ev = rec.ev({ url: best.url, profile: best.profile, locator: 'landmark elements and heading outline', observed: `landmarks: ${best.ex.landmarks.join(', ') || '(none)'}; headings: ${best.ex.headings.slice(0, 8).map((h) => `h${h.level}`).join(' ') || '(none)'}` });
    const notes: string[] = [];
    if (!best.ex.landmarks.includes('main')) notes.push('No <main> landmark. Advisory only: a div-based layout is not an SEO failure, but a main landmark helps assistive technology and content extraction.');
    rec.result({ check_id: 'U-7.4', page_id: id, evidence: [ev], notes });
  });

  // T-8.2 mixed content ---------------------------------------------------------------------------------------------------
  await rec.guard('T-8.2', id, () => {
    if (gate) return skip('T-8.2');
    if (!renValid(p)) return rec.untestable('T-8.2', id, noRender);
    const url = rr.final_url ?? p.rec.url;
    if (!url.startsWith('https:')) return rec.na('T-8.2', id, 'The page is served over HTTP, so mixed content does not apply; see T-8.1.');
    const m = rr.mixed_content;
    const ev = rec.ev({ url, profile: 'RENDERED', locator: 'http:// subresource references in the rendered DOM', observed: m.length ? m.map((x) => `${x.resource_type}: ${x.url}`).join(' ; ') : '0 insecure script, stylesheet, iframe, image or media references', expected: 'all subresources over HTTPS', at: rr.rendered_at });
    if (!m.length) return rec.result({ check_id: 'T-8.2', page_id: id, evidence: [ev] });
    const active = m.some((x) => x.blocked);
    rec.result({
      check_id: 'T-8.2', page_id: id, evidence: [ev],
      findings: [rec.finding({
        check_id: 'T-8.2', status: 'WARN', reason_code: active ? 'MIXED_ACTIVE_CONTENT' : 'MIXED_PASSIVE_CONTENT', severity: active ? 'HIGH' : 'MEDIUM', pages: [id], evidence: [ev],
        title: 'HTTPS page references HTTP resources', explanation: `${m.length} subresource reference(s) use http:// on an HTTPS page. ${active ? 'Scripts, stylesheets and iframes loaded this way are blocked by browsers.' : 'Browsers upgrade or block insecure images and media.'}`,
        impact: active ? 'Blocked scripts or styles can break page function or layout.' : 'Images or media may fail to load, and the page loses its secure indicator in some browsers.', action: 'Reference these resources over HTTPS.', owner: 'Developer', effort: 'S',
      })],
    });
  });
}

export async function checkTransportSite(env: Env) {
  const { rec, audit } = env;

  // T-8.1 HTTPS / TLS -----------------------------------------------------------------------------------------------------
  await rec.guard('T-8.1', null, () => {
    const rows = audit.site.origins.filter((o) => o.url.startsWith('https:'));
    if (!rows.length) return rec.untestable('T-8.1', null, 'HTTPS origin variants were not tested.');
    const evs = rows.map((o) => rec.ev({ url: o.url, profile: 'RAW', locator: 'HTTPS connection', observed: o.error ?? `TLS handshake completed; HTTP ${o.status}`, expected: 'valid certificate and a response' }));
    const ok = rows.filter((o) => !o.error);
    const tlsBad = rows.filter((o) => /TLS_ERROR/.test(o.error ?? ''));
    const preferred = audit.target.preferred_origin ?? '';
    if (ok.length && preferred.startsWith('https:')) {
      const notes = tlsBad.map((o) => `${o.url}: ${o.error} (a non-preferred variant; observation).`);
      return rec.result({ check_id: 'T-8.1', evidence: evs, notes: [`The preferred origin ${preferred} serves over HTTPS with a certificate this auditor accepted.`, ...notes] });
    }
    if (tlsBad.length) {
      return rec.result({
        check_id: 'T-8.1', evidence: evs,
        findings: [rec.finding({
          check_id: 'T-8.1', status: 'FAIL', reason_code: 'TLS_CERTIFICATE_ERROR', severity: 'HIGH', pages: [], evidence: evs,
          title: 'HTTPS certificate error', explanation: `The HTTPS connection failed certificate validation: ${truncate(tlsBad[0].error ?? '', 160)}.`,
          impact: 'Browsers show a security warning and Google prefers working HTTPS pages as canonical.', action: 'Install a valid certificate covering this hostname and its www/apex variant.', owner: 'Hosting', effort: 'S',
        })],
      });
    }
    if (ok.length && preferred.startsWith('http:')) {
      return rec.result({
        check_id: 'T-8.1', evidence: evs,
        findings: [rec.finding({
          check_id: 'T-8.1', status: 'WARN', reason_code: 'HTTPS_NOT_PREFERRED', severity: 'MEDIUM', pages: [], evidence: evs,
          title: 'HTTPS works but the site resolves to HTTP', explanation: `HTTPS responds, yet the observed preferred origin is ${preferred}.`,
          impact: 'Visitors and crawlers end up on the insecure version.', action: 'Redirect HTTP to HTTPS.', owner: 'Developer / hosting', effort: 'S',
        })],
      });
    }
    if (preferred.startsWith('http:') && rows.every((o) => /NETWORK_ERROR/.test(o.error ?? ''))) {
      return rec.result({
        check_id: 'T-8.1', evidence: evs,
        findings: [rec.finding({
          check_id: 'T-8.1', status: 'FAIL', reason_code: 'NO_HTTPS', severity: 'HIGH', pages: [], evidence: evs,
          title: 'The site is not available over HTTPS', explanation: 'The site answers over HTTP, and HTTPS connections were refused.',
          impact: 'Browsers mark the site as not secure, and Google prefers HTTPS pages.', action: 'Enable HTTPS with a valid certificate and redirect HTTP to it.', owner: 'Hosting', effort: 'M',
        })],
      });
    }
    rec.untestable('T-8.1', null, `HTTPS could not be confirmed by this auditor (${rows.map((o) => o.error).filter(Boolean).join('; ') || 'no response'}).`, evs);
  });

  // T-8.3 security headers (informational) ---------------------------------------------------------------------------------
  await rec.guard('T-8.3', null, () => {
    const home = env.pages.find((p) => p.raw.record.acquisition === 'OK' && p.raw.record.status === 200);
    if (!home) return rec.untestable('T-8.3', null, 'No 200 response was available to read headers from.');
    const h = home.raw.record.headers;
    const names = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options'];
    const ev = rec.ev({ url: home.raw.record.final_url ?? home.rec.url, profile: 'RAW', locator: 'response headers', observed: names.map((n) => `${n}: ${h[n] ? truncate(h[n], 60) : '(absent)'}`).join(' | '), at: home.raw.record.fetched_at });
    const absent = names.filter((n) => !h[n]);
    rec.result({ check_id: 'T-8.3', evidence: [ev], notes: [absent.length ? `Optional hardening headers not present: ${absent.join(', ')}. Informational only: these are not indexing signals, and no penetration test or vulnerability scan was performed.` : 'Common hardening headers are present. No penetration test or vulnerability scan was performed.'] });
  });

  // X-9.1 llms.txt (optional, unscored) ---------------------------------------------------------------------------------------
  await rec.guard('X-9.1', null, () => {
    const l = audit.site.llms_txt;
    if (!l.url || l.state === 'NOT_FETCHED' || l.state === 'UNAVAILABLE' || l.state === 'CHALLENGE') return rec.untestable('X-9.1', null, l.note);
    const ev = rec.ev({ url: l.url, profile: 'RAW', locator: '/llms.txt', observed: `HTTP ${l.status} - ${l.state}${l.excerpt ? ` :: ${l.excerpt}` : ''}` });
    if (l.state === 'PRESENT_TEXT') return rec.result({ check_id: 'X-9.1', evidence: [ev], notes: [l.note, 'Optional signal under a community proposal; excluded from both scores.'] });
    rec.result({ check_id: 'X-9.1', evidence: [ev], status: 'NOT_APPLICABLE', notes: [l.note, 'Optional signal; its absence is not an SEO failure and does not lower any score.'] });
  });
}
