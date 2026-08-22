export type EmployeeStatus = 'active' | 'inactive';

export interface Employee {
  id: string;
  tenantId: string;
  employeeCode: string;
  fullName: string;
  department: string | null;
  status: EmployeeStatus;
  createdAt: string;
  version: number;
}
