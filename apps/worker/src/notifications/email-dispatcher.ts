export interface ReminderEmailInput {
  to: string;
  documentId: string;
  daysBeforeExpiry: number;
  emailFrom: string | null;
  emailTemplateId: string | null;
}

/** Throws on failure -- callers decide how to record/react to a failed send. */
export interface EmailDispatcher {
  send(input: ReminderEmailInput): Promise<void>;
}

/**
 * Default dispatcher for this phase: no SMTP/SES provider or credentials
 * exist in this repo yet, so sending is stubbed to a single structured,
 * PII-free log line. `to` (an email address) is intentionally never logged
 * (CLAUDE.md: "NEVER log PII"). A real transport can implement the same
 * EmailDispatcher interface and be swapped in at the reminder.worker.ts
 * call site without touching its transaction/notification-log logic.
 */
export class LogEmailDispatcher implements EmailDispatcher {
  async send(input: ReminderEmailInput): Promise<void> {
    console.log(
      JSON.stringify({
        action: 'reminder_email_dispatched_stub',
        documentIdPrefix: input.documentId.slice(0, 8),
        daysBeforeExpiry: input.daysBeforeExpiry,
      }),
    );
  }
}
