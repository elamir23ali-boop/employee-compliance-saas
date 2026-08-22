import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface E0JwtPayload extends JWTPayload {
  org_slug?: string;
  realm_access?: { roles?: string[] };
  typ?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    const jwksUri = process.env.KEYCLOAK_JWKS_URI;
    if (!jwksUri) {
      throw new Error('KEYCLOAK_JWKS_URI is not set');
    }
    jwks = createRemoteJWKSet(new URL(jwksUri));
  }
  return jwks;
}

/**
 * Validates: signature (via Keycloak JWKS), issuer, audience (e0-api or
 * account), expiry, and that the token is an access token (typ === 'Bearer').
 * Throws on any failure.
 */
export async function verifyAccessToken(token: string): Promise<E0JwtPayload> {
  const issuer = process.env.KEYCLOAK_ISSUER;
  const clientId = process.env.KEYCLOAK_CLIENT_ID ?? 'e0-api';
  if (!issuer) {
    throw new Error('KEYCLOAK_ISSUER is not set');
  }

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer,
    audience: [clientId, 'account'],
  });

  const claims = payload as E0JwtPayload;
  if (claims.typ !== 'Bearer') {
    throw new Error('Token is not an access token');
  }
  return claims;
}
