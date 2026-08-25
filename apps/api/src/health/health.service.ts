import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { DrizzleService } from '../database/drizzle.service';
import type { CheckStatus, ReadinessChecks } from './readiness.util';

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('health check timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Owns the two liveness pings /health/ready needs. Never returns anything
 * beyond 'ok'/'fail' to a caller -- no error message, no connection string,
 * no stack trace (CLAUDE.md: NEVER leak internal state in a response).
 * `enableOfflineQueue: false` on the Redis client means a ping issued while
 * disconnected rejects immediately instead of queuing indefinitely, so a
 * real Redis outage fails fast rather than hanging the readiness check.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: IORedis;

  constructor(private readonly drizzle: DrizzleService) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL is not set');
    }
    this.redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    // A connection-level error would otherwise be an unhandled 'error' event
    // (Node crashes the process on those) -- checkRedis()'s own try/catch is
    // what actually reports the failure to the caller.
    this.redis.on('error', () => undefined);
  }

  async checkReadiness(): Promise<ReadinessChecks> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    return { db, redis };
  }

  private async checkDb(): Promise<CheckStatus> {
    try {
      await withTimeout(this.drizzle.db.execute(sql`SELECT 1`), CHECK_TIMEOUT_MS);
      return 'ok';
    } catch {
      return 'fail';
    }
  }

  private async checkRedis(): Promise<CheckStatus> {
    try {
      const result = await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS);
      return result === 'PONG' ? 'ok' : 'fail';
    } catch {
      return 'fail';
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
