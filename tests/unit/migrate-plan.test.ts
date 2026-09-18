import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- infra/postgres/migrate.js is plain CommonJS, not a TS/build-tracked workspace package
const { planMigrations } = require('../../infra/postgres/migrate.js');

describe('planMigrations (ADR-039)', () => {
  it('MIGRATE-01: fresh database -- backfills nothing, applies every file in order', () => {
    const { backfill, toApply } = planMigrations({
      filesOnDisk: ['001_roles.sql', '002_schema.sql', '003_rls.sql'],
      alreadyApplied: [],
      markerTableExists: false,
    });
    expect(backfill).toEqual([]);
    expect(toApply).toEqual(['001_roles.sql', '002_schema.sql', '003_rls.sql']);
  });

  it('MIGRATE-02: pre-existing untracked database -- backfills every file on disk, applies nothing', () => {
    const { backfill, toApply } = planMigrations({
      filesOnDisk: ['001_roles.sql', '002_schema.sql', '003_rls.sql'],
      alreadyApplied: [],
      markerTableExists: true,
    });
    expect(backfill).toEqual(['001_roles.sql', '002_schema.sql', '003_rls.sql']);
    expect(toApply).toEqual([]);
  });

  it('MIGRATE-03: already-tracked database with one new file -- applies only the new file, no backfill', () => {
    const { backfill, toApply } = planMigrations({
      filesOnDisk: ['001_roles.sql', '002_schema.sql', '003_rls.sql', '004_new.sql'],
      alreadyApplied: ['001_roles.sql', '002_schema.sql', '003_rls.sql'],
      markerTableExists: true,
    });
    expect(backfill).toEqual([]);
    expect(toApply).toEqual(['004_new.sql']);
  });

  it('MIGRATE-04: fully up to date -- nothing to backfill or apply', () => {
    const { backfill, toApply } = planMigrations({
      filesOnDisk: ['001_roles.sql', '002_schema.sql'],
      alreadyApplied: ['001_roles.sql', '002_schema.sql'],
      markerTableExists: true,
    });
    expect(backfill).toEqual([]);
    expect(toApply).toEqual([]);
  });
});
