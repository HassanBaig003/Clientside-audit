import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { AppConfig } from '../config';
import { auditorUserAgent } from '../config';
import type { AcquisitionState, Budgets, RawRecord, RedirectHop } from '../types';
import { DestinationGuard, UnsafeDestinationError, type Destination, type Resolver } from './ssrf';
import { fetchKey } from '../util/url';

export interface BlobStore {
  put(name: string, data: Buffer | string): string;
  get(ref: string): Buffer | null;
}

export class MemoryBlobStore implements BlobStore {
  map = new Map<string, Buffer>();
  put(name: string, data: Buffer | string) {
    this.map.set(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return name;
  }
  get(ref: string) {
    return this.map.get(ref) ?? null;
  }
}

export interface RawResult {
  record: RawRecord;
  body: Buffer | null;
  text: string | null;
}

export interface FetchOptions {
  /** Purpose label for budget accounting and limitation messages. */
  purpose: string;
  /** Return false to refuse a URL (robots gate for the auditor). Applied to every hop. */
  gate?: (url: string) => boolean | Promise<boolean>;
  maxBytes?: number;
  accept?: string;
  storeAs?: string | null;
  bypassCache?: boolean;
}

interface HostState {
  active: number;
  lastStart: number;
  queue: (() => void)[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Per-run network context: destination guard, cache, per-host pacing, budgets, cancellation and stop conditions.
 * Every cap that prevents work is written to `limitations` so nothing is silently omitted.
 */
export class RunContext {
  readonly guard: DestinationGuard;
  readonly cache = new Map<string, RawResult>();
  readonly limitations = new Set<string>();
  readonly counters: Record<string, number> = {
    raw_requests: 0,
    cache_hits: 0,
    renders: 0,
    discovery_documents: 0,
    rate_limited_responses: 0,
    access_challenges: 0,
    internal_link_targets: 0,
    canonical_target_fetches: 0,
    hreflang_alternate_fetches: 0,
    lab_runs: 0,
    crux_requests: 0,
    llm_calls: 0,
  };
  readonly startedAt = Date.now();
  readonly deadline: number;
  stopReason: 'STOPPED_RATE_LIMITED' | 'STOPPED_ACCESS_CHALLENGES' | 'BUDGET_EXHAUSTED' | 'CANCELLED' | null = null;
  private hosts = new Map<string, HostState>();
  private challengeUrls = new Set<string>();
  private abort = new AbortController();

  constructor(
    readonly cfg: AppConfig,
    readonly budgets: Budgets,
    readonly blobs: BlobStore,
    resolver?: Resolver,
  ) {
    this.guard = new DestinationGuard(cfg, resolver);
    this.deadline = this.startedAt + budgets.run_hard_budget_seconds * 1000;
  }

  get signal() {
    return this.abort.signal;
  }

  cancel() {
    this.stop('CANCELLED');
    this.abort.abort();
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  stop(reason: NonNullable<RunContext['stopReason']>) {
    if (!this.stopReason) this.stopReason = reason;
  }

  /** Reason new requests may not be issued, or null when the run may continue. */
  blocked(): AcquisitionState | null {
    if (this.stopReason === 'CANCELLED') return 'CANCELLED';
    if (this.stopReason) return this.stopReason;
    if (this.remainingMs() <= 0) {
      this.stop('BUDGET_EXHAUSTED');
      this.limitations.add(`The ${this.budgets.run_hard_budget_seconds}-second run budget was reached; remaining requests were not issued.`);
      return 'BUDGET_EXHAUSTED';
    }
    return null;
  }

  noteChallenge(url: string) {
    this.challengeUrls.add(fetchKey(url));
    this.counters.access_challenges = this.challengeUrls.size;
    if (this.challengeUrls.size >= this.cfg.challengeStopThreshold) {
      this.stop('STOPPED_ACCESS_CHALLENGES');
      this.limitations.add(
        `${this.challengeUrls.size} distinct pages returned a persistent access challenge to this auditor; new requests were stopped. This does not show that Googlebot or other vendor crawlers are challenged.`,
      );
    }
  }

  private async pace(host: string): Promise<() => void> {
    let st = this.hosts.get(host);
    if (!st) this.hosts.set(host, (st = { active: 0, lastStart: 0, queue: [] }));
    const state = st;
    if (state.active >= this.budgets.concurrency_per_host) {
      await new Promise<void>((res) => state.queue.push(res));
    }
    state.active++;
    const wait = state.lastStart + this.budgets.minimum_request_spacing_ms - Date.now();
    state.lastStart = Math.max(Date.now(), state.lastStart + this.budgets.minimum_request_spacing_ms);
    if (wait > 0) await sleep(wait, this.signal);
    return () => {
      state.active--;
      const next = state.queue.shift();
      if (next) next();
    };
  }

  /** RAW profile: plain GET, redirects followed hop by hop with every hop validated. */
  async fetchRaw(url: string, opts: FetchOptions): Promise<RawResult> {
    const key = fetchKey(url);
    if (!opts.bypassCache) {
      const hit = this.cache.get(key);
      if (hit) {
        this.counters.cache_hits++;
        return { ...hit, record: { ...hit.record, from_cache: true } };
      }
    }
    const started = Date.now();
    const base: RawRecord = {
      profile: 'RAW',
      requested_url: key,
      final_url: null,
      hops: [],
      status: null,
      headers: {},
      bytes: 0,
      body_complete: false,
      truncated_reason: null,
      timing_ms: 0,
      fetched_at: new Date().toISOString(),
      acquisition: 'NOT_ATTEMPTED',
      error: null,
      validity: null,
      validity_evidence: [],
      content_type: null,
      body_ref: null,
      from_cache: false,
    };
    const finish = (patch: Partial<RawRecord>, body: Buffer | null = null): RawResult => {
      const record = { ...base, ...patch, timing_ms: Date.now() - started };
      let text: string | null = null;
      if (body) {
        text = decodeBody(body, record.content_type);
        if (opts.storeAs) record.body_ref = this.blobs.put(opts.storeAs, body);
      }
      const result = { record, body, text };
      // Failures caused by run-level stop conditions are not cached, so a bounded retry can try again.
      // A response cut short by a caller-specific byte cap is not cached either, so a later full fetch is not poisoned.
      const cappedByCaller = !!opts.maxBytes && opts.maxBytes < this.budgets.max_document_bytes && !!record.truncated_reason;
      if (!cappedByCaller && !['BUDGET_EXHAUSTED', 'CANCELLED', 'STOPPED_RATE_LIMITED', 'STOPPED_ACCESS_CHALLENGES'].includes(record.acquisition)) {
        this.cache.set(key, result);
        // The final URL of a redirect chain is the same response when requested directly; cache it without the hops.
        const fin = record.final_url;
        if (record.acquisition === 'OK' && record.hops.length && fin && !this.cache.has(fin)) {
          this.cache.set(fin, { record: { ...record, requested_url: fin, hops: [] }, body, text });
        }
      }
      return result;
    };

    const hops: RedirectHop[] = [];
    const seen = new Set<string>();
    let current = key;
    let retriedAfter429 = false;

    for (;;) {
      const stop = this.blocked();
      if (stop) return finish({ acquisition: stop, hops, error: `Request not issued: ${stop}` });
      const u = new URL(current);
      // The destination is validated before anything else happens for this hop, including the robots gate,
      // so an unsafe redirect target is never contacted (not even for its robots.txt).
      let dest: Destination;
      try {
        dest = await this.guard.resolve(u.protocol, u.hostname, u.port ? Number(u.port) : null);
      } catch (e: any) {
        return finish({ acquisition: classifyError(e), hops, final_url: current, error: String(e?.message ?? e) });
      }
      if (opts.gate && !(await opts.gate(current))) {
        return finish({ acquisition: 'ROBOTS_DISALLOWED_FOR_AUDITOR', hops, final_url: current, error: 'robots.txt disallows this URL for the auditor; it was not fetched.' });
      }
      if (seen.has(current)) {
        return finish({ acquisition: 'REDIRECT_LOOP', hops, final_url: current, error: `Redirect loop detected at ${current}` });
      }
      seen.add(current);
      let res: SingleResponse;
      const release = await this.pace(u.host).catch(() => null);
      if (!release) return finish({ acquisition: 'CANCELLED', hops, error: 'Cancelled' });
      const hopStart = Date.now();
      try {
        this.counters.raw_requests++;
        res = await this.single(u, opts, dest);
      } catch (e: any) {
        release();
        return finish({ acquisition: classifyError(e), hops, final_url: current, error: String(e?.message ?? e) });
      }
      release();

      if (res.status === 429) {
        this.counters.rate_limited_responses++;
        const ra = retryAfterMs(res.headers['retry-after']);
        if (!retriedAfter429 && ra !== null && ra <= Math.min(this.remainingMs() - 1000, 20000)) {
          retriedAfter429 = true;
          seen.delete(current);
          await sleep(ra, this.signal).catch(() => undefined);
          continue;
        }
        if (this.counters.rate_limited_responses >= this.cfg.rateLimitStopThreshold) {
          this.stop('STOPPED_RATE_LIMITED');
          this.limitations.add('The site returned repeated HTTP 429 (rate limited) responses; new requests were stopped and the audit is partial.');
        }
      }

      if (REDIRECT_STATUSES.has(res.status) && res.headers.location) {
        let next: URL;
        try {
          next = new URL(res.headers.location, u);
        } catch {
          return finish({ acquisition: 'OK', hops, final_url: current, status: res.status, headers: res.headers, content_type: res.headers['content-type'] ?? null, error: 'Redirect Location header is not a valid URL' }, res.body);
        }
        next.hash = '';
        hops.push({ url: current, status: res.status, location: next.toString(), elapsed_ms: Date.now() - hopStart });
        if (hops.length > this.budgets.max_redirect_hops) {
          this.limitations.add(`A redirect chain exceeded the ${this.budgets.max_redirect_hops}-hop limit and was not followed further.`);
          return finish({ acquisition: 'TOO_MANY_REDIRECTS', hops, final_url: current, error: `More than ${this.budgets.max_redirect_hops} redirect hops` });
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return finish({ acquisition: 'UNSAFE_DESTINATION', hops, final_url: current, error: `Redirect to unsupported scheme ${next.protocol}` });
        }
        current = next.toString();
        continue;
      }

      return finish(
        {
          acquisition: 'OK',
          hops,
          final_url: current,
          status: res.status,
          headers: res.headers,
          bytes: res.body.length,
          body_complete: res.complete,
          truncated_reason: res.truncatedReason,
          content_type: res.headers['content-type'] ?? null,
        },
        res.body,
      );
    }
  }

  private async single(u: URL, opts: FetchOptions, dest: Destination): Promise<SingleResponse> {
    const maxBytes = Math.min(opts.maxBytes ?? this.budgets.max_document_bytes, this.budgets.max_document_bytes);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const readBudget = Math.min(this.budgets.read_timeout_ms, Math.max(1, this.remainingMs()));

    return new Promise<SingleResponse>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(readTimer);
        this.signal.removeEventListener('abort', onAbort);
        fn();
      };
      const req = mod.request({
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: dest.port,
        path: u.pathname + u.search,
        method: 'GET',
        agent: false,
        // Connect to the address the guard validated, not to whatever DNS says at connect time.
        lookup: (_h: string, o: any, cb: any) => (o && o.all ? cb(null, [{ address: dest.address, family: dest.family }]) : cb(null, dest.address, dest.family)),
        servername: isHttps && !/^[\d.]+$|:/.test(u.hostname) ? u.hostname : undefined,
        rejectUnauthorized: !dest.insecureTls,
        headers: {
          Host: u.host,
          'User-Agent': auditorUserAgent(this.cfg),
          Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en',
          Connection: 'close',
        },
      } as https.RequestOptions);

      const fail = (code: string, message: string) => {
        const err: any = new Error(message);
        err.code = code;
        req.destroy();
        done(() => reject(err));
      };
      const connectTimer = setTimeout(() => fail('CONNECT_TIMEOUT', `Connection not established within ${this.budgets.connect_timeout_ms} ms`), this.budgets.connect_timeout_ms);
      const readTimer = setTimeout(() => fail('READ_TIMEOUT', `No complete response within ${readBudget} ms`), readBudget + this.budgets.connect_timeout_ms);
      const onAbort = () => fail('CANCELLED', 'Cancelled');
      this.signal.addEventListener('abort', onAbort);

      req.on('socket', (s) => {
        const ev = isHttps ? 'secureConnect' : 'connect';
        if ((s as any).connecting === false && !isHttps) clearTimeout(connectTimer);
        s.once(ev, () => clearTimeout(connectTimer));
      });
      req.on('error', (e) => done(() => reject(e)));
      req.on('response', (res) => {
        clearTimeout(connectTimer);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        // Keep every Link / X-Robots-Tag value distinct for later parsing.
        const multi = (name: string) => {
          const all = res.headersDistinct?.[name];
          if (all && all.length > 1) headers[name] = all.join('\n');
        };
        multi('link');
        multi('x-robots-tag');

        const enc = (headers['content-encoding'] ?? '').toLowerCase().trim();
        let stream: NodeJS.ReadableStream = res;
        try {
          if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        } catch {
          stream = res;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncatedReason: string | null = null;
        let aborted = false;
        const end = (complete: boolean) =>
          done(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), complete, truncatedReason }));
        res.on('aborted', () => {
          aborted = true;
          truncatedReason = 'The connection closed before the declared response body was complete.';
          end(false);
        });
        res.on('error', () => {
          truncatedReason = truncatedReason ?? 'The response stream failed before completion.';
          end(false);
        });
        stream.on('data', (c: Buffer) => {
          if (settled) return;
          if (size + c.length > maxBytes) {
            chunks.push(c.subarray(0, maxBytes - size));
            size = maxBytes;
            truncatedReason = `Response exceeded the ${maxBytes}-byte document limit and was cut off by the auditor.`;
            req.destroy();
            end(false);
            return;
          }
          size += c.length;
          chunks.push(c);
        });
        stream.on('error', () => {
          truncatedReason = truncatedReason ?? 'The compressed response body could not be decoded completely.';
          end(false);
        });
        stream.on('end', () => {
          if (!aborted) end(true);
        });
      });
      req.end();
    });
  }
}

interface SingleResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  complete: boolean;
  truncatedReason: string | null;
}

function classifyError(e: any): AcquisitionState {
  if (e instanceof UnsafeDestinationError || e?.code === 'UNSAFE_DESTINATION') return 'UNSAFE_DESTINATION';
  const code = String(e?.code ?? '');
  if (code === 'CANCELLED') return 'CANCELLED';
  if (code === 'DNS_ERROR' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_ERROR';
  if (code === 'CONNECT_TIMEOUT' || code === 'READ_TIMEOUT' || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (/CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|EPROTO/i.test(code) || /certificate|self[- ]signed|SSL routines|alert/i.test(String(e?.message ?? ''))) return 'TLS_ERROR';
  return 'NETWORK_ERROR';
}

function retryAfterMs(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function decodeBody(body: Buffer, contentType: string | null): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  if (!charset) {
    const head = body.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  try {
    return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}
