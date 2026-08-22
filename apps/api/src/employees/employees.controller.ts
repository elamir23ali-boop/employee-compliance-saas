import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from '../rbac/rbac.guard';
import { EmployeesService } from './employees.service';

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type RequestWithTenant = Request & { tenantId?: string };

@Controller('api/v1/employees')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  async findAll(@Query() query: Record<string, unknown>, @Req() req: RequestWithTenant) {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const { page, limit } = parsed.data;
    const tenantId = req.tenantId as string;

    const { data, total } = await this.employeesService.findAll(tenantId, page, limit);
    return { data, total, tenant_id: tenantId };
  }
}
