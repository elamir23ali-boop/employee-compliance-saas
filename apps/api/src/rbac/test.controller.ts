import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantMiddleware } from '../tenant/tenant.middleware';
import { RbacGuard } from './rbac.guard';
import { Roles } from './roles.decorator';

// E0: minimal endpoints for RBAC tests AUTH-01/AUTH-02. No business logic.
@Controller('api/v1/test')
@UseGuards(AuthGuard, TenantMiddleware, RbacGuard)
export class TestController {
  @Post('write')
  @Roles('hr-staff')
  write(): { ok: true } {
    return { ok: true };
  }

  @Get('admin')
  @Roles('tenant-admin')
  admin(): { ok: true } {
    return { ok: true };
  }
}
