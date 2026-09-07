import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { IMailer, SendMailInput } from '../mailer.port';

@Injectable()
export class ConsoleMailerAdapter implements IMailer {
  private readonly logger = new Logger('Mailer');

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  send(input: SendMailInput): Promise<void> {
    if (this.config.get('app.isProduction', { infer: true })) {
      // Failing loudly beats silently swallowing a password-reset email in prod.
      throw new Error('ConsoleMailerAdapter must not be used in production');
    }
    this.logger.log(
      `\n──────── EMAIL ────────\n` +
        `From:    ${this.config.get('delivery.mailFrom', { infer: true })}\n` +
        `To:      ${input.to}\n` +
        `Subject: ${input.subject}\n\n${input.text}\n───────────────────────`,
    );
    return Promise.resolve();
  }
}
