import type { IMailer, SendMailInput } from 'src/infra/notifier/mailer.port';
import type { IPushSender, SendPushInput, SendPushResult } from 'src/infra/notifier/push.port';
import type { ISmsSender, SendSmsInput } from 'src/infra/notifier/sms.port';

/**
 * Captures outbound messages instead of sending them. This is how tests read
 * the OTP a user would have received — exactly the seam the mailer port exists
 * for, so no test needs to reach inside OtpService.
 */
export class FakeMailer implements IMailer {
  readonly sent: SendMailInput[] = [];

  send(input: SendMailInput): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  get last(): SendMailInput | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** Pulls the 4–8 digit code out of the most recent email body or subject. */
  lastCode(): string {
    const mail = this.last;
    if (!mail) throw new Error('No email was sent');
    const match = /\b(\d{4,8})\b/.exec(`${mail.subject} ${mail.text}`);
    if (!match) throw new Error(`No code found in email: ${mail.subject}`);
    return match[1];
  }

  /** Pulls the reset token out of the most recent reset link. */
  lastResetToken(): string {
    const mail = this.last;
    if (!mail) throw new Error('No email was sent');
    const match = /token=([A-Za-z0-9_-]+)/.exec(mail.text);
    if (!match) throw new Error(`No reset token found in email: ${mail.subject}`);
    return decodeURIComponent(match[1]);
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export class FakeSmsSender implements ISmsSender {
  readonly sent: SendSmsInput[] = [];

  send(input: SendSmsInput): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  get last(): SendSmsInput | undefined {
    return this.sent[this.sent.length - 1];
  }

  lastCode(): string {
    const sms = this.last;
    if (!sms) throw new Error('No SMS was sent');
    const match = /\b(\d{4,8})\b/.exec(sms.body);
    if (!match) throw new Error(`No code found in SMS: ${sms.body}`);
    return match[1];
  }

  reset(): void {
    this.sent.length = 0;
  }
}

/**
 * Captures pushes instead of sending them, and lets a test declare which
 * tokens the provider would have rejected.
 *
 * [unregistered] is the important half: the dispatcher is supposed to revoke
 * every token FCM reports dead, and without a way to simulate that rejection
 * the pruning path would never be exercised.
 */
export class FakePushSender implements IPushSender {
  readonly sent: SendPushInput[] = [];

  /** Tokens the next send should report as no longer registered. */
  unregistered = new Set<string>();

  send(input: SendPushInput): Promise<SendPushResult> {
    this.sent.push(input);
    const dead = input.tokens.filter((t) => this.unregistered.has(t));
    return Promise.resolve({ sent: input.tokens.length - dead.length, unregistered: dead });
  }

  get last(): SendPushInput | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** Every token any send in this run was addressed to. */
  get tokens(): string[] {
    return this.sent.flatMap((s) => s.tokens);
  }

  reset(): void {
    this.sent.length = 0;
    this.unregistered.clear();
  }
}
