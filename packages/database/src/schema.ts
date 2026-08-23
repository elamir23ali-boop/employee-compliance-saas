import { pgTable, uuid, text, timestamp, integer, date, boolean, jsonb, inet, unique } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    employeeCode: text('employee_code').notNull(),
    // E0-compatible display column, derived from firstName/lastName by
    // EmployeesService on write. See docs/architecture/decisions.md (ADR-021).
    fullName: text('full_name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    department: text('department'),
    jobTitle: text('job_title'),
    branch: text('branch'),
    responsibleOfficerId: text('responsible_officer_id'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [unique().on(table.tenantId, table.employeeCode)],
);

export const ExpiryStatus = {
  VALID: 'VALID',
  EXPIRING_SOON: 'EXPIRING_SOON',
  RENEWAL_IN_PROGRESS: 'RENEWAL_IN_PROGRESS',
  EXCEPTION: 'EXCEPTION',
  EXPIRED: 'EXPIRED',
  BLOCKED: 'BLOCKED',
} as const;
export type ExpiryStatus = (typeof ExpiryStatus)[keyof typeof ExpiryStatus];

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  employeeId: uuid('employee_id').references(() => employees.id),
  docType: text('doc_type').notNull(),
  docNumber: text('doc_number').notNull(),
  issueDate: date('issue_date'),
  expiryDate: date('expiry_date'),
  status: text('status').notNull().default('valid'),
  expiryStatus: text('expiry_status').notNull().default(ExpiryStatus.VALID).$type<ExpiryStatus>(),
  version: integer('version').notNull().default(1),
  renewalStartedAt: timestamp('renewal_started_at', { withTimezone: true }),
  exceptionReason: text('exception_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const expiryPolicies = pgTable(
  'expiry_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    docType: text('doc_type').notNull(),
    warningDays1: integer('warning_days_1').notNull().default(90),
    warningDays2: integer('warning_days_2').notNull().default(60),
    warningDays3: integer('warning_days_3').notNull().default(30),
    criticalDays: integer('critical_days').notNull().default(14),
    gracePeriodDays: integer('grace_period_days').notNull().default(0),
    autoBlock: boolean('auto_block').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.tenantId, table.docType)],
);

// Append-only. app_user has no UPDATE/DELETE grant on this table at the DB
// level (05_audit_events.sql) -- Drizzle's typings don't enforce that, the
// GRANT does. Never expose a route that writes here except AuditService.
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  correlationId: uuid('correlation_id').notNull().defaultRandom(),
  requestId: text('request_id'),
  actorUserId: text('actor_user_id'),
  actorIp: inet('actor_ip'),
  actorUserAgent: text('actor_user_agent'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  outcome: text('outcome').notNull().$type<'SUCCESS' | 'FAILED' | 'PARTIAL'>(),
  reason: text('reason'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
