import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { E0JwtPayload } from '../auth/jwt.strategy';
import { TenantResolver } from './tenant.resolver';

/**
 * Implements the "Organization Extractor" + "Tenant Resolver" steps of the
 * tenant authorization flow. Implemented as a Guard (not Express
 * NestMiddleware) so it runs strictly AFTER AuthGuard: Nest's pipeline runs
 * ALL middleware before ANY guard, which would break the mandated
 * Auth -> Extract org_slug -> Resolve tenant ordering if this were real
 * middleware. See /docs/architecture/decisions.md (ADR-009).
 *
 * NEVER trusts tenant_id from the client -- org_slug comes only from the
 * verified JWT, and the tenant UUID comes only from the DB lookup below.
 */
@Injectable()
export class TenantMiddleware implements CanActivate {
  constructor(private readonly tenantResolver: TenantResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { auth?: E0JwtPayload; tenantId?: string }>();
    const orgSlug = req.auth?.org_slug;

    if (!orgSlug) {
      throw new ForbiddenException('Missing org_slug claim');
    }

    const tenantId = await this.tenantResolver.resolveActiveTenantId(orgSlug);
    if (!tenantId) {
      throw new ForbiddenException('Unknown or inactive tenant');
    }

    req.tenantId = tenantId;
    return true;
  }
}
