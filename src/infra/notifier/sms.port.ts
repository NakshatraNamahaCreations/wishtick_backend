export interface SendSmsInput {
  to: string;
  body: string;
  /**
   * The DLT template this body was registered under. Indian operators drop any
   * SMS whose text does not match an approved template, so a DLT gateway
   * (SMSGraph) refuses to send without one; the console and generic HTTP
   * drivers ignore it.
   */
  templateId?: string;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

/** Sprint 9 implements Twilio/MSG91 behind this. */
export interface ISmsSender {
  send(input: SendSmsInput): Promise<void>;
}
