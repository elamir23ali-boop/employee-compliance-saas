/**
 * Pre-fetch one Keycloak access token per E6 seed tenant and write them to
 * `tools/load-tests/.tokens.json` (gitignored) for the k6 scenarios to `open()`.
 *
 * k6 runs compiled JS in a Go VM -- it has no good way to run the Keycloak
 * ROPC dance for five tenants on every VU without dominating the measurement.
 * Tokens from the e0-test realm are valid long enough (realm default 300s,
 * but this realm ships a longer access-token lifespan -- see realm-export.json)
 * for a single load run; re-run this script if a run 401s midway.
 *
 *   npm run loadtest:tokens
 *
 * Uses the same Direct Access Grant as tests/support/keycloak-client.ts and the
 * seed users provisioned by `npm run seed:users` (ADR-035). No realm change.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TENANTS, SEED_KC_USERS, SEED_KC_PASSWORD } from '../../seed/config';

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env.local');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

interface TokenEntry {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  username: string;
  accessToken: string;
}

async function tokenFor(username: string): Promise<string> {
  const issuer = process.env.KEYCLOAK_ISSUER;
  const clientId = process.env.KEYCLOAK_CLIENT_ID ?? 'e0-api';
  if (!issuer) throw new Error('KEYCLOAK_ISSUER is not set (expected in .env.local)');

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId,
    username,
    password: SEED_KC_PASSWORD,
  });
  const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 200 || typeof json.access_token !== 'string') {
    throw new Error(`token request failed for ${username}: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function main(): Promise<void> {
  loadEnvLocal();

  const entries: TokenEntry[] = [];
  for (const tenant of TENANTS) {
    const user = SEED_KC_USERS.find((u) => u.tenantSlug === tenant.slug);
    if (!user) throw new Error(`no seed KC user configured for ${tenant.slug}`);
    const accessToken = await tokenFor(user.username);
    entries.push({
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      username: user.username,
      accessToken,
    });
    console.log(`  ${tenant.name.padEnd(12)} <- ${user.username}  (token ${accessToken.length} chars)`);
  }

  const out = path.resolve(__dirname, '..', '.tokens.json');
  fs.writeFileSync(out, JSON.stringify({ issuedAt: new Date().toISOString(), tenants: entries }, null, 2));
  console.log(`\nwrote ${entries.length} tokens -> ${out}`);
}

main().catch((err: unknown) => {
  console.error('fetch-tokens failed:', err);
  process.exitCode = 1;
});
