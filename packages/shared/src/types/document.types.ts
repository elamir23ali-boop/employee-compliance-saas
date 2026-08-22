export type DocumentType = 'passport' | 'residence' | 'badge';
export type DocumentStatus = 'valid' | 'expired' | 'revoked';

export interface EmployeeDocument {
  id: string;
  tenantId: string;
  employeeId: string | null;
  docType: DocumentType;
  docNumber: string;
  expiryDate: string | null;
  status: DocumentStatus;
  createdAt: string;
}
