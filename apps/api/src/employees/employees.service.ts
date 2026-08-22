import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { employees } from '@ecs/database';
import { DrizzleService } from '../database/drizzle.service';

export interface FindAllResult {
  data: (typeof employees.$inferSelect)[];
  total: number;
}

@Injectable()
export class EmployeesService {
  constructor(private readonly drizzle: DrizzleService) {}

  async findAll(tenantId: string, page: number, limit: number): Promise<FindAllResult> {
    return this.drizzle.db.transaction(async (tx) => {
      // SET LOCAL via set_config(..., true): scoped to this transaction only,
      // resets automatically on COMMIT/ROLLBACK -- never leaks to the next
      // request that reuses this pooled connection.
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);

      const rows = await tx
        .select()
        .from(employees)
        .limit(limit)
        .offset((page - 1) * limit);

      const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(employees);
      const total = countRows[0]?.count ?? 0;

      return { data: rows, total };
    });
  }
}
