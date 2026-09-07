import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { ISmsSender, SendSmsInput } from '../sms.port';

@Injectable()
export class ConsoleSmsAdapter implements ISmsSender {
  private readonly logger = new Logger('Sms');

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  send(input: SendSmsInput): Promise<void> {
    if (this.config.get('app.isProduction', { infer: true })) {
      throw new Error('ConsoleSmsAdapter must not be used in production');
    }
    this.logger.log(
      `\n──────── SMS ────────\nTo: ${input.to}\n\n${input.body}\n─────────────────────`,
    );
    return Promise.resolve();
  }
}
