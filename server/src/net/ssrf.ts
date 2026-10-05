import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import type { AppConfig } from '../config';

export class UnsafeDestinationError extends Error {
  code = 'UNSAFE_DESTINATION';
}

/** Only globally routable unicast addresses are acceptable destinations. */
export function isPublicAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip.replace(/^\[|\]$/g, '')); // unwraps IPv4-mapped IPv6
  } catch {
    return false;
  }
  // Anything that is not plain unicast is rejected: private, loopback, link-local (cloud metadata),
  // CGNAT, unique-local, NAT64/6to4/Teredo translation prefixes, multicast, reserved, unspecified.
  return addr.range() === 'unicast';
}

export interface Destination {
  address: string;
  family: 4 | 6;
  port: number;
  insecureTls: boolean;
  fixture: boolean;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Single choke point for every outbound connection the auditor makes: the initial target,
 * each redirect hop, canonical/hreflang targets and every browser subrequest (via the guard proxy).
 * The returned address is the one that gets connected to, so a later DNS answer cannot rebind it.
 */
export class DestinationGuard {
  private extraPorts = new Set<number>();
  constructor(private cfg: AppConfig, private resolver: Resolver = systemResolver) {}

  /** The operator-supplied target may carry a meaningful non-default port; it is authorised explicitly. */
  authorisePort(port: number) {
    if (port > 0 && port < 65536) this.extraPorts.add(port);
  }

  isFixtureHost(hostname: string): boolean {
    const f = this.cfg.fixture;
    return f.enabled && hostname.toLowerCase().endsWith(f.hostSuffix);
  }

  async resolve(protocol: string, hostname: string, port: number | null): Promise<Destination> {
    if (protocol !== 'http:' && protocol !== 'https:') throw new UnsafeDestinationError(`Unsupported scheme ${protocol}`);
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const effectivePort = port ?? (protocol === 'https:' ? 443 : 80);

    if (this.isFixtureHost(host)) {
      if (effectivePort !== 80 && effectivePort !== 443) throw new UnsafeDestinationError(`Port ${effectivePort} is not authorised`);
      const f = this.cfg.fixture;
      return { address: f.address, family: 4, port: protocol === 'https:' ? f.httpsPort : f.httpPort, insecureTls: true, fixture: true };
    }

    if (!this.cfg.allowedPorts.includes(effectivePort) && !this.extraPorts.has(effectivePort)) {
      throw new UnsafeDestinationError(`Port ${effectivePort} is not authorised`);
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new UnsafeDestinationError(`Host ${host} is not a public destination`);
    }
    if (ipaddr.isValid(host)) {
      if (!isPublicAddress(host)) throw new UnsafeDestinationError(`Address ${host} is not a public destination`);
      const fam = ipaddr.parse(host).kind() === 'ipv6' ? 6 : 4;
      return { address: host, family: fam, port: effectivePort, insecureTls: false, fixture: false };
    }
    let answers: { address: string; family: number }[];
    try {
      answers = await this.resolver(host);
    } catch (e: any) {
      const err: any = new Error(`DNS resolution failed for ${host}: ${e?.code ?? e?.message ?? e}`);
      err.code = 'DNS_ERROR';
      throw err;
    }
    if (!answers.length) {
      const err: any = new Error(`DNS returned no addresses for ${host}`);
      err.code = 'DNS_ERROR';
      throw err;
    }
    // If any answer is non-public the whole name is refused; a mixed answer set is the rebinding pattern.
    const bad = answers.find((a) => !isPublicAddress(a.address));
    if (bad) throw new UnsafeDestinationError(`Host ${host} resolves to a non-public address (${bad.address})`);
    const pick = answers.find((a) => a.family === 4) ?? answers[0];
    return { address: pick.address, family: pick.family === 6 ? 6 : 4, port: effectivePort, insecureTls: false, fixture: false };
  }
}
