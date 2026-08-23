import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { ExpiryModule } from '../expiry/expiry.module';
import { DocumentsController } from './documents.controller';
import { EmployeeDocumentsController } from './employee-documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [TenantModule, RbacModule, AuditModule, ExpiryModule],
  controllers: [DocumentsController, EmployeeDocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
