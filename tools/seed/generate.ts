/**
 * E6 synthetic-data generator.
 *
 *   npm run generate                 # use each tenant's configured employeeCount
 *   npm run generate -- --count=1000 # total, split across tenants by weight
 *
 * Strategy (see the E6 brief + tools/seed/db.ts):
 *   - app_user connection only, never migration_user
 *   - one transaction per tenant, `SET LOCAL app.current_tenant_id` first
 *   - batched multi-row INSERT (BATCH_SIZE rows/statement), never COPY FROM
 *   - idempotent: skips a tenant that already has `@test.invalid` employees
 *   - zero real PII -- all names/titles via @faker-js/faker, emails on
 *     the reserved `@test.invalid` domain
 */
import { randomUUID } from 'node:crypto';
import { faker } from '@faker-js/faker';
import type { PoolClient } from 'pg';
import { appPool, withTenant, parseCountArg } from './db';
import {
  TENANTS,
  DOCUMENT_DISTRIBUTION,
  DOC_TYPE_DB,
  EXPIRY_DISTRIBUTION,
  type ExpiryBucket,
  BATCH_SIZE,
  SEED_EMAIL_DOMAIN,
  PROGRESS_EVERY,
} from './config';

const DOC_KEYS = Object.keys(DOCUMENT_DISTRIBUTION) as (keyof typeof DOCUMENT_DISTRIBUTION)[];
const EXPIRY_BUCKETS = Object.keys(EXPIRY_DISTRIBUTION) as ExpiryBucket[];

const EMP_PREFIX =
  'INSERT INTO employees (id, tenant_id, employee_code, full_name, first_name, last_name, email, department, job_title)';
const DOC_PREFIX =
  'INSERT INTO documents (id, tenant_id, employee_id, doc_type, doc_number, expiry_date, expiry_status)';

function randInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/** Weighted pick over EXPIRY_DISTRIBUTION. */
function pickExpiryBucket(): ExpiryBucket {
  const r = Math.random();
  let acc = 0;
  for (const bucket of EXPIRY_BUCKETS) {
    // eslint-disable-next-line security/detect-object-injection -- key is from Object.keys of a literal
    acc += EXPIRY_DISTRIBUTION[bucket];
    if (r < acc) return bucket;
  }
  return 'valid';
}

const NOW = new Date();
const TODAY_UTC = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate());

/**
 * Map an expiry bucket to a concrete (expiry_date, expiry_status). Dates are
 * UTC calendar-date strings, matching how the app stores them (ADR-033).
 * Status is what the Expiry Engine would compute under the default policy
 * (widest window 90d, grace 0, autoBlock false).
 */
function expiryBucketToDates(bucket: ExpiryBucket): { expiryDate: string; expiryStatus: string } {
  let offsetDays: number;
  let expiryStatus: string;
  switch (bucket) {
    case 'expired':
      offsetDays = -(1 + randInt(400));
      expiryStatus = 'EXPIRED';
      break;
    case 'critical':
      offsetDays = 1 + randInt(30); // 1..30
      expiryStatus = 'EXPIRING_SOON';
      break;
    case 'expiring_soon':
      offsetDays = 31 + randInt(60); // 31..90
      expiryStatus = 'EXPIRING_SOON';
      break;
    case 'valid':
    default:
      offsetDays = 91 + randInt(820); // 91..910
      expiryStatus = 'VALID';
      break;
  }
  const expiryDate = new Date(TODAY_UTC + offsetDays * 86_400_000).toISOString().slice(0, 10);
  return { expiryDate, expiryStatus };
}

async function batchInsert(client: PoolClient, prefix: string, rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params: unknown[] = [];
    const valuesSql = chunk
      .map(
        (row) =>
          `(${row
            .map((v) => {
              params.push(v);
              return `$${params.length}`;
            })
            .join(',')})`,
      )
      .join(',');
    await client.query(`${prefix} VALUES ${valuesSql}`, params);
  }
}

/** Employee counts per tenant id, splitting `total` weighted by employeeCount. */
function distribute(total: number): Map<string, number> {
  const weightSum = TENANTS.reduce((s, t) => s + t.employeeCount, 0);
  const counts = new Map<string, number>();
  let assigned = 0;
  for (const t of TENANTS) {
    const c = Math.round((total * t.employeeCount) / weightSum);
    counts.set(t.id, c);
    assigned += c;
  }
  // Absorb rounding drift into the first (largest) tenant.
  const first = TENANTS[0];
  if (first) counts.set(first.id, (counts.get(first.id) ?? 0) + (total - assigned));
  return counts;
}

