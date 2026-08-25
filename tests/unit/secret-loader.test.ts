import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AwsSecretsManagerLoader, EnvSecretLoader } from '../../packages/shared/src/secrets/secret-loader';

describe('EnvSecretLoader', () => {
  const KEY = 'SECRET_LOADER_TEST_VAR';

  // Static dot-notation (a literal identifier, not a computed/bracket
  // access) so this never touches security/detect-object-injection or
  // @typescript-eslint/no-dynamic-delete -- both rules exist for
  // attacker-influenced dynamic keys, not a hardcoded test fixture name.
  beforeEach(() => {
    delete process.env.SECRET_LOADER_TEST_VAR;
  });

  afterEach(() => {
    delete process.env.SECRET_LOADER_TEST_VAR;
  });

  it('SECRET-01: returns the value when the env var is set', async () => {
    process.env.SECRET_LOADER_TEST_VAR = 'a-value';
    const loader = new EnvSecretLoader();
    await expect(loader.get(KEY)).resolves.toBe('a-value');
  });

  it('SECRET-02: throws when the env var is not set', async () => {
    const loader = new EnvSecretLoader();
    await expect(loader.get(KEY)).rejects.toThrow(/not set/);
  });
});

describe('AwsSecretsManagerLoader', () => {
  it('SECRET-03: is an explicit not-implemented stub, never silently returns a value', async () => {
    const loader = new AwsSecretsManagerLoader();
    await expect(loader.get('ANY_KEY')).rejects.toThrow(/not implemented/i);
  });
});
