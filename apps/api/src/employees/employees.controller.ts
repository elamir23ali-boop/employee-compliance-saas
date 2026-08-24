import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from '../rbac/rbac.guard';
import { Roles } from '../rbac/roles.decorator';
import { buildAuditContext } from '../common/audit-context';
import type { AuthenticatedRequest } from '../common/request.types';
import { EmployeesService } from './employees.service';

export const createEmployeeSchema = z.object({
  employeeCode: z.string().min(1).max(64),
  firstName: z.string().min(1).max(128),
  lastName: z.string().min(1).max(128),
  email: z.string().email().optional(),
  department: z.string().max(128).optional(),
  jobTitle: z.string().max(128).optional(),
  branch: z.string().max(128).optional(),
  responsibleOfficerId: z.string().max(128).optional(),
});

const updateEmployeeSchema = z.object({
  firstName: z.string().min(1).max(128).optional(),
  lastName: z.string().min(1).max(128).optional(),
  email: z.string().email().optional(),
  department: z.string().max(128).optional(),
  jobTitle: z.string().max(128).optional(),
  branch: z.string().max(128).optional(),
  responsibleOfficerId: z.string().max(128).optional(),
  version: z.coerce.number().int().min(1),
});

const searchSchema = z.object({
  q: z.string().max(256).optional(),
  department: z.string().max(128).optional(),
  branch: z.string().max(128).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const idParamSchema = z.object({ id: z.string().uuid() });

@Controller('api/v1/employees')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Post()
  @Roles('hr-staff')
  async create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = createEmployeeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const employee = await this.employeesService.create(tenantId, parsed.data, buildAuditContext(req));
    return { data: employee, requestId: req.requestId };
  }

  @Get()
  @Roles('viewer')
  async findAll(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const parsed = searchSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const { page, limit, ...filters } = parsed.data;
    const { data, total } = await this.employeesService.findAll(tenantId, { ...filters, page, limit });
    // tenant_id (snake_case) is kept for E0 compatibility -- tests/security/pooling.test.ts
    // (POOL-02/03) asserts this exact field on the list response.
    return { data, total, page, limit, tenant_id: tenantId, requestId: req.requestId };
  }

  @Get(':id')
  @Roles('viewer')
  async findOne(@Param() params: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = idParamSchema.safeParse(params);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const employee = await this.employeesService.findOne(tenantId, parsed.data.id);
    return { data: employee, requestId: req.requestId };
  }

  @Patch(':id')
  @Roles('hr-staff')
  async update(@Param() params: unknown, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsedParams = idParamSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new BadRequestException(parsedParams.error.flatten());
    }
    const parsedBody = updateEmployeeSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new BadRequestException(parsedBody.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const employee = await this.employeesService.update(
      tenantId,
      parsedParams.data.id,
      parsedBody.data,
      buildAuditContext(req),
    );
    return { data: employee, requestId: req.requestId };
  }

  @Delete(':id')
  @Roles('hr-manager')
  @HttpCode(200)
  async archive(@Param() params: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = idParamSchema.safeParse(params);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const result = await this.employeesService.archive(tenantId, parsed.data.id, buildAuditContext(req));
    return { data: result, requestId: req.requestId };
  }
}
