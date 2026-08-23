import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export type RequestWithContext = Request & { requestId: string; correlationId: string };

/**
 * Generates requestId/correlationId for every request and echoes requestId
 * back via X-Request-ID.
 *
 * Implemented as real Express middleware (not the Interceptor the E2 spec
 * sketches) so it runs before ALL guards -- same reasoning as ADR-009's
 * TenantMiddleware-as-a-Guard, just the opposite direction: an Interceptor
 * only runs after a route's Guards have already passed, so a request
 * rejected by AuthGuard/TenantMiddleware/RbacGuard (401/403) would reach the
 * exception filter with no requestId at all. Global exception responses
 * must carry a requestId regardless of which stage rejected the request.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const withContext = req as RequestWithContext;
    withContext.requestId = randomUUID();
    const incomingCorrelationId = req.headers['x-correlation-id'];
    withContext.correlationId =
      typeof incomingCorrelationId === 'string' && incomingCorrelationId.length > 0
        ? incomingCorrelationId
        : randomUUID();
    res.setHeader('X-Request-ID', withContext.requestId);
    next();
  }
}
