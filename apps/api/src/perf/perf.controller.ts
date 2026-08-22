import { Controller, ForbiddenException, Get, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * E0: test-only diagnostic endpoint used SOLELY to measure RLS overhead
 * (PERF-01 vs PERF-02). Deliberately queries via migration_user (BYPASSRLS)
 * -- the one sanctioned exception to "never use migration_user in
 * application code" -- and is hard-gated to NODE_ENV=test. See
 * /docs/architecture/decisions.md (ADR-010).
 */
@Controller('api/v1/perf')
export class PerfController implements OnModuleDestroy {
  private migrationPool?: Pool;

  @Get('raw-query')
  async rawQuery(): Promise<{ data: unknown[]; total: number }> {
    if (process.env.NODE_ENV !== 'test') {
      throw new ForbiddenException('perf endpoints are test-only');
    }
    if (!this.migrationPool) {
      const url = process.env.DATABASE_MIGRATION_URL;
      if (!url) {
        throw new Error('DATABASE_MIGRATION_URL is not set');
      }
      this.migrationPool = new Pool({ connectionString: url, max: 5 });
    }
    const result = await this.migrationPool.query('SELECT * FROM employees');
    return { data: result.rows, total: result.rowCount ?? 0 };
  }

  async onModuleDestroy(): Promise<void> {
    await this.migrationPool?.end();
  }
}
