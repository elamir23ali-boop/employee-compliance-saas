import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './filters/http-exception.filter';

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env.local');
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function bootstrap(): Promise<void> {
  loadEnvLocal();
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new HttpExceptionFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API listening on :${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ action: 'api_shutdown_started', signal }));

    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      timer.unref();
    });

    // Stop accepting new connections and let in-flight requests finish
    // *before* tearing down providers (DrizzleService's pool etc.) --
    // deliberately not app.close() alone / enableShutdownHooks()'s own
    // signal wiring for this step: NestApplicationContext.close() runs
    // OnModuleDestroy hooks (which end the DB pool) BEFORE it closes the
    // HTTP server (confirmed against @nestjs/core's own close()/dispose()
    // source), which would fail any request still in flight during drain.
    // Closing the raw HTTP server first, then calling app.close() only once
    // it has drained, gets the ordering the task actually needs.
    const httpServer = app.getHttpServer();
    const drained = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    await Promise.race([drained, timeout]);
    await app.close();

    console.log(JSON.stringify({ action: 'api_shutdown_completed', signal }));
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap();
