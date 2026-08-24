import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from '../rbac/rbac.guard';
import { Roles } from '../rbac/roles.decorator';
import type { AuthenticatedRequest } from '../common/request.types';
import { DashboardService } from './dashboard.service';

const expiringSchema = z.object({
  withinDays: z.coerce.number().int().min(1).max(365).default(30),
  docType: z.enum(['passport', 'residence', 'badge']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

@Controller('api/v1/dashboard')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  @Roles('viewer')
  async summary(@Req() req: AuthenticatedRequest) {
    const tenantId = req.tenantId as string;
    const data = await this.dashboardService.getSummary(tenantId);
    return { data, requestId: req.requestId };
  }

  @Get('document-stats')
  @Roles('viewer')
  async documentStats(@Req() req: AuthenticatedRequest) {
    const tenantId = req.tenantId as string;
    const data = await this.dashboardService.getDocumentStats(tenantId);
    return { data, requestId: req.requestId };
  }

  @Get('expiring')
  @Roles('viewer')
  async expiring(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const parsed = expiringSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const { page, limit, ...filters } = parsed.data;
    const { data, total } = await this.dashboardService.getExpiringDocuments(tenantId, { ...filters, page, limit });
    return { data, total, page, limit, requestId: req.requestId };
  }
}
