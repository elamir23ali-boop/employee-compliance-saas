import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLE_HIERARCHY, type Role } from '@ecs/shared';
import type { E0JwtPayload } from '../auth/jwt.strategy';
import { ROLES_KEY } from './roles.decorator';

// Role ordering (viewer < hr-staff < hr-manager < tenant-admin < platform-admin)
// lives in @ecs/shared's ROLE_HIERARCHY so it has one source of truth across
// apps. Server-side check only.
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { auth?: E0JwtPayload }>();
    const userRoles = (req.auth?.realm_access?.roles ?? []) as Role[];
    // ROLE_HIERARCHY is a closed, statically-typed Record<Role, number> --
    // these lookups are bounded by the Role union, not arbitrary user input,
    // so this isn't an object-injection sink despite the bracket notation.
    // eslint-disable-next-line security/detect-object-injection
    const userLevel = Math.max(0, ...userRoles.map((r) => ROLE_HIERARCHY[r] ?? 0));
    // eslint-disable-next-line security/detect-object-injection
    const minRequiredLevel = Math.min(...required.map((r) => ROLE_HIERARCHY[r]));

    if (userLevel === 0 || userLevel < minRequiredLevel) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
