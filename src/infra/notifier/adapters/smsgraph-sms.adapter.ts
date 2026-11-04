import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { ISmsSender, SendSmsInput } from '../sms.port';

/** SMSGraph's reply to a send, e.g. `{ "Response": { "Message": "Message ID : 56" }, "Status": "OK" }`. */
interface SmsGraphReply {
  Status?: string;
  Response?: { Message?: string };
}

/**
 * SMSGraph (smsgraph.biz), an Indian DLT gateway, selected when SMS_DRIVER=smsgraph.
 *
 * Uses the documented "single message to single recipient" GET API. Every send
 * carries the DLT entity and template IDs; a body that differs from the
 * approved template is accepted here but dropped by the operator, so the
 * caller must send the template text verbatim.
 *
 * The gateway serves only plain HTTP (its HTTPS certificate is issued for a
 * different domain), and the credentials travel in the query string, so the
 * request URL is never logged or put in an error message.
 */
@Injectable()
export class SmsGraphSmsAdapter implements ISmsSender {
  private static readonly timeoutMs = 10_000;

  private readonly logger = new Logger('Sms:SMSGraph');
  private readonly cfg: AppConfig['delivery']['sms']['smsgraph'];
  private readonly senderId: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const sms = config.get('delivery.sms', { infer: true });
    this.cfg = sms.smsgraph;
    this.senderId = sms.senderId;
  }

  async send(input: SendSmsInput): Promise<void> {
    if (!input.templateId) {
      // Without a template the operator drops the message, and SMSGraph may
      // still charge for it. Refuse up front rather than pay for nothing.
      throw new Error('SMSGraph needs a DLT template ID for every message');
    }
    const params = new URLSearchParams({
      UserID: this.cfg.userId,
      Password: this.cfg.password,
      SenderID: this.senderId,
      Phno: SmsGraphSmsAdapter.toIndianMobile(input.to),
      Msg: input.body,
      EntityID: this.cfg.entityId,
      TemplateID: input.templateId,
      FlashMsg: '0',
    });

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/SendSingleApi?${params.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(SmsGraphSmsAdapter.timeoutMs),
      });
    } catch (err) {
      // fetch errors can echo the URL, which carries the password.
      const reason =
        err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new Error(`SMSGraph ${reason}`);
    }
    if (!res.ok) {
      throw new Error(`SMSGraph returned ${res.status} ${res.statusText}`);
    }

    const reply = (await res.json().catch(() => ({}))) as SmsGraphReply;
    const message = reply.Response?.Message ?? '';
    if (reply.Status?.toUpperCase() !== 'OK') {
      throw new Error(
        `SMSGraph refused the message: ${message || reply.Status || 'no reason given'}`,
      );
    }
    this.logger.log(`Sent SMS to ${SmsGraphSmsAdapter.mask(input.to)} (${message})`);
  }

  /**
   * SMSGraph takes a bare 10-digit Indian mobile, as in its examples
   * ("98981XXXXX"). Numbers arrive normalised as `+91XXXXXXXXXX`; DLT covers
   * India only, so anything else is refused rather than sent somewhere odd.
   */
  static toIndianMobile(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
    if (!/^[6-9]\d{9}$/.test(local)) {
      throw new Error('SMSGraph can only send to Indian mobile numbers');
    }
    return local;
  }

  private static mask(phone: string): string {
    return phone.length > 4 ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}` : phone;
  }
}
