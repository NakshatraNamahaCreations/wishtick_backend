export interface SendMailInput {
  to: string;
  subject: string;
  /** Plain-text body. Sprint 9 replaces this with MJML-rendered templates. */
  text: string;
  html?: string;
}

export const MAILER = Symbol('MAILER');

/**
 * Sprint 1 only needs to get an OTP to a mailbox. Sprint 9 implements SES /
 * SendGrid behind this same interface plus templating, bounce handling, and
 * queue-backed retry — callers here do not change.
 */
export interface IMailer {
  send(input: SendMailInput): Promise<void>;
}