async function alreadySeeded(client: PoolClient): Promise<boolean> {
  const res = await client.query('SELECT 1 FROM employees WHERE email LIKE $1 LIMIT 1', [`%${SEED_EMAIL_DOMAIN}`]);
  return (res.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  const override = parseCountArg(process.argv.slice(2));
  const countFor = (tenantId: string, configured: number): number =>
    override === undefined ? configured : (distribute(override).get(tenantId) ?? 0);

  const grandTotal = TENANTS.reduce((s, t) => s + countFor(t.id, t.employeeCount), 0);
  const pool = appPool();
  const started = Date.now();
  let totalEmployees = 0;
  let totalDocuments = 0;
  let rowsSinceProgress = 0;

  console.log(
    `Seeding ${grandTotal.toLocaleString()} employees across ${TENANTS.length} tenants` +
      (override === undefined ? ' (configured counts)' : ` (--count=${override})`),
  );

  try {
    for (const [ti, tenant] of TENANTS.entries()) {
      const target = countFor(tenant.id, tenant.employeeCount);

      // tenants has no RLS -- ensure the load-test tenant row exists.
      await pool.query(
        "INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active') ON CONFLICT (id) DO NOTHING",
        [tenant.id, tenant.name, tenant.slug],
      );

      const tenantEmp = await withTenant(pool, tenant.id, async (client) => {
        if (await alreadySeeded(client)) {
          console.warn(`  ! ${tenant.name}: @test.invalid employees already present -- skipping (run cleanup first)`);
          return 0;
        }

        let empSeq = 0;
        let docSeq = 0;
        let done = 0;
        while (done < target) {
          const n = Math.min(BATCH_SIZE, target - done);
          const empRows: unknown[][] = [];
          const docRows: unknown[][] = [];

          for (let k = 0; k < n; k++) {
            empSeq++;
            const id = randomUUID();
            const firstName = faker.person.firstName();
            const lastName = faker.person.lastName();
            empRows.push([
              id,
              tenant.id,
              `SEED-${ti + 1}-${empSeq}`,
              `${firstName} ${lastName}`,
              firstName,
              lastName,
              `seed-${id}${SEED_EMAIL_DOMAIN}`,
              faker.commerce.department(),
              faker.person.jobType(),
            ]);

            for (const key of DOC_KEYS) {
              /* eslint-disable security/detect-object-injection -- key is from Object.keys of a literal */
              if (Math.random() >= DOCUMENT_DISTRIBUTION[key]) continue;
              docSeq++;
              const dbType = DOC_TYPE_DB[key];
              /* eslint-enable security/detect-object-injection */
              const { expiryDate, expiryStatus } = expiryBucketToDates(pickExpiryBucket());
              docRows.push([
                randomUUID(),
                tenant.id,
                id,
                dbType,
                `SEED-${dbType.toUpperCase()}-${ti + 1}-${docSeq}`,
                expiryDate,
                expiryStatus,
              ]);
            }
          }

          await batchInsert(client, EMP_PREFIX, empRows);
          await batchInsert(client, DOC_PREFIX, docRows);

          done += n;
          totalEmployees += n;
          totalDocuments += docRows.length;
          rowsSinceProgress += n + docRows.length;
          if (rowsSinceProgress >= PROGRESS_EVERY) {
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            console.log(
              `  ${tenant.name}: ${done.toLocaleString()}/${target.toLocaleString()} employees` +
                ` | ${totalEmployees.toLocaleString()} emp + ${totalDocuments.toLocaleString()} docs total | ${secs}s`,
            );
            rowsSinceProgress = 0;
          }
        }
        return done;
      });

      if (tenantEmp > 0) {
        console.log(`  = ${tenant.name}: ${tenantEmp.toLocaleString()} employees committed`);
      }
    }
  } finally {
    await pool.end();
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone. ${totalEmployees.toLocaleString()} employees + ${totalDocuments.toLocaleString()} documents` +
      ` = ${(totalEmployees + totalDocuments).toLocaleString()} rows in ${secs}s`,
  );
}

main().catch((err: unknown) => {
  console.error('generate failed:', err);
  process.exitCode = 1;
});
