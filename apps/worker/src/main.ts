import * as fs from 'node:fs';
import * as path from 'node:path';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import nodemailer from 'nodemailer';
import { createDb } from '@ecs/database';
import { createReminderWorker, REMINDER_QUEUE_NAME } from './workers/reminder.worker';
import { createReminderScanner, scheduleReminderScans } from './workers/reminder-scanner.worker';
import { createImportWorker } from './workers/import.worker';
import { createFailureAlertScanner, scheduleFailureAlertScans } from './workers/failure-alert-scanner.worker';
import { SmtpEmailDispatcher } from './notifications/email-dispatcher';

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env.local');
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function bootstrap(): Promise<void> {
  loadEnvLocal();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is not set');
  }
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) {
    throw new Error('SMTP_HOST is not set');
  }
  const smtpFromDefault = process.env.SMTP_FROM_DEFAULT;
  if (!smtpFromDefault) {
    throw new Error('SMTP_FROM_DEFAULT is not set');
  }

  // E0/E1: app_user only. NEVER construct this connection with migration_user credentials.
  const { pool, db } = createDb({ connectionString, min: 2, max: 10 });
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  // E4 Pillar 3 (ADR-030): generic SMTP, config-only -- the same code
  // targets MailHog (dev/CI) or a real provider's SMTP interface. Bounded
  // timeouts so one hung handshake can't hang a BullMQ job indefinitely;
  // the dispatcher never retries internally -- retry stays where ADR-026
  // put it (the next day's scan re-enqueues on FAILED).
  const smtpTransporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
  const emailDispatcher = new SmtpEmailDispatcher(smtpTransporter, smtpFromDefault);

  const reminderWorker = createReminderWorker(db, connection, emailDispatcher);
  const importWorker = createImportWorker(db, connection);

  const sendReminderQueue = new Queue(REMINDER_QUEUE_NAME, { connection });
  const reminderScanner = createReminderScanner(db, sendReminderQueue, connection);
  const reminderScanQueue = await scheduleReminderScans(connection);

  // E4 Pillar 4 (ADR-031): read-only, near-zero-cost hourly scan of
  // notification_log for elevated per-tenant failure rates. Emits a
  // structured console.error ALERT line -- no external channel, no queue
  // fan-out.
  const failureAlertScanner = createFailureAlertScanner(db, connection);
  const failureAlertScanQueue = await scheduleFailureAlertScans(connection);

  console.log('Worker process started (reminders, imports, failure-alert scans)');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ action: 'worker_shutdown_started', signal }));

    // Worker.close() (no `force` arg -> force=false) stops picking up new
    // jobs and awaits whenCurrentJobsFinished() before resolving -- a job
    // already in progress is never abandoned mid-execution. Confirmed
    // against bullmq's own Worker.close() source, not assumed.
    await reminderWorker.close();
    await importWorker.close();
    await reminderScanner.close();
    await sendReminderQueue.close();
    await reminderScanQueue.close();
    await failureAlertScanner.close();
    await failureAlertScanQueue.close();
    await connection.quit();
    await pool.end();
    smtpTransporter.close();

    console.log(JSON.stringify({ action: 'worker_shutdown_completed', signal }));
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap();
