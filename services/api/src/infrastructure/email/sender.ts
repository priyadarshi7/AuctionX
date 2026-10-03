import nodemailer from 'nodemailer';
import { Resend } from 'resend';
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
      // Explicit timeouts (Section 67) — found the hard way (ADR-0036
      // addendum) that with no timeout configured, a blocked/dropped SMTP
      // connection (e.g. Render's free-tier outbound SMTP port block)
      // hangs for ~2 minutes before Node's own default kicks in, and
      // registerUser awaits this inline, so the whole HTTP request hangs
      // with it. 10s is generous for a real SMTP handshake, nowhere near
      // long enough to look like a successful connection.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
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

// Real delivery via Resend's HTTP API — preferred over GmailEmailSender in
// production (ADR-0036 addendum) because it goes over HTTPS, not SMTP.
// Render's free tier blocks outbound SMTP ports entirely, which made
// GmailEmailSender hang for ~2 minutes per send before failing open; an
// HTTP API call isn't subject to that port block at all.
export class ResendEmailSender implements EmailSender {
  private readonly resend: Resend;
  private readonly fromAddress: string;

  constructor(apiKey: string, fromAddress: string) {
    this.resend = new Resend(apiKey);
    this.fromAddress = fromAddress;
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
    // The SDK reports provider-side failures (invalid recipient, unverified
    // domain, etc.) via this `error` field rather than throwing — surfacing
    // it as a thrown error here is what lets the existing try/catch in
    // auth/service.ts's sendVerificationEmail (fail-open, Section 24) and
    // the equivalent password-reset path catch it uniformly, the same as a
    // GmailEmailSender rejection.
    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }
}

// Real delivery via Brevo's HTTP API — preferred over Resend when no
// verified sending domain exists (ADR-0036 addendum). Resend's free sandbox
// sender can ONLY deliver to the Resend account's own email — no domain,
// no real users, confirmed directly. Brevo's free tier instead only
// requires verifying a single email address you own (click a confirmation
// link — no DNS access needed), and will deliver to ANY recipient. The
// real tradeoff: without a verified domain, Brevo routes mail through
// their own shared sending domain under the hood, so deliverability is
// weaker (more likely flagged by strict filters, e.g. Gmail/Yahoo) than a
// fully domain-authenticated sender — accepted for now since "reaches the
// inbox or spam folder" beats Resend's hard block or Gmail SMTP's ~2min
// hang-and-sometimes-fail on Render, by a wide margin.
export class BrevoEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
    private readonly fromName: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: this.fromEmail, name: this.fromName },
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brevo send failed: ${res.status} ${body}`);
    }
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
  // Brevo first — the only option that both works on Render's free tier
  // (HTTP API) AND delivers to arbitrary real users without owning a
  // domain (ADR-0036 addendum). Resend second — better deliverability IF
  // RESEND_FROM has been switched to a verified domain, but its sandbox
  // sender can't reach real users at all, so it's only useful past that
  // point. Gmail SMTP last (local dev only, Render blocks it).
  if (env.BREVO_API_KEY && env.BREVO_FROM_EMAIL) {
    return new BrevoEmailSender(env.BREVO_API_KEY, env.BREVO_FROM_EMAIL, env.BREVO_FROM_NAME);
  }
  if (env.RESEND_API_KEY) {
    return new ResendEmailSender(env.RESEND_API_KEY, env.RESEND_FROM);
  }
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    return new GmailEmailSender(env.GMAIL_USER, env.GMAIL_APP_PASSWORD);
  }
  logger.warn(
    'Neither RESEND_API_KEY nor GMAIL_USER/GMAIL_APP_PASSWORD configured — falling back to console email sender (dev only, no real email will be sent)',
  );
  return new ConsoleEmailSender();
}

export const emailSender = createEmailSender();
