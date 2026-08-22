import { Module } from '@nestjs/common';
import { TenantMiddleware } from './tenant.middleware';
import { TenantResolver } from './tenant.resolver';

@Module({
  providers: [TenantMiddleware, TenantResolver],
  exports: [TenantMiddleware, TenantResolver],
})
export class TenantModule {}
