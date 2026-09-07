export interface SendSmsInput {
  to: string;
  body: string;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

/** Sprint 9 implements Twilio/MSG91 behind this. */
export interface ISmsSender {
  send(input: SendSmsInput): Promise<void>;
}
