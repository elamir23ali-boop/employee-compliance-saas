export type EmployeeStatus = 'active' | 'suspended' | 'archived';

export interface Employee {
  id: string;
  tenantId: string;
  employeeCode: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
  branch: string | null;
  responsibleOfficerId: string | null;
  status: EmployeeStatus;
  createdAt: string;
  version: number;
  deletedAt: string | null;
}

export interface CreateEmployeeDto {
  employeeCode: string; // required, unique per tenant
  firstName: string; // required
  lastName: string; // required
  email?: string | undefined; // optional work email only
  department?: string | undefined;
  jobTitle?: string | undefined;
  branch?: string | undefined;
  responsibleOfficerId?: string | undefined;
}

export interface UpdateEmployeeDto {
  firstName?: string | undefined;
  lastName?: string | undefined;
  email?: string | undefined;
  department?: string | undefined;
  jobTitle?: string | undefined;
  branch?: string | undefined;
  responsibleOfficerId?: string | undefined;
  version: number; // required for optimistic locking
}

export interface EmployeeSearchParams {
  q?: string | undefined; // full-text search
  department?: string | undefined;
  branch?: string | undefined;
  status?: 'active' | 'suspended' | undefined;
  page?: number | undefined; // default 1
  limit?: number | undefined; // default 20, max 100
}
