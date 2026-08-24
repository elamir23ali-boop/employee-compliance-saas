export interface AuditContext {
  tenantId: string;
  actorUserId: string;
  actorIp?: string | undefined;
  actorUserAgent?: string | undefined;
  requestId?: string | undefined;
  correlationId?: string | undefined;
}

export type AuditAction =
  | 'EMPLOYEE_CREATED'
  | 'EMPLOYEE_UPDATED'
  | 'EMPLOYEE_ARCHIVED'
  | 'EMPLOYEE_RESTORED'
  | 'DOCUMENT_CREATED'
  | 'DOCUMENT_UPDATED'
  | 'DOCUMENT_ARCHIVED'
  | 'EXPIRY_STATUS_CHANGED'
  | 'EXPIRY_POLICY_UPDATED'
  | 'NOTIFICATION_POLICY_UPDATED'
  | 'IMPORT_BATCH_COMPLETED';

export type AuditOutcome = 'SUCCESS' | 'FAILED' | 'PARTIAL';
