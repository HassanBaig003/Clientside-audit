import type { RunContext, RawResult } from './context';
import { BrowserSession, type RenderResult } from './browser';
import { RobotsService } from '../robots/service';
import { assessValidity } from '../validity/validity';
import { fetchKey } from '../util/url';

/** One place that applies the robots gate, response validity gate and caching to RAW and RENDERED acquisition. */
export class Acquirer {
  readonly robots: RobotsService;
  readonly browser: BrowserSession;
  private renders = new Map<string, Promise<RenderResult>>();
  private retried = new Set<string>();

  constructor(readonly ctx: RunContext) {
    this.robots = new RobotsService(ctx);
    this.browser = new BrowserSession(ctx);
  }

  async raw(url: string, purpose: string, storeAs: string | null = null, opts: { expectHtml?: boolean; ungated?: boolean } = {}): Promise<RawResult> {
    const gate = opts.ungated ? undefined : (u: string) => this.robots.auditorMayFetch(u);
    let res = await this.ctx.fetchRaw(url, { purpose, gate, storeAs });
    this.assess(res, opts.expectHtml !== false);
    // A challenge gets exactly one retry inside the run budget before it is treated as persistent.
    if (res.record.validity === 'ACCESS_CHALLENGE' && !res.record.from_cache && !this.retried.has(fetchKey(url))) {
      this.retried.add(fetchKey(url));
      const again = await this.ctx.fetchRaw(url, { purpose: `${purpose} (challenge retry)`, gate, storeAs, bypassCache: true });
      this.assess(again, opts.expectHtml !== false);
      res = again;
      if (res.record.validity === 'ACCESS_CHALLENGE') {
        res.record.validity_evidence.unshift('ACCESS_CHALLENGE_DETECTED (persisted after one retry)');
        this.ctx.noteChallenge(url);
      }
    }
    return res;
  }

  private assess(res: RawResult, expectHtml: boolean) {
    const r = res.record;
    if (r.validity !== null || r.acquisition !== 'OK') return;
    const v = assessValidity({ status: r.status, headers: r.headers, html: res.text, bodyComplete: r.body_complete, truncatedReason: r.truncated_reason, contentType: r.content_type, expectHtml, rawSource: true });
    r.validity = v.validity;
    r.validity_evidence = v.evidence;
  }

  render(url: string, assetPrefix: string): Promise<RenderResult> {
    const key = fetchKey(url);
    let p = this.renders.get(key);
    if (!p) {
      p = (async () => {
        if (!(await this.robots.auditorMayFetch(url))) {
          return {
            dom: null,
            record: {
              profile: 'RENDERED', requested_url: url, final_url: null, status: null, headers: {}, timing_ms: 0, rendered_at: new Date().toISOString(),
              acquisition: 'ROBOTS_DISALLOWED_FOR_AUDITOR', error: 'robots.txt does not allow this auditor to fetch the URL; it was not rendered.', validity: null,
              validity_evidence: [], dom_ref: null, screenshot_ref: null, viewport: { width: 412, height: 915 }, console_errors: [], failed_requests: [],
              mixed_content: [], resource_count: 0, resource_bytes: 0, resource_cap_hit: false, overflow: null, axe: null, settle: 'not-started',
            },
          } as RenderResult;
        }
        const out = await this.browser.render(url, assetPrefix);
        if (out.record.validity === 'ACCESS_CHALLENGE') out.record.validity_evidence.unshift('ACCESS_CHALLENGE_DETECTED');
        return out;
      })();
      this.renders.set(key, p);
    }
    return p;
  }

  async close() {
    await this.browser.close();
  }
}
