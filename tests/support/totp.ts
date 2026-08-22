import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

function byteAt(buf: Buffer, index: number): number {
  // index is a small, bounds-checked integer derived from crypto output, not user input.
  // eslint-disable-next-line security/detect-object-injection
  const value = buf[index];
  if (value === undefined) {
    throw new Error(`byte index ${index} out of range (length ${buf.length})`);
  }
  return value;
}

// TOTP matching Keycloak's server-side behavior (HmacSHA1, 6 digits, 30s
// period, per infra/docker/keycloak/realm-export.json otpPolicy). NOTE: unlike the RFC
// 6238 reference implementation / most authenticator apps, Keycloak's
// OTPCredentialModel does NOT base32-decode the stored secret -- it uses the
// secret string's raw UTF-8 bytes directly as the HMAC key. Verified
// empirically against a running Keycloak 26.7.2; see /docs/architecture/decisions.md (ADR-004).
export function generateTotp(
  secret: string,
  opts: { timeStepSeconds?: number; digits?: number; at?: number } = {},
): string {
  const { timeStepSeconds = 30, digits = 6, at = Date.now() } = opts;
  const key = Buffer.from(secret, 'utf8');
  const counter = Math.floor(at / 1000 / timeStepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  // SHA-1 HMAC digest is always exactly 20 bytes, and offset is masked to
  // 0-15, so these indices are always in range -- byteAt() asserts that at
  // runtime instead of silencing noUncheckedIndexedAccess with `!`.
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = byteAt(hmac, hmac.length - 1) & 0x0f;
  const binCode =
    ((byteAt(hmac, offset) & 0x7f) << 24) |
    ((byteAt(hmac, offset + 1) & 0xff) << 16) |
    ((byteAt(hmac, offset + 2) & 0xff) << 8) |
    (byteAt(hmac, offset + 3) & 0xff);
  const otp = binCode % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

// Must match infra/docker/keycloak/realm-export.json admin_tenant_a's otp secretData.value.
export const ADMIN_TENANT_A_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

// Vitest gives each test FILE its own isolated module registry (even when
// files run serially), so an in-memory "last window used" tracker doesn't
// coordinate across files. Persist it to disk instead so every test file/
// process agrees on which window was last consumed.
const STATE_FILE = path.resolve(__dirname, '.totp-state.json');

function readLastWindow(): number {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return (JSON.parse(raw) as { lastWindow?: number }).lastWindow ?? -1;
  } catch {
    return -1;
  }
}

function writeLastWindow(window: number): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastWindow: window }));
}

/**
 * Keycloak enforces single-use TOTP codes (rejects a code already consumed
 * in its 30s window). Tests that authenticate the same TOTP user multiple
 * times in quick succession must call this instead of generateTotp()
 * directly, so each call gets a code from a window that hasn't been used yet
 * -- waiting for the next window to roll over if needed.
 */
export async function nextTotp(
  secret: string,
  opts: { timeStepSeconds?: number; digits?: number } = {},
): Promise<string> {
  const timeStepSeconds = opts.timeStepSeconds ?? 30;
  let now = Date.now();
  let window = Math.floor(now / 1000 / timeStepSeconds);

  while (window === readLastWindow()) {
    const msIntoWindow = now % (timeStepSeconds * 1000);
    const waitMs = timeStepSeconds * 1000 - msIntoWindow + 250;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    now = Date.now();
    window = Math.floor(now / 1000 / timeStepSeconds);
  }

  writeLastWindow(window);
  return generateTotp(secret, { ...opts, at: now });
}
