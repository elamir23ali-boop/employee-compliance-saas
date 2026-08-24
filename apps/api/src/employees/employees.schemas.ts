import { z } from 'zod';

/**
 * Deliberately its own file, not defined in employees.controller.ts: any
 * file that imports this must not transitively drag in a NestJS-decorated
 * class. apps/api/src/import-export/employee-row.ts imports this to stay a
 * genuinely pure, DB-free module -- see ADR-028 (a controller import here
 * broke `tests/unit`'s root tsconfig, which has no experimentalDecorators
 * flag, since only class-level decorators are tolerated by TypeScript's
 * standard-decorators fallback; method + parameter decorators like
 * @Post()/@Body() are not).
 */
export const createEmployeeSchema = z.object({
  employeeCode: z.string().min(1).max(64),
  firstName: z.string().min(1).max(128),
  lastName: z.string().min(1).max(128),
  email: z.string().email().optional(),
  department: z.string().max(128).optional(),
  jobTitle: z.string().max(128).optional(),
  branch: z.string().max(128).optional(),
  responsibleOfficerId: z.string().max(128).optional(),
});
