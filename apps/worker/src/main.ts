import * as fs from 'node:fs';
import * as path from 'node:path';
import IORedis from 'ioredis';
import { createDb } from '@ecs/database';
import { createReminderWorker } from './workers/reminder.worker';
import { createImportWorker } from './workers/import.worker';

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

  // E0/E1: app_user only. NEVER construct this connection with migration_user credentials.
  const { pool, db } = createDb({ connectionString, min: 2, max: 10 });
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const reminderWorker = createReminderWorker(db, connection);
  const importWorker = createImportWorker(db, connection);

  console.log('Worker process started (reminders, imports)');

  const shutdown = async (): Promise<void> => {
    await reminderWorker.close();
    await importWorker.close();
    await connection.quit();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap();
