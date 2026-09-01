/**
 * Provision (or remove) runtime Keycloak users for the seed tenants -- ADR-035.
 *
 *   npm run seed:users             # create/repair one hr-manager user per seed tenant
 *   npm run seed:users -- --delete # remove them
 *
 * Uses the Keycloak admin API only (same as tests/support/keycloak-admin.ts):
 * realm-export.json, the e0-api client, and the org_slug protocol mapper are
 * never touched. These users persist across generate/cleanup cycles -- they
 * are cheap and reusable; `npm run cleanup` deliberately does not remove them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SEED_KC_USERS, SEED_KC_PASSWORD, SEED_KC_ROLE } from './config';

const REALM = 'e0-test';

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '..', '.env.local');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

function adminBase(): string {
  const url = process.env.KEYCLOAK_ADMIN_URL;
  if (!url) throw new Error('KEYCLOAK_ADMIN_URL is not set');
  return url;
}

async function getAdminToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: process.env.KEYCLOAK_ADMIN_USER ?? 'admin',
    password: process.env.KEYCLOAK_ADMIN_PASS ?? 'admin',
  });
  const res = await fetch(`${adminBase()}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`admin token request failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

interface Api {
  get: (p: string) => Promise<Response>;
  post: (p: string, b: unknown) => Promise<Response>;
  put: (p: string, b: unknown) => Promise<Response>;
  del: (p: string) => Promise<Response>;
}

function api(token: string): Api {
  const base = `${adminBase()}/admin/realms/${REALM}`;
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  return {
    get: (p) => fetch(base + p, { headers: h }),
    post: (p, b) => fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(b) }),
    put: (p, b) => fetch(base + p, { method: 'PUT', headers: h, body: JSON.stringify(b) }),
    del: (p) => fetch(base + p, { method: 'DELETE', headers: h }),
  };
}

interface UpAttr {
  name: string;
  [k: string]: unknown;
}
interface UpConfig {
  attributes?: UpAttr[];
  [k: string]: unknown;
}

/** Declare (or, on --delete, remove) `org_slug` in the realm's user profile. */
async function ensureOrgSlugAttribute(a: Api, remove: boolean): Promise<void> {
  const res = await a.get('/users/profile');
  if (!res.ok) throw new Error(`get users/profile failed: ${res.status}`);
  const cfg = (await res.json()) as UpConfig;
  const attrs = cfg.attributes ?? [];
  const has = attrs.some((x) => x.name === 'org_slug');

  if (remove) {
    if (!has) {
      console.log('  users/profile: org_slug not declared');
      return;
    }
    cfg.attributes = attrs.filter((x) => x.name !== 'org_slug');
  } else {
    if (has) {
      console.log('  users/profile: org_slug already declared');
      return;
    }
    cfg.attributes = [
      ...attrs,
      {
        name: 'org_slug',
        displayName: 'Organization slug',
        validations: { length: { max: 255 } },
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        multivalued: false,
        group: 'user-metadata',
      },
    ];
  }

  const put = await a.put('/users/profile', cfg);
  if (!put.ok) throw new Error(`put users/profile failed: ${put.status} ${await put.text()}`);
  console.log(`  users/profile: org_slug ${remove ? 'removed' : 'declared'}`);
}

async function findUserId(a: Api, username: string): Promise<string | null> {
  const res = await a.get(`/users?username=${encodeURIComponent(username)}&exact=true`);
  if (!res.ok) throw new Error(`user lookup failed for ${username}: ${res.status}`);
  const rows = (await res.json()) as { id: string }[];
  return rows[0]?.id ?? null;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const del = process.argv.slice(2).includes('--delete');
  const a = api(await getAdminToken());

  // Keycloak 26's declarative user profile drops any attribute not declared
  // in the profile. realm-export.json ships no profile config, so `org_slug`
  // survives only on the *imported* E0 users (import bypasses the profile
  // filter) -- a runtime admin-API user creation silently loses it and every
  // request then 403s with "Missing org_slug claim". Declare `org_slug` as an
  // optional profile attribute (narrower than flipping unmanagedAttributePolicy
  // to ENABLED, which would allow *any* attribute). Non-breaking for E0: the
  // value is already stored on those users, this only makes the profile aware
  // of it. See ADR-035. On --delete this runs *after* the users are gone.
  if (!del) await ensureOrgSlugAttribute(a, false);

  // realm role rep (needed for role-mapping assignment)
  const roleRes = await a.get(`/roles/${SEED_KC_ROLE}`);
  if (!roleRes.ok) throw new Error(`realm role '${SEED_KC_ROLE}' not found: ${roleRes.status}`);
  const roleRep = (await roleRes.json()) as { id: string; name: string };

  for (const u of SEED_KC_USERS) {
    const existingId = await findUserId(a, u.username);

    if (del) {
      if (existingId) {
        const r = await a.del(`/users/${existingId}`);
        console.log(`  ${u.username}: ${r.ok ? 'deleted' : `delete failed ${r.status}`}`);
      } else {
        console.log(`  ${u.username}: not present`);
      }
      continue;
    }

    const rep = {
      username: u.username,
      email: u.username,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: true,
      emailVerified: true,
      requiredActions: [] as string[],
      attributes: { org_slug: [u.tenantSlug] },
      credentials: [{ type: 'password', value: SEED_KC_PASSWORD, temporary: false }],
    };

    let userId = existingId;
    if (userId) {
      const r = await a.put(`/users/${userId}`, rep);
      if (!r.ok) throw new Error(`update ${u.username} failed: ${r.status}`);
    } else {
      const r = await a.post('/users', rep);
      if (!r.ok && r.status !== 409) throw new Error(`create ${u.username} failed: ${r.status} ${await r.text()}`);
      userId = await findUserId(a, u.username);
    }
    if (!userId) throw new Error(`could not resolve id for ${u.username}`);

    const rm = await a.post(`/users/${userId}/role-mappings/realm`, [roleRep]);
    if (!rm.ok && rm.status !== 409) throw new Error(`role assign ${u.username} failed: ${rm.status}`);

    console.log(`  ${u.username}  ->  org_slug=${u.tenantSlug}, role=${SEED_KC_ROLE}  (${existingId ? 'updated' : 'created'})`);
  }

  if (del) await ensureOrgSlugAttribute(a, true);

  console.log(del ? '\nseed Keycloak users removed.' : `\nseed Keycloak users ready. password: ${SEED_KC_PASSWORD}`);
}

main().catch((err: unknown) => {
  console.error('seed:users failed:', err);
  process.exitCode = 1;
});
