import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '..', '..', '.env.local');
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function bootstrap(): Promise<void> {
  loadEnvLocal();
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API listening on :${port}`);
}

bootstrap();
