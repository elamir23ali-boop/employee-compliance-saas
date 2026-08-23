import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { auditEvents } from '@ecs/database';
import type { DbTransaction } from '@ecs/database';
import type { AuditAction, AuditContext, AuditOutcome } from '@ecs/shared';

const SECRET_KEY_PATTERN = /password|secret|token|credential/i;

function stripSecrets(state: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!state) return state;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    // key is drawn from Object.entries(state) itself, not external input --
    // this is a shallow copy/filter, not an attacker-controlled write.
    // eslint-disable-next-line security/detect-object-injection
    clean[key] = value;
  }
  return clean;
}

/**
 * Append-only audit trail writer.
 *
 * Writes INSIDE the caller's business transaction, wrapped in a SAVEPOINT so
 * a failure of the audit INSERT itself can never poison (and therefore never
 * roll back) the caller's business transaction -- while still committing the
 * audit row atomically with the business row on the (overwhelmingly common)
 * success path. This resolves an explicit contradiction in the spec between
 * "same transaction" and "must not rollback business op on audit failure",
 * which plain try/catch cannot satisfy once Postgres has already aborted the
 * transaction. See docs/architecture/decisions.md (ADR-020) for the full
 * analysis -- do not simplify this back to a bare INSERT + try/catch.
 *
 * Never throws. Never reachable from any HTTP route directly.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  async log(
    tx: DbTransaction,
    context: AuditContext,
    action: AuditAction,
    entityType: string,
    entityId: string | null,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown> | null,
    outcome: AuditOutcome,
    reason?: string,
  ): Promise<void> {
    const safeBefore = stripSecrets(beforeState);
    const safeAfter = stripSecrets(afterState);

    try {
      await tx.execute(sql`SAVEPOINT audit_write`);
      await tx.insert(auditEvents).values({
        tenantId: context.tenantId,
        correlationId: context.correlationId ?? undefined,
        requestId: context.requestId ?? null,
        actorUserId: context.actorUserId,
        actorIp: context.actorIp ?? null,
        actorUserAgent: context.actorUserAgent ?? null,
        action,
        entityType,
        entityId,
        beforeState: safeBefore,
        afterState: safeAfter,
        outcome,
        reason: reason ?? null,
      });
      await tx.execute(sql`RELEASE SAVEPOINT audit_write`);
    } catch (err) {
      // The audit INSERT failed -- roll back only to the savepoint so the
      // outer (business) transaction is left in a healthy, committable
      // state. Never rethrow: audit failure must not affect the business
      // operation (ADR-020). Log loudly, with no PII, so the gap is
      // discoverable even though it cannot be surfaced to the caller.
      try {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT audit_write`);
      } catch (rollbackErr) {
        // If even the rollback-to-savepoint fails, the connection/transaction
        // itself is in trouble independent of audit logic -- the caller's
        // own subsequent statements will surface that failure on their own.
        this.logger.error(
          JSON.stringify({
            msg: 'audit_savepoint_rollback_failed',
            action,
            entityType,
            tenantIdPrefix: context.tenantId.slice(0, 8),
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          }),
        );
      }
      this.logger.error(
        JSON.stringify({
          msg: 'audit_write_failed',
          action,
          entityType,
          entityIdPrefix: entityId?.slice(0, 8) ?? null,
          tenantIdPrefix: context.tenantId.slice(0, 8),
          outcome,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    // Structured, PII-free success log (no names, no doc numbers, no emails,
    // no full UUIDs -- CLAUDE.md "NEVER log PII").
    this.logger.log(
      JSON.stringify({
        msg: 'audit_event_recorded',
        action,
        entityType,
        entityIdPrefix: entityId?.slice(0, 8) ?? null,
        tenantIdPrefix: context.tenantId.slice(0, 8),
        outcome,
      }),
    );
  }
}
