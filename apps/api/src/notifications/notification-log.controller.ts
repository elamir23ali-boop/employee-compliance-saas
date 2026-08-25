import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from '../rbac/rbac.guard';
import { Roles } from '../rbac/roles.decorator';
import type { AuthenticatedRequest } from '../common/request.types';
import { NotificationLogService } from './notification-log.service';

const statsQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(720).default(24),
});

// E4 Pillar 4: read-only failure-observability view, same tenant-admin bar
// as /notification-policy (the existing "who manages notification-related
// config/health" precedent). Strictly single-tenant-scoped (req.tenantId) --
// no cross-tenant/ops view exists anywhere in this repo, see ADR-031.
@Controller('api/v1/notification-log')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class NotificationLogController {
  constructor(private readonly notificationLogService: NotificationLogService) {}

  @Get('stats')
  @Roles('tenant-admin')
  async stats(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const parsed = statsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const data = await this.notificationLogService.getStats(tenantId, parsed.data.windowHours);
    return { data, requestId: req.requestId };
  }
}
