import { loadConfig } from './config';
import { buildApp } from './api/server';

async function main() {
  const cfg = loadConfig();
  if (!cfg.authTokens.size) {
    console.error('AUDIT_API_TOKENS is not set. Configure at least one "token:tenant_id" pair; the app refuses to start without access control.');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET) console.warn('[audit] SESSION_SECRET is not set; sessions will not survive a restart.');
  if (!cfg.auditor.contactUrl) console.warn('[audit] AUDITOR_CONTACT_URL is not set; the auditor user agent carries no contact URL.');
  if (cfg.fixture.enabled) console.warn(`[audit] FIXTURE_MODE is on: hosts ending in ${cfg.fixture.hostSuffix} route to local fixtures and are stamped FIXTURE / DEMO.`);
  const { fastify } = await buildApp(cfg);
  await fastify.listen({ host: cfg.host, port: cfg.port });
  console.log(`[audit] listening on http://${cfg.host}:${cfg.port}`);
  const stop = async () => {
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
