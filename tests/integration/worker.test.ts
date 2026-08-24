import { randomUUID } from 'node:crypto';
import { addDays } from 'date-fns';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { getAccessToken } from '../support/keycloak-client';
import { cleanupE2TestEmployees } from '../support/db-cleanup';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REMINDER_QUEUE_NAME = 'reminders'; // must match apps/worker/src/workers/reminder.worker.ts
const SEND_REMINDER_JOB = 'send-reminder';
const REMINDER_SCAN_QUEUE_NAME = 'reminder-scans'; // must match apps/worker/src/workers/reminder-scanner.worker.ts
const SCAN_JOB_NAME = 'scan-expiring-documents';
const API_BASE = process.env.E2_API_BASE ?? 'http://localhost:3000';

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

async function notificationLogStatus(documentId: string, daysBeforeExpiry: number): Promise<string | null> {
  const client = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT status FROM notification_log WHERE document_id = $1 AND days_before_expiry = $2 ORDER BY sent_at DESC LIMIT 1',
      [documentId, daysBeforeExpiry],
    );
    return (res.rows[0]?.status as string) ?? null;
  } finally {
    await client.end();
  }
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 30000, intervalMs = 250): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function createEmployeeWithEmail(token: string): Promise<string> {
  const res = await request(API_BASE)
    .post('/api/v1/employees')
    .set('Authorization', `Bearer ${token}`)
    .send({
      employeeCode: `EMP-REM-${randomUUID().slice(0, 8)}`,
      firstName: 'Reminder',
      lastName: 'Fixture',
      email: `reminder-fixture-${randomUUID().slice(0, 8)}@example.test`,
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function createExpiringDocument(token: string, employeeId: string, daysUntilExpiry: number): Promise<string> {
  const res = await request(API_BASE)
    .post(`/api/v1/employees/${employeeId}/documents`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      docType: 'passport',
      docNumber: `DOC-REM-${randomUUID().slice(0, 6)}`,
      expiryDate: addDays(new Date(), daysUntilExpiry).toISOString().slice(0, 10),
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('Worker tests', () => {
  const conn = connection();
  const reminderQueue = new Queue(REMINDER_QUEUE_NAME, { connection: conn });
  const reminderScanQueue = new Queue(REMINDER_SCAN_QUEUE_NAME, { connection: conn });

  afterAll(async () => {
    await reminderQueue.close();
    await reminderScanQueue.close();
    await conn.quit();
    await cleanupE2TestEmployees();
  });

  it('WORKER-01: valid job processed successfully', async () => {
    await reminderQueue.add(SEND_REMINDER_JOB, {
      tenantId: TENANT_A,
      documentId: '00000000-0000-0000-0000-000000000000',
      daysBeforeExpiry: 30,
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
      documentId: '00000000-0000-0000-0000-000000000000',
      daysBeforeExpiry: 30,
      idempotencyKey: 'idem-w03',
    };
    await reminderQueue.add(SEND_REMINDER_JOB, { ...base, jobId: 'job-w03-a' });
    await reminderQueue.add(SEND_REMINDER_JOB, { ...base, jobId: 'job-w03-b' });

    await waitUntil(async () => (await idempotencyKeyCount('idem-w03')) >= 1);
    // Give the second (duplicate) job time to also finish processing.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(await idempotencyKeyCount('idem-w03')).toBe(1);
  });

  it('WORKER-04: a job for a real document + employee with an email is dispatched and logged SENT', async () => {
    const token = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const employeeId = await createEmployeeWithEmail(token);
    const documentId = await createExpiringDocument(token, employeeId, 30);

    await reminderQueue.add(SEND_REMINDER_JOB, {
      tenantId: TENANT_A,
      documentId,
      daysBeforeExpiry: 30,
      jobId: `job-w04-${documentId}`,
      idempotencyKey: `reminder:${documentId}:30`,
    });

    const found = await waitUntil(async () => (await notificationLogStatus(documentId, 30)) === 'SENT');
    expect(found).toBe(true);
  });

  it('WORKER-05: the daily scan finds a newly-expiring document and dispatches it end-to-end', async () => {
    const token = await getAccessToken('hr_staff_tenant_a@e0.local', 'TestPass123!');
    const employeeId = await createEmployeeWithEmail(token);
    const documentId = await createExpiringDocument(token, employeeId, 30);

    await reminderScanQueue.add(SCAN_JOB_NAME, {}, { jobId: `job-w05-${documentId}` });

    const found = await waitUntil(
      async () => (await notificationLogStatus(documentId, 30)) === 'SENT',
      15000,
    );
    expect(found).toBe(true);
  });
});
