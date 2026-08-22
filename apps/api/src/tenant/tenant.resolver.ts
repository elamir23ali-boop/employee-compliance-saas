import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { tenants } from '@ecs/database';
import { DrizzleService } from '../database/drizzle.service';

/**
 * Looks up the tenant UUID for an org_slug. `tenants` has no RLS policy
 * (by design -- it must be readable before tenant context exists), so this
 * runs as a plain app_user query with no set_config needed.
 */
@Injectable()
export class TenantResolver {
  constructor(private readonly drizzle: DrizzleService) {}

  async resolveActiveTenantId(orgSlug: string): Promise<string | null> {
    const rows = await this.drizzle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.slug, orgSlug), eq(tenants.status, 'active')))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}
