import type { RunContext } from '../net/context';
import type { RobotsDecision } from '../types';
import { assessValidity } from '../validity/validity';
import { evaluateRobots, parseRobots, unknownDecision, ROBOTS_MAX_BYTES, type ParsedRobots } from './parser';
import { pathAndQuery } from '../util/url';

export interface RobotsState {
  origin: string;
  url: string;
  final_url: string | null;
  status: number | null;
  state: 'PARSED' | 'NO_RESTRICTIONS_4XX' | 'UNREACHABLE' | 'SERVER_ERROR' | 'CHALLENGED' | 'RATE_LIMITED' | 'NOT_FETCHED';
  note: string;
  parsed: ParsedRobots | null;
  text: string | null;
  bytes: number;
  body_ref: string | null;
  fetched_at: string;
}

/**
 * robots.txt is fetched before normal page discovery and interpreted with robots-specific status handling
 * (never ordinary page-status handling): 4xx other than 429 means no crawl restrictions; 429, 5xx, challenges
 * and network failures leave access unknown.
 */
export class RobotsService {
  private states = new Map<string, Promise<RobotsState>>();
  private resolved = new Map<string, RobotsState>();
  constructor(private ctx: RunContext) {}

  load(origin: string): Promise<RobotsState> {
    let p = this.states.get(origin);
    if (!p) {
      p = this.fetch(origin).then((s) => {
        this.resolved.set(origin, s);
        return s;
      });
      this.states.set(origin, p);
    }
    return p;
  }

  peek(origin: string): RobotsState | null {
    return this.resolved.get(origin) ?? null;
  }

  private async fetch(origin: string): Promise<RobotsState> {
    const url = `${origin}/robots.txt`;
    const safe = origin.replace(/[^a-z0-9]+/gi, '_');
    const res = await this.ctx.fetchRaw(url, { purpose: 'robots.txt', maxBytes: ROBOTS_MAX_BYTES + 4096, accept: 'text/plain,*/*;q=0.5', storeAs: `robots-${safe}.txt` });
    const r = res.record;
    const base = { origin, url, final_url: r.final_url, status: r.status, parsed: null as ParsedRobots | null, text: res.text, bytes: r.bytes, body_ref: r.body_ref, fetched_at: r.fetched_at };
    if (r.acquisition !== 'OK' || r.status === null) {
      return { ...base, state: 'UNREACHABLE', note: `robots.txt could not be retrieved by this auditor (${r.acquisition}${r.error ? `: ${r.error}` : ''}). Crawl permissions are unknown.` };
    }
    const v = assessValidity({ status: r.status, headers: r.headers, html: res.text, bodyComplete: r.body_complete || r.bytes > 0, truncatedReason: r.truncated_reason, contentType: r.content_type, expectHtml: false });
    if (v.validity === 'ACCESS_CHALLENGE') {
      return { ...base, state: 'CHALLENGED', note: `robots.txt returned an access challenge to this auditor (${v.evidence.join('; ')}). Crawl permissions are unknown; this does not show what vendor crawlers receive.` };
    }
    if (r.status === 429) return { ...base, state: 'RATE_LIMITED', note: 'robots.txt returned HTTP 429. Crawl permissions are unknown for this run.' };
    if (r.status >= 500) {
      return { ...base, state: 'SERVER_ERROR', note: `robots.txt returned HTTP ${r.status}. Google stops crawling the site for a period when robots.txt returns a server error, then falls back to a cached copy if it has one.` };
    }
    if (r.status >= 400) {
      return { ...base, state: 'NO_RESTRICTIONS_4XX', note: `robots.txt returned HTTP ${r.status}. Google treats a 4xx response other than 429 as "no robots.txt": crawling is not restricted.` };
    }
    if (r.status >= 300) {
      return { ...base, state: 'NO_RESTRICTIONS_4XX', note: `robots.txt ended on HTTP ${r.status} without a usable target; treated as not found (no crawl restrictions).` };
    }
    const parsed = parseRobots(res.text ?? '');
    let note = `robots.txt returned HTTP 200 (${r.bytes} bytes, ${parsed.groups.length} group${parsed.groups.length === 1 ? '' : 's'}).`;
    if (!(res.text ?? '').trim()) note = 'robots.txt returned HTTP 200 with an empty body; crawling is not restricted.';
    else if (/^\s*<(!doctype|html)/i.test(res.text ?? '')) note = 'An HTML document is served at /robots.txt. It contains no valid robots directives, so crawling is not restricted.';
    if (parsed.size_limited) note += ' Content beyond the 500 KiB limit was ignored, as Google does.';
    return { ...base, state: 'PARSED', parsed, note };
  }

  decideWith(state: RobotsState | null, token: string, url: string): RobotsDecision {
    if (!state) return unknownDecision(token, 'robots.txt was not fetched for this origin.');
    if (state.state === 'PARSED' && state.parsed) return evaluateRobots(state.parsed, token, pathAndQuery(url));
    if (state.state === 'NO_RESTRICTIONS_4XX') {
      return { token, decision: 'ALLOW', matched_group: null, matched_rule: null, reason: `robots.txt returned HTTP ${state.status}; treated as no crawl restrictions.` };
    }
    return unknownDecision(token, state.note);
  }

  async decide(url: string, token: string): Promise<RobotsDecision> {
    const state = await this.load(new URL(url).origin);
    return this.decideWith(state, token, url);
  }

  /** Gate for the auditor's own fetches. Unknown is treated as "do not fetch". */
  async auditorMayFetch(url: string): Promise<boolean> {
    if (new URL(url).pathname === '/robots.txt') return true;
    const d = await this.decide(url, this.ctx.cfg.auditor.token);
    return d.decision === 'ALLOW';
  }
}
