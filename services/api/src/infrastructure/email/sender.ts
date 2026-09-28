import nodemailer from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

// Real delivery via Gmail SMTP. Fine for this project's current stage (no
// real users yet); a production auction platform would eventually want a
// dedicated transactional provider (Resend/SES/Postmark) for deliverability
// and to stay clear of Gmail's ~500/day personal-account sending cap — that
// swap is contained to this one class because everything else depends on
// the EmailSender interface, not on Gmail/nodemailer specifics.
export class GmailEmailSender implements EmailSender {
  private readonly transporter;
  private readonly fromAddress: string;

  constructor(user: string, appPassword: string) {
    this.fromAddress = user;
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: appPassword },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
  }
}

// Dev fallback when Gmail isn't configured — logs instead of sending, so
// local development works with zero email setup. Loud (warn-level) at boot
// so the gap is visible, not silent.
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    logger.warn(
      { to: message.to, subject: message.subject, html: message.html },
      'Email not actually sent — no email provider configured (set GMAIL_USER/GMAIL_APP_PASSWORD)',
    );
    return Promise.resolve();
  }
}

// Test-only: records messages in memory instead of doing anything with
// them. Tests must never send real email — imported directly by test files
// to assert on what would have been sent (e.g. extracting a reset token
// from the captured link).
export class FakeEmailSender implements EmailSender {
  public readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export const fakeEmailSender = new FakeEmailSender();

function createEmailSender(): EmailSender {
  if (env.NODE_ENV === 'test') {
    return fakeEmailSender;
  }
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    return new GmailEmailSender(env.GMAIL_USER, env.GMAIL_APP_PASSWORD);
  }
  logger.warn(
    'GMAIL_USER/GMAIL_APP_PASSWORD not configured — falling back to console email sender (dev only, no real email will be sent)',
  );
  return new ConsoleEmailSender();
}

export const emailSender = createEmailSender();
