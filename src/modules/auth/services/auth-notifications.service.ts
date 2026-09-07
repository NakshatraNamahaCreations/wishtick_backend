import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import { MAILER, type IMailer } from 'src/infra/notifier/mailer.port';
import { SMS_SENDER, type ISmsSender } from 'src/infra/notifier/sms.port';

/**
 * Auth-specific message copy, kept out of AuthService so the flow logic stays
 * readable. Sprint 9 replaces these plain-text bodies with MJML templates and
 * routes them through the notifications queue; the call sites do not move.
 */
@Injectable()
export class AuthNotificationsService {
  constructor(
    @Inject(MAILER) private readonly mailer: IMailer,
    @Inject(SMS_SENDER) private readonly sms: ISmsSender,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async sendEmailVerification(email: string, code: string): Promise<void> {
    const minutes = Math.round(this.config.get('otp.ttlSeconds', { infer: true }) / 60);
    await this.mailer.send({
      to: email,
      subject: `${code} is your Wishtick verification code`,
      text:
        `Welcome to Wishtick!\n\n` +
        `Your verification code is ${code}. It expires in ${minutes} minutes.\n\n` +
        `If you didn't create a Wishtick account, you can safely ignore this email.`,
    });
  }

  async sendPhoneVerification(phone: string, code: string): Promise<void> {
    const minutes = Math.round(this.config.get('otp.ttlSeconds', { infer: true }) / 60);
    await this.sms.send({
      to: phone,
      body: `${code} is your Wishtick verification code. It expires in ${minutes} minutes.`,
    });
  }

  async sendPasswordReset(email: string, rawToken: string, ttlSeconds: number): Promise<void> {
    const webUrl = this.config.get('app.webAppUrl', { infer: true });
    const link = `${webUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
    const minutes = Math.round(ttlSeconds / 60);

    await this.mailer.send({
      to: email,
      subject: 'Reset your Wishtick password',
      text:
        `We received a request to reset your Wishtick password.\n\n` +
        `Reset it here (link valid for ${minutes} minutes, one use only):\n${link}\n\n` +
        `If you didn't request this, ignore this email — your password will not change.`,
    });
  }

  async sendPasswordResetSms(phone: string, rawToken: string, ttlSeconds: number): Promise<void> {
    const webUrl = this.config.get('app.webAppUrl', { infer: true });
    const minutes = Math.round(ttlSeconds / 60);
    await this.sms.send({
      to: phone,
      body: `Reset your Wishtick password (valid ${minutes}m): ${webUrl}/reset-password?token=${encodeURIComponent(rawToken)}`,
    });
  }

  /**
   * Sent after a successful reset. This is a security control, not a courtesy:
   * it is how a victim finds out their account was taken over.
   */
  async sendPasswordChangedNotice(email: string): Promise<void> {
    await this.mailer.send({
      to: email,
      subject: 'Your Wishtick password was changed',
      text:
        `Your Wishtick password was just changed and all your sessions were signed out.\n\n` +
        `If this wasn't you, reset your password immediately and contact support.`,
    });
  }
}
