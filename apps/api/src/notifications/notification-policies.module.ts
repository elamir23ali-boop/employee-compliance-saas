import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationPoliciesController } from './notification-policies.controller';
import { NotificationPoliciesService } from './notification-policies.service';

@Module({
  imports: [TenantModule, RbacModule, AuditModule],
  controllers: [NotificationPoliciesController],
  providers: [NotificationPoliciesService],
})
export class NotificationPoliciesModule {}
