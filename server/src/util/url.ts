import { parse as parseDomain } from 'tldts';

export class InputError extends Error {}

/**
 * Parse an operator-supplied URL with the WHATWG parser.
 * Path case, query, trailing slash and a meaningful port are preserved; only the fragment is dropped.
 */
export function parseTargetUrl(input: string): URL {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new InputError('A website URL is required.');
  if (/\s/.test(trimmed)) throw new InputError('The URL must not contain spaces.');
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[^/:]+:\d+(\/|$)/.test(trimmed);
  let u: URL;
  try {
    u = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    throw new InputError('That is not a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InputError('Only http:// and https:// URLs can be audited.');
  if (u.username || u.password) throw new InputError('URLs containing credentials are not accepted.');
  if (!u.hostname || !u.hostname.includes('.') && !isIpLiteral(u.hostname)) throw new InputError('The URL needs a public hostname.');
  u.hash = '';
  return u;
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

/** Dedup key for fetching: fragment removed, everything else exactly as the URL parser serialises it. */
export function fetchKey(url: string | URL): string {
  const u = new URL(url.toString());
  u.hash = '';
  return u.toString();
}

export function tryUrl(href: string, base?: string | URL): URL | null {
  try {
    return base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
}

/** Registrable domain using the public suffix list. Never guessed by stripping labels. */
export function registrableDomain(host: string): string | null {
  const p = parseDomain(host, { allowPrivateDomains: true });
  return p.domain ?? null;
}

/** Returns the apex/www pair for a host, or null when the host is a distinct subdomain or an IP. */
export function apexWwwPair(host: string): { apex: string; www: string } | null {
  const h = host.toLowerCase();
  const reg = registrableDomain(h);
  if (!reg) return null;
  if (h === reg) return { apex: reg, www: `www.${reg}` };
  if (h === `www.${reg}`) return { apex: reg, www: h };
  return null;
}

/** True when two hosts are the same host or an apex/www alias pair of one registrable domain. */
export function isAliasHost(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const pair = apexWwwPair(x);
  return !!pair && (pair.apex === y || pair.www === y);
}

export function originOf(url: string | URL): string {
  return new URL(url.toString()).origin;
}

export function pathAndQuery(url: string | URL): string {
  const u = new URL(url.toString());
  return u.pathname + u.search;
}

/** Compare two URLs for "same resource" purposes without lowercasing paths or stripping queries. */
export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return fetchKey(a) === fetchKey(b);
  } catch {
    return false;
  }
}

export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
