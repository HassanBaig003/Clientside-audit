import http from 'node:http';
import net from 'node:net';
import type { RunContext } from './context';

export interface GuardProxy {
  port: number;
  blocked: { target: string; reason: string }[];
  close(): Promise<void>;
}

/**
 * Forward proxy that the rendering browser is forced through. Chromium never resolves or connects by itself:
 * every subrequest (documents, scripts, XHR, redirects) is resolved and validated by the same DestinationGuard as
 * RAW fetches, and the tunnel is opened to the validated address. This closes private-network, metadata-address
 * and DNS-rebinding paths for browser traffic.
 */
export async function startGuardProxy(ctx: RunContext): Promise<GuardProxy> {
  const blocked: GuardProxy['blocked'] = [];
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxy request with an absolute URI.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      if (ctx.blocked()) throw new Error('run stopped');
      const dest = await ctx.guard.resolve(target.protocol, target.hostname, target.port ? Number(target.port) : null);
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      headers.host = target.host;
      const upstream = http.request({ host: dest.address, port: dest.port, method: req.method, path: target.pathname + target.search, headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.setTimeout(ctx.budgets.read_timeout_ms, () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (e: any) {
      blocked.push({ target: target.toString(), reason: String(e?.message ?? e) });
      res.writeHead(403, { 'x-audit-guard': 'blocked' }).end();
    }
  });

  server.on('connect', async (req, client: net.Socket, head) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    const [host, portStr] = splitHostPort(req.url ?? '');
    try {
      if (ctx.blocked()) throw new Error('run stopped');
      const dest = await ctx.guard.resolve('https:', host, portStr ? Number(portStr) : 443);
      const upstream = net.connect({ host: dest.address, port: dest.port });
      sockets.add(upstream);
      upstream.setTimeout(ctx.budgets.read_timeout_ms + ctx.budgets.render_timeout_ms, () => upstream.destroy());
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch (e: any) {
      blocked.push({ target: req.url ?? '', reason: String(e?.message ?? e) });
      client.end('HTTP/1.1 403 Forbidden\r\nx-audit-guard: blocked\r\n\r\n');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function splitHostPort(authority: string): [string, string | null] {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:]+)(?::(\d+))?$/.exec(authority);
  return m ? [m[1], m[2] ?? null] : [authority, null];
}
