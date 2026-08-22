export interface TokenResult {
  status: number;
  body: Record<string, unknown>;
}

/** Direct Access Grant (Resource Owner Password Credentials) against the e0-test realm. */
export async function requestToken(params: {
  username: string;
  password: string;
  totp?: string;
}): Promise<TokenResult> {
  const issuer = process.env.KEYCLOAK_ISSUER;
  const clientId = process.env.KEYCLOAK_CLIENT_ID ?? 'e0-api';
  if (!issuer) throw new Error('KEYCLOAK_ISSUER is not set');

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId,
    username: params.username,
    password: params.password,
  });
  if (params.totp) {
    body.set('totp', params.totp);
  }

  const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

export async function getAccessToken(username: string, password: string, totp?: string): Promise<string> {
  const result = await requestToken(totp === undefined ? { username, password } : { username, password, totp });
  if (result.status !== 200 || typeof result.body.access_token !== 'string') {
    throw new Error(`Failed to get token for ${username}: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body.access_token;
}
