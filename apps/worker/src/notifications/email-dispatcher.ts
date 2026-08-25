export interface ReminderEmailInput {
  to: string;
  documentId: string;
  docType: string;
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

/**
 * E4 Pillar 3: real transport, generic SMTP via nodemailer. Configured
 * entirely through env vars (see apps/worker/src/main.ts) so the same code
 * sends against MailHog (dev/CI) or any real SMTP endpoint (a provider's
 * SMTP interface, corporate SMTP) with no code change -- see ADR-030.
 * `emailTemplateId` is accepted (matches the interface/tenant policy shape)
 * but not yet used to select a template; content is deliberately minimal
 * plain text this phase (explicit gap, same treatment ADR-026 gave real
 * delivery itself). Throws on any transport failure -- callers (currently
 * only reminder.worker.ts) decide how to record/react; this class never
 * retries internally.
 */
export class SmtpEmailDispatcher implements EmailDispatcher {
  constructor(
    private readonly transporter: MailTransporter,
    private readonly defaultFrom: string,
  ) {}

  async send(input: ReminderEmailInput): Promise<void> {
    const dayWord = input.daysBeforeExpiry === 1 ? 'day' : 'days';
    await this.transporter.sendMail({
      to: input.to,
      from: input.emailFrom ?? this.defaultFrom,
      subject: `Document renewal reminder: ${input.docType} expires in ${input.daysBeforeExpiry} ${dayWord}`,
      text: [
        `Your ${input.docType} is due to expire in ${input.daysBeforeExpiry} ${dayWord}.`,
        'Please arrange renewal as soon as possible.',
        '',
        `Reference: ${input.documentId}`,
      ].join('\n'),
    });
  }
}

/** Narrow shape of nodemailer's Transporter -- just what SmtpEmailDispatcher calls, so tests can stub it without pulling in nodemailer's full type. */
export interface MailTransporter {
  sendMail(message: { to: string; from: string; subject: string; text: string }): Promise<unknown>;
}
