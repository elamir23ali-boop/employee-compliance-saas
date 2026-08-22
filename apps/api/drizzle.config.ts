import type { Config } from 'drizzle-kit';

// E0/E1: schema is owned and migrated by /infra/postgres/init SQL scripts
// (run by migration_user). This config exists only so drizzle-kit can
// introspect/typecheck the shared schema (packages/database) during
// development. See docs/architecture/decisions.md ADR-012.
export default {
  schema: '../../packages/database/src/schema.ts',
  out: './drizzle-meta',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
} satisfies Config;
