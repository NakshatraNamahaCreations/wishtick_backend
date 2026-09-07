import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { ISmsSender, SendSmsInput } from '../sms.port';

/**
 * A generic HTTP SMS gateway, selected when SMS_DRIVER=http.
 *
 * MSG91, Twilio, and most Indian gateways accept a simple authenticated POST;
 * this posts `{ to, body, from }` with a bearer token, which covers the common
 * shape and keeps us off a vendor SDK. A vendor with a bespoke payload gets its
 * own adapter behind this same port.
 */
@Injectable()
export class HttpSmsAdapter implements ISmsSender {
  private readonly logger = new Logger('Sms:HTTP');
  private readonly endpoint: string;
  private readonly authToken: string;
  private readonly senderId: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const sms = config.get('delivery.sms', { infer: true });
    this.endpoint = sms.endpoint;
    this.authToken = sms.authToken;
    this.senderId = sms.senderId;
  }

  async send(input: SendSmsInput): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
      },
      body: JSON.stringify({ to: input.to, body: input.body, from: this.senderId }),
    });
    if (!res.ok) {
      throw new Error(`SMS gateway returned ${res.status} ${res.statusText}`);
    }
    this.logger.debug(`Sent SMS to ${input.to}`);
  }
}
