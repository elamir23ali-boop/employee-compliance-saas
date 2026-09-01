/**
 * E6 synthetic-data configuration. Validation tooling ONLY -- this directory
 * never ships to production and must not be imported by apps/** or packages/**.
 *
 * All personal data is generated with @faker-js/faker; every email is on the
 * reserved, non-routable `@test.invalid` domain (RFC 6761). No real passport /
 * residence / badge numbers or real names, ever.
 */

export interface SeedTenant {
  id: string;
  name: string;
  slug: string;
  employeeCount: number;
}

/**
 * Five dedicated load-test tenants, deliberately DISJOINT from the three E0
 * fixture tenants (`org-tenant-a/b/c`, ids `aaaa...aaaa` etc). Keeping them
 * separate means the security suite's exact row-count assertions against the
 * E0 seed (rls.test.ts: 5 / 15) are untouched no matter how much data lands
 * here. See docs/e6-results/ADR notes.
 */
export const TENANTS: SeedTenant[] = [
  { id: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001', name: 'Alpha Corp', slug: 'seed-alpha-corp', employeeCount: 50_000 },
  { id: 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002', name: 'Beta LLC', slug: 'seed-beta-llc', employeeCount: 25_000 },
  { id: 'cccccccc-cccc-cccc-cccc-000000000003', name: 'Gamma Inc', slug: 'seed-gamma-inc', employeeCount: 15_000 },
  { id: 'dddddddd-dddd-dddd-dddd-000000000004', name: 'Delta Co', slug: 'seed-delta-co', employeeCount: 7_000 },
  { id: 'eeeeeeee-eeee-eeee-eeee-000000000005', name: 'Epsilon Ltd', slug: 'seed-epsilon-ltd', employeeCount: 3_000 },
];

/**
 * Probability that an employee has a document of each type. The E6 brief names
 * these PASSPORT / RESIDENCE_PERMIT / ACCESS_BADGE; the actual
 * `documents.doc_type` CHECK constraint is ('passport','residence','badge'),
 * so DOC_TYPE_DB maps brief label -> stored value.
 */
export const DOCUMENT_DISTRIBUTION = {
  PASSPORT: 0.9,
  RESIDENCE_PERMIT: 0.85,
  ACCESS_BADGE: 0.7,
} as const;

export const DOC_TYPE_DB: Record<keyof typeof DOCUMENT_DISTRIBUTION, string> = {
  PASSPORT: 'passport',
  RESIDENCE_PERMIT: 'residence',
  ACCESS_BADGE: 'badge',
};

/**
 * Distribution of documents across expiry buckets. Buckets map to a concrete
 * (expiry_date, expiry_status) pair computed the same way the Expiry Engine
 * would under the default policy (widest warning window 90d, grace 0,
 * autoBlock false) -- see expiryBucketToDates() in generate.ts. The
 * `expiry_status` cache column is written directly here because nothing
 * recomputes it for rows inserted outside EmployeesService/DocumentsService.
 */
export const EXPIRY_DISTRIBUTION = {
  expired: 0.05, // expiry_date < today            -> EXPIRED
  critical: 0.1, // expiry within 1..30 days        -> EXPIRING_SOON
  expiring_soon: 0.15, // expiry within 31..90 days -> EXPIRING_SOON
  valid: 0.7, // expiry > 90 days from today        -> VALID
} as const;

export type ExpiryBucket = keyof typeof EXPIRY_DISTRIBUTION;

/** Rows per multi-row INSERT statement. COPY FROM is never used (RLS). */
export const BATCH_SIZE = 500;

export const SEED_EMAIL_DOMAIN = '@test.invalid';

/** Progress line cadence, in rows. */
export const PROGRESS_EVERY = 10_000;
