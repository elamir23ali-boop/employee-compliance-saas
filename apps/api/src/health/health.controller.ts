import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { computeReadiness } from './readiness.util';

/**
 * Liveness/readiness probes for load balancers/orchestrators. Deliberately
 * unauthenticated (no @UseGuards -- this repo has no global auth guard, see
 * app.module.ts, so omitting guards here is what makes "must NOT return 401"
 * true) and PII-free: no DB version, connection string, stack trace, tenant
 * data, or env var is ever returned (CLAUDE.md: never leak internal state).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  liveness(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: Response) {
    const checks = await this.healthService.checkReadiness();
    const { httpStatus, body } = computeReadiness(checks);
    res.status(httpStatus);
    return body;
  }
}
