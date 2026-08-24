import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { EmployeesModule } from '../employees/employees.module';
import { ImportExportController } from './import-export.controller';
import { ImportService } from './import.service';
import { ExportService } from './export.service';
import { ImportQueueService } from './import-queue.service';

@Module({
  imports: [TenantModule, RbacModule, AuditModule, EmployeesModule],
  controllers: [ImportExportController],
  providers: [ImportService, ExportService, ImportQueueService],
})
export class ImportExportModule {}
