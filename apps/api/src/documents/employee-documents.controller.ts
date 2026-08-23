import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from '../rbac/rbac.guard';
import { Roles } from '../rbac/roles.decorator';
import { buildAuditContext } from '../common/audit-context';
import type { AuthenticatedRequest } from '../common/request.types';
import { DocumentsService } from './documents.service';

const employeeIdParamSchema = z.object({ employeeId: z.string().uuid() });

const createDocumentSchema = z.object({
  docType: z.enum(['passport', 'residence', 'badge']),
  docNumber: z.string().min(1).max(128),
  issueDate: z.string().date().optional(),
  expiryDate: z.string().date().optional(),
});

@Controller('api/v1/employees/:employeeId/documents')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class EmployeeDocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @Roles('hr-staff')
  async create(@Param() params: unknown, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsedParams = employeeIdParamSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new BadRequestException(parsedParams.error.flatten());
    }
    const parsedBody = createDocumentSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new BadRequestException(parsedBody.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const document = await this.documentsService.create(
      tenantId,
      parsedParams.data.employeeId,
      { employeeId: parsedParams.data.employeeId, ...parsedBody.data },
      buildAuditContext(req),
    );
    return { data: document, requestId: req.requestId };
  }

  @Get()
  @Roles('viewer')
  async findAll(@Param() params: unknown, @Req() req: AuthenticatedRequest) {
    const parsedParams = employeeIdParamSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new BadRequestException(parsedParams.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const data = await this.documentsService.findAllForEmployee(tenantId, parsedParams.data.employeeId);
    return { data, requestId: req.requestId };
  }
}
