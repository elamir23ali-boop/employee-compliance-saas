import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REMINDER_QUEUE_NAME = 'reminders'; // must match apps/worker/src/workers/reminder.worker.ts
const SEND_REMINDER_JOB = 'send-reminder';

function connection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');
  return new IORedis(url, { maxRetriesPerRequest: null });
}

async function idempotencyKeyCount(key: string): Promise<number> {
  const client = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  await client.connect();
  try {
    const res = await client.query('SELECT count(*)::int AS count FROM idempotency_keys WHERE key = $1', [key]);
    return res.rows[0].count as number;
  } finally {
    await client.end();
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10000, intervalMs = 250): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe('Worker tests', () => {
  const conn = connection();
  const reminderQueue = new Queue(REMINDER_QUEUE_NAME, { connection: conn });

  afterAll(async () => {
    await reminderQueue.close();
    await conn.quit();
  });

  it('WORKER-01: valid job processed successfully', async () => {
    await reminderQueue.add(SEND_REMINDER_JOB, {
      tenantId: TENANT_A,
      employeeId: '00000000-0000-0000-0000-000000000000',
      documentId: '00000000-0000-0000-0000-000000000000',
      jobId: 'job-w01',
      idempotencyKey: 'idem-w01',
    });

    const found = await waitUntil(async () => (await idempotencyKeyCount('idem-w01')) === 1);
    expect(found).toBe(true);
  });

  it('WORKER-02: job without tenantId is discarded, no data written', async () => {
    const job = await reminderQueue.add(SEND_REMINDER_JOB, {
      jobId: 'job-w02',
      idempotencyKey: 'idem-w02',
    });

    const failed = await waitUntil(async () => (await job.getState()) === 'failed');
    expect(failed).toBe(true);
    expect(await idempotencyKeyCount('idem-w02')).toBe(0);
  });

  it('WORKER-03: duplicate idempotencyKey processed exactly once', async () => {
    const base = {
      tenantId: TENANT_A,
      employeeId: '00000000-0000-0000-0000-000000000000',
      documentId: '00000000-0000-0000-0000-000000000000',
      idempotencyKey: 'idem-w03',
    };
    await reminderQueue.add(SEND_REMINDER_JOB, { ...base, jobId: 'job-w03-a' });
    await reminderQueue.add(SEND_REMINDER_JOB, { ...base, jobId: 'job-w03-b' });

    await waitUntil(async () => (await idempotencyKeyCount('idem-w03')) >= 1);
    // Give the second (duplicate) job time to also finish processing.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(await idempotencyKeyCount('idem-w03')).toBe(1);
  });
});
