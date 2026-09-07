import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { AppConfig } from 'src/config/configuration';
import type { IMailer, SendMailInput } from '../mailer.port';

/**
 * AWS SES v2 mailer, selected when MAILER_DRIVER=ses.
 *
 * Sends both a text and (when present) an HTML body; a client that cannot render
 * HTML still gets a usable email. A configuration set, when set, is what makes
 * SES publish bounce/complaint events to the webhook that feeds our suppression
 * list — so undeliverable addresses stop receiving mail.
 *
 * The SES client is built LAZILY, on first send. NotifierModule instantiates
 * this adapter even when the console driver is active (both are candidates for
 * the driver-selection factory), and constructing an SESv2Client with no region
 * throws — so an eager client would break boot on any dev box using console mail.
 */
@Injectable()
export class SesMailerAdapter implements IMailer {
  private readonly logger = new Logger('Mailer:SES');
  private client: SESv2Client | null = null;
  private readonly from: string;
  private readonly configurationSet: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.from = this.config.get('delivery.mailFrom', { infer: true });
    this.configurationSet = this.config.get('delivery.ses.configurationSet', { infer: true });
  }

  private getClient(): SESv2Client {
    if (this.client) return this.client;
    const ses = this.config.get('delivery.ses', { infer: true });
    this.client = new SESv2Client({
      region: ses.region,
      // Fall back to the default AWS credential chain when explicit keys are blank.
      ...(ses.accessKeyId && ses.secretAccessKey
        ? { credentials: { accessKeyId: ses.accessKeyId, secretAccessKey: ses.secretAccessKey } }
        : {}),
    });
    return this.client;
  }

  async send(input: SendMailInput): Promise<void> {
    await this.getClient().send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [input.to] },
        ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: input.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: input.text, Charset: 'UTF-8' },
              ...(input.html ? { Html: { Data: input.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }),
    );
    this.logger.debug(`Sent email to ${input.to}: ${input.subject}`);
  }
}
