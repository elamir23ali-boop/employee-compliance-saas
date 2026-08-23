import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = path.resolve(__dirname, '..', '..', '.env.local');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
