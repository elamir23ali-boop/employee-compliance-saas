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
