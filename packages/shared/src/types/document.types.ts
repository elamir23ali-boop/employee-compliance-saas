export type DocumentType = 'passport' | 'residence' | 'badge';
export type DocumentStatus = 'valid' | 'expired' | 'revoked';
export type ExpiryStatus = 'VALID' | 'EXPIRING_SOON' | 'RENEWAL_IN_PROGRESS' | 'EXCEPTION' | 'EXPIRED' | 'BLOCKED';

export interface EmployeeDocument {
  id: string;
  tenantId: string;
  employeeId: string | null;
  docType: DocumentType;
  docNumber: string;
  issueDate: string | null;
  expiryDate: string | null;
  status: DocumentStatus;
  expiryStatus: ExpiryStatus;
  version: number;
  renewalStartedAt: string | null;
  exceptionReason: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface CreateDocumentDto {
  employeeId: string;
  docType: DocumentType;
  docNumber: string;
  issueDate?: string | undefined; // ISO date string
  expiryDate?: string | undefined; // ISO date string
}

export interface UpdateDocumentDto {
  docNumber?: string | undefined;
  issueDate?: string | undefined;
  expiryDate?: string | undefined;
  expiryStatus?: ('RENEWAL_IN_PROGRESS' | 'EXCEPTION') | undefined; // only manual status overrides allowed
  exceptionReason?: string | undefined; // required if status = EXCEPTION
  version: number; // required for optimistic locking
}

export interface ExpiryPolicy {
  id: string;
  tenantId: string;
  docType: DocumentType;
  warningDays1: number;
  warningDays2: number;
  warningDays3: number;
  criticalDays: number;
  gracePeriodDays: number;
  autoBlock: boolean;
}
