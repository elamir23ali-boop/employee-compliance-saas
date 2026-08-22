import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { RbacGuard } from './rbac.guard';
import { TestController } from './test.controller';

// E0: also hosts the two minimal protected endpoints required by the RBAC
// test spec (POST /api/v1/test/write, GET /api/v1/test/admin).
@Module({
  imports: [TenantModule],
  controllers: [TestController],
  providers: [RbacGuard],
  exports: [RbacGuard],
})
export class RbacModule {}
