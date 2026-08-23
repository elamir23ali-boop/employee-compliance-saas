import { ForbiddenException } from '@nestjs/common';
import type { AuditContext } from '@ecs/shared';
import type { AuthenticatedRequest } from './request.types';

/** Builds AuditContext strictly from server-verified request state -- never from client-supplied body/query. */
export function buildAuditContext(req: AuthenticatedRequest): AuditContext {
  const tenantId = req.tenantId;
  const actorUserId = req.auth?.sub;
  if (!tenantId || !actorUserId) {
    // TenantMiddleware/AuthGuard should always have set these before a
    // controller runs -- treat their absence as a fail-closed authz error,
    // never as "proceed with an empty/unknown actor."
    throw new ForbiddenException('Missing tenant or actor context');
  }
  return {
    tenantId,
    actorUserId,
    actorIp: req.ip,
    actorUserAgent: req.headers['user-agent'],
    requestId: req.requestId,
    correlationId: req.correlationId,
  };
}
