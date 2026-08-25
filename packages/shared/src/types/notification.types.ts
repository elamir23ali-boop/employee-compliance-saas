export interface NotificationPolicy {
  id: string;
  tenantId: string;
  reminderDaysBefore: number[];
  emailFrom: string | null;
  emailTemplateId: string | null;
  enabled: boolean;
  updatedAt: string;
}

export interface UpdateNotificationPolicyDto {
  reminderDaysBefore?: number[] | undefined;
  emailFrom?: string | undefined;
  emailTemplateId?: string | undefined;
  enabled?: boolean | undefined;
}

// E4 Pillar 4: aggregate, PII-free view of notification_log for a tenant's
// own trailing window -- counts only, never document_id/employee/email.
export interface NotificationLogStats {
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  sentCount: number;
  failedCount: number;
  suppressedCount: number;
  totalAttempts: number;
  failureRate: number | null;
}
