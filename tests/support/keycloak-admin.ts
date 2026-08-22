const REALM = 'e0-test';

async function getAdminToken(): Promise<string> {
  const adminUrl = process.env.KEYCLOAK_ADMIN_URL;
  if (!adminUrl) throw new Error('KEYCLOAK_ADMIN_URL is not set');

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: process.env.KEYCLOAK_ADMIN_USER ?? 'admin',
    password: process.env.KEYCLOAK_ADMIN_PASS ?? 'admin',
  });
  const res = await fetch(`${adminUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Admin token request failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

export async function setAccessTokenLifespan(seconds: number): Promise<void> {
  const adminUrl = process.env.KEYCLOAK_ADMIN_URL;
  const token = await getAdminToken();
  const res = await fetch(`${adminUrl}/admin/realms/${REALM}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ accessTokenLifespan: seconds }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set accessTokenLifespan: ${res.status}`);
  }
}
