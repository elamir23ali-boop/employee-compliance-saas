import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const IMPORT_QUEUE_NAME = 'imports'; // must match apps/worker/src/workers/import.worker.ts
const PROCESS_IMPORT_JOB = 'process-import';

/**
 * The API's first BullMQ producer. Owns the `imports` queue connection the
 * same way DrizzleService owns the DB pool (constructed from env, closed in
 * onModuleDestroy). Only ever enqueues a lightweight, PII-free completion
 * signal after a batch has already finished processing synchronously --
 * apps/worker/src/workers/import.worker.ts's existing job schema
 * ({ tenantId, jobId, idempotencyKey, rowCount }) is unchanged; this is the
 * first real caller for that E0-era stub.
 */
@Injectable()
export class ImportQueueService implements OnModuleDestroy {
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL is not set');
    }
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(IMPORT_QUEUE_NAME, { connection: this.connection });
  }

  async enqueueCompletion(input: { tenantId: string; importBatchId: string; rowCount: number }): Promise<void> {
    await this.queue.add(PROCESS_IMPORT_JOB, {
      tenantId: input.tenantId,
      jobId: input.importBatchId,
      idempotencyKey: `import:${input.importBatchId}`,
      rowCount: input.rowCount,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
