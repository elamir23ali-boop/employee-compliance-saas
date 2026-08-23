import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DrizzleModule } from './database/drizzle.module';
import { EmployeesModule } from './employees/employees.module';
import { DocumentsModule } from './documents/documents.module';
import { PerfModule } from './perf/perf.module';
import { RequestIdMiddleware } from './common/request-id.middleware';

@Module({
  imports: [DrizzleModule, AuthModule, EmployeesModule, DocumentsModule, PerfModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
