/**
 * Production secret-loading contract (E5 Pillar 2). The interface is the
 * deliverable this phase -- EnvSecretLoader (reading process.env) remains
 * the loader actually wired into apps/api/apps/worker in every environment
 * today, dev/CI/production alike; nothing about how apps/api or
 * apps/worker read env vars changes in this phase. AwsSecretsManagerLoader
 * below is a documented stub only, not wired up anywhere -- no @aws-sdk
 * runtime dependency is added in E5. See E6 scope.
 */
export interface SecretLoader {
  get(key: string): Promise<string>;
}

/** Default loader for every environment today, dev/CI/production alike. */
export class EnvSecretLoader implements SecretLoader {
  async get(key: string): Promise<string> {
    // key is the caller-supplied secret name, not attacker-controlled
    // external input -- this is a plain env var lookup, not a write.
    // eslint-disable-next-line security/detect-object-injection
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`Secret "${key}" is not set`);
    }
    return value;
  }
}

/**
 * Not implemented -- inject in E6 AWS infrastructure phase. In ECS/Fargate,
 * prefer IAM task roles + Secrets Manager sidecar injection (secrets
 * materialized into the container's environment before the process starts)
 * over SDK calls from application code -- avoids taking a runtime
 * dependency on @aws-sdk and an IAM credential inside every process. See
 * E6 scope. This class exists only to complete the SecretLoader contract's
 * shape; it is never constructed or referenced by apps/api/apps/worker.
 */
export class AwsSecretsManagerLoader implements SecretLoader {
  // async so a thrown Error becomes a rejected Promise (matching
  // SecretLoader's contract) rather than a synchronous throw a caller
  // awaiting loader.get(...) wouldn't catch the same way.
  async get(key: string): Promise<string> {
    throw new Error(
      `AwsSecretsManagerLoader is not implemented (requested secret "${key}") -- ` +
        'production secret-loading contract prepared in E5, AWS runtime integration deferred to E6.',
    );
  }
}
