import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from '../rbac/rbac.guard';
import { Roles } from '../rbac/roles.decorator';
import { buildAuditContext } from '../common/audit-context';
import type { AuthenticatedRequest } from '../common/request.types';
import { ImportService } from './import.service';
import { ExportService } from './export.service';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const idParamSchema = z.object({ id: z.string().uuid() });

@Controller('api/v1')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class ImportExportController {
  constructor(
    private readonly importService: ImportService,
    private readonly exportService: ExportService,
  ) {}

  @Post('imports/employees')
  @Roles('hr-staff')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES } }))
  async importEmployees(@UploadedFile() file: Express.Multer.File | undefined, @Req() req: AuthenticatedRequest) {
    if (!file) {
      throw new BadRequestException('No file uploaded (expected multipart field "file")');
    }
    const isXlsxName = file.originalname.toLowerCase().endsWith('.xlsx');
    if (!isXlsxName || file.mimetype !== XLSX_MIME_TYPE) {
      throw new BadRequestException('Only .xlsx files are accepted');
    }

    const tenantId = req.tenantId as string;
    const actorUserId = req.auth?.sub as string;
    const result = await this.importService.importEmployees(tenantId, file.buffer, actorUserId, buildAuditContext(req));
    return { data: result.batch, errors: result.errors, requestId: req.requestId };
  }

  @Get('imports/:id')
  @Roles('hr-staff')
  async getImportBatch(@Param() params: unknown, @Req() req: AuthenticatedRequest) {
    const parsed = idParamSchema.safeParse(params);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const tenantId = req.tenantId as string;
    const batch = await this.importService.findBatch(tenantId, parsed.data.id);
    if (!batch) {
      throw new NotFoundException('Import batch not found');
    }
    return { data: batch, requestId: req.requestId };
  }

  @Get('exports/employees')
  @Roles('hr-manager')
  async exportEmployees(@Req() req: AuthenticatedRequest): Promise<StreamableFile> {
    const tenantId = req.tenantId as string;
    const buffer = await this.exportService.exportEmployees(tenantId);
    return new StreamableFile(buffer, {
      type: XLSX_MIME_TYPE,
      disposition: 'attachment; filename="employees.xlsx"',
    });
  }
}
