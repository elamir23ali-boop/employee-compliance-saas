import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { createDb, type Database } from '@ecs/database';

// E0/E1: app_user only. NEVER construct this connection with migration_user credentials.
@Injectable()
export class DrizzleService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: Database;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    const { pool, db } = createDb({ connectionString, min: 2, max: 10 });
    this.pool = pool;
    this.db = db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
