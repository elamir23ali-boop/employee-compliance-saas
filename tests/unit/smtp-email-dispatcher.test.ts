import { describe, expect, it, vi } from 'vitest';
import { SmtpEmailDispatcher } from '../../apps/worker/src/notifications/email-dispatcher';

function fakeTransporter(sendMail = vi.fn().mockResolvedValue(undefined)) {
  return { sendMail };
}

describe('SmtpEmailDispatcher', () => {
  it('SMTP-01: uses the tenant-provided emailFrom when set', async () => {
    const transporter = fakeTransporter();
    const dispatcher = new SmtpEmailDispatcher(transporter, 'default@example.test');

    await dispatcher.send({
      to: 'employee@example.test',
      documentId: 'doc-123',
      docType: 'passport',
      daysBeforeExpiry: 30,
      emailFrom: 'tenant@example.test',
      emailTemplateId: null,
    });

    expect(transporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'employee@example.test', from: 'tenant@example.test' }),
    );
  });

  it('SMTP-02: falls back to the default from-address when the tenant has none set', async () => {
    const transporter = fakeTransporter();
    const dispatcher = new SmtpEmailDispatcher(transporter, 'default@example.test');

    await dispatcher.send({
      to: 'employee@example.test',
      documentId: 'doc-123',
      docType: 'visa',
      daysBeforeExpiry: 7,
      emailFrom: null,
      emailTemplateId: null,
    });

    expect(transporter.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'default@example.test' }));
  });

  it('SMTP-03: subject and body reflect docType and daysBeforeExpiry, with correct day/days wording', async () => {
    let sent: { subject: string; text: string } | undefined;
    const transporter = fakeTransporter(vi.fn().mockImplementation(async (message) => {
      sent = message;
    }));
    const dispatcher = new SmtpEmailDispatcher(transporter, 'default@example.test');

    await dispatcher.send({
      to: 'employee@example.test',
      documentId: 'doc-123',
      docType: 'passport',
      daysBeforeExpiry: 1,
      emailFrom: null,
      emailTemplateId: null,
    });

    expect(sent).toBeDefined();
    expect(sent?.subject).toContain('passport expires in 1 day');
    expect(sent?.subject).not.toContain('1 days');
    expect(sent?.text).toContain('passport');
    expect(sent?.text).toContain('doc-123');
  });

  it('SMTP-04: a transporter rejection propagates as a thrown error', async () => {
    const transporter = fakeTransporter(vi.fn().mockRejectedValue(new Error('smtp connection refused')));
    const dispatcher = new SmtpEmailDispatcher(transporter, 'default@example.test');

    await expect(
      dispatcher.send({
        to: 'employee@example.test',
        documentId: 'doc-123',
        docType: 'passport',
        daysBeforeExpiry: 30,
        emailFrom: null,
        emailTemplateId: null,
      }),
    ).rejects.toThrow('smtp connection refused');
  });
});
