import type { Request } from 'express';
import type { E0JwtPayload } from '../auth/jwt.strategy';
import type { RequestWithContext } from './request-id.middleware';

export type AuthenticatedRequest = Request &
  RequestWithContext & {
    auth?: E0JwtPayload;
    tenantId?: string;
  };
