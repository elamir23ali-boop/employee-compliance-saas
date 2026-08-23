import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
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
import { DocumentsService } from './documents.service';

const idParamSchema = z.object({ id: z.string().uuid() });

const listSchema = z.object({
  docType: z.enum(['passport', 'residence', 'badge']).optional(),
  expiryStatus: z.enum(['VALID', 'EXPIRING_SOON', 'RENEWAL_IN_PROGRESS', 'EXCEPTION', 'EXPIRED', 'BLOCKED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const updateDocumentSchema = z.object({
  docNumber: z.string().min(1).max(128).optional(),
  issueDate: z.string().date().optional(),
  expiryDate: z.string().date().optional(),
  expiryStatus: z.enum(['RENEWAL_IN_PROGRESS', 'EXCEPTION']).optional(),
  exceptionReason: z.string().min(1).max(512).optional(),
  version: z.coerce.number().int().min(1),
});

@Controller('api/v1/documents')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @Roles('viewer')
  async findAll(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const parsed = listSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const { page, limit, ...filters } = parsed.data;
    const { data, total } = await this.documentsService.findAll(tenantId, { ...filters, page, limit });
    return { data, total, page, limit, requestId: req.requestId };
  }

  @Patch(':id')
  @Roles('hr-staff')
  async update(@Param() params: unknown, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const parsedParams = idParamSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new BadRequestException(parsedParams.error.flatten());
    }
    const parsedBody = updateDocumentSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new BadRequestException(parsedBody.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const document = await this.documentsService.update(
      tenantId,
      parsedParams.data.id,
      parsedBody.data,
      buildAuditContext(req),
    );
    return { data: document, requestId: req.requestId };
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
    const result = await this.documentsService.archive(tenantId, parsed.data.id, buildAuditContext(req));
    return { data: result, requestId: req.requestId };
  }
}
