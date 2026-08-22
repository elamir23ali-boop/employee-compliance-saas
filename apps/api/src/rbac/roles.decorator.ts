import { SetMetadata } from '@nestjs/common';
import type { Role } from '@ecs/shared';

export const ROLES_KEY = 'ecs_roles';

/** Marks a route as requiring at least one of the given roles (or higher, per RbacGuard's hierarchy). */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
