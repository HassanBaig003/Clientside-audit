import type { RobotsDecision } from '../types';

/**
 * robots.txt parsing and matching per RFC 9309 and Google's documented behaviour:
 * most specific user-agent group, equally specific groups merged, longest path match,
 * allow wins a tie, `*` and `$` supported, 500 KiB size limit.
 */
export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
  line: number;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}
export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  unsupported_fields: string[];
  size_limited: boolean;
}

export const ROBOTS_MAX_BYTES = 500 * 1024;

export function parseRobots(input: string): ParsedRobots {
  let text = input.replace(/^﻿/, '');
  let sizeLimited = false;
  if (Buffer.byteLength(text) > ROBOTS_MAX_BYTES) {
    text = Buffer.from(text).subarray(0, ROBOTS_MAX_BYTES).toString();
    sizeLimited = true;
  }
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const unsupported = new Set<string>();
  let current: RobotsGroup | null = null;
  let sawRule = false;

  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const sep = line.indexOf(':');
    if (sep < 1) return;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === 'user-agent') {
      if (!current || sawRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      const token = productToken(value);
      if (token) current.agents.push(token);
    } else if (key === 'allow' || key === 'disallow') {
      sawRule = true;
      if (current) current.rules.push({ type: key, path: value, line: idx + 1 });
    } else if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else {
      // crawl-delay, host, noindex, clean-param, content-signal ... are not supported by Google and are never
      // treated as indexing directives here.
      unsupported.add(key);
    }
  });
  return { groups, sitemaps, unsupported_fields: [...unsupported], size_limited: sizeLimited };
}

function productToken(value: string): string {
  const v = value.trim();
  if (v === '*') return '*';
  const m = /^[a-zA-Z_-]+/.exec(v);
  return (m ? m[0] : v).toLowerCase();
}

/** Percent-encode consistently so `/caf%C3%A9` and `/café` compare equal, without touching `*`/`$` semantics. */
function normalise(path: string): string {
  let out = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(path.slice(i + 1, i + 3))) {
      out += `%${path.slice(i + 1, i + 3).toUpperCase()}`;
      i += 2;
    } else if (ch.charCodeAt(0) > 127) {
      out += encodeURIComponent(ch);
    } else out += ch;
  }
  return out;
}

export function ruleMatches(pattern: string, path: string): boolean {
  const p = normalise(pattern);
  const target = normalise(path);
  const anchored = p.endsWith('$');
  const body = anchored ? p.slice(0, -1) : p;
  const parts = body.split('*');
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      if (!target.startsWith(part)) return false;
      pos = part.length;
    } else if (i === parts.length - 1 && anchored) {
      const at = target.lastIndexOf(part);
      if (part === '') return true;
      if (at < pos || at + part.length !== target.length) return false;
      pos = target.length;
    } else {
      const at = target.indexOf(part, pos);
      if (at < 0) return false;
      pos = at + part.length;
    }
  }
  if (anchored && parts.length === 1) return target.length === body.length;
  return true;
}

export function evaluateRobots(parsed: ParsedRobots, token: string, pathAndQuery: string): RobotsDecision {
  const t = token.toLowerCase();
  const path = pathAndQuery || '/';
  if (path === '/robots.txt') {
    return { token, decision: 'ALLOW', matched_group: null, matched_rule: null, reason: '/robots.txt is always fetchable.' };
  }
  let matching = parsed.groups.filter((g) => g.agents.includes(t));
  let groupLabel = token;
  if (!matching.length) {
    matching = parsed.groups.filter((g) => g.agents.includes('*'));
    groupLabel = '*';
  }
  if (!matching.length) {
    return { token, decision: 'ALLOW', matched_group: null, matched_rule: null, reason: 'No group applies to this crawler; crawling is not restricted.' };
  }
  const rules = matching.flatMap((g) => g.rules).filter((r) => r.path !== '');
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow' && best.type === 'disallow')) {
      best = r;
    }
  }
  if (!best) {
    return { token, decision: 'ALLOW', matched_group: groupLabel, matched_rule: null, reason: `Group "${groupLabel}" has no rule matching this path.` };
  }
  return {
    token,
    decision: best.type === 'allow' ? 'ALLOW' : 'DISALLOW',
    matched_group: groupLabel,
    matched_rule: `${best.type === 'allow' ? 'Allow' : 'Disallow'}: ${best.path} (line ${best.line})`,
    reason: `Longest matching rule in group "${groupLabel}".`,
  };
}

export function unknownDecision(token: string, reason: string): RobotsDecision {
  return { token, decision: 'UNKNOWN', matched_group: null, matched_rule: null, reason };
}
