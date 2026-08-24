import { BadRequestException, Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from '../rbac/rbac.guard';
import { Roles } from '../rbac/roles.decorator';
import { buildAuditContext } from '../common/audit-context';
import type { AuthenticatedRequest } from '../common/request.types';
import { NotificationPoliciesService } from './notification-policies.service';

const updateNotificationPolicySchema = z.object({
  reminderDaysBefore: z.array(z.number().int().positive().max(3650)).min(1).max(10).optional(),
  emailFrom: z.string().email().optional(),
  emailTemplateId: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
});

// Tenant-wide configuration, not day-to-day HR work -- scoped to
// tenant-admin only for both read and write, higher than employees/documents CRUD.
@Controller('api/v1/notification-policy')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class NotificationPoliciesController {
  constructor(private readonly notificationPoliciesService: NotificationPoliciesService) {}

  @Get()
  @Roles('tenant-admin')
  async get(@Req() req: AuthenticatedRequest) {
    const tenantId = req.tenantId as string;
    const policy = await this.notificationPoliciesService.getOrDefault(tenantId);
    return { data: policy, requestId: req.requestId };
  }

  @Patch()
  @Roles('tenant-admin')
  async update(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = updateNotificationPolicySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const policy = await this.notificationPoliciesService.update(tenantId, parsed.data, buildAuditContext(req));
    return { data: policy, requestId: req.requestId };
  }
}
