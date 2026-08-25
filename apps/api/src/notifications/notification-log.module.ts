import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotificationLogController } from './notification-log.controller';
import { NotificationLogService } from './notification-log.service';

@Module({
  imports: [TenantModule, RbacModule],
  controllers: [NotificationLogController],
  providers: [NotificationLogService],
})
export class NotificationLogModule {}
