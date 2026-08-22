import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DrizzleModule } from './database/drizzle.module';
import { EmployeesModule } from './employees/employees.module';
import { PerfModule } from './perf/perf.module';

@Module({
  imports: [DrizzleModule, AuthModule, EmployeesModule, PerfModule],
})
export class AppModule {}
