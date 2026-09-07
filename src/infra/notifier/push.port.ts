export interface SendPushInput {
  /** FCM registration tokens. One call, many devices — the same person's. */
  tokens: string[];
  title: string;
  body: string;
  /** Deep-link data the app reads on tap. Values must be strings; FCM insists. */
  data?: Record<string, string>;
}

export interface SendPushResult {
  sent: number;
  /**
   * Tokens the provider rejected as no longer registered — an uninstalled app,
   * a wiped device. The caller revokes these; leaving them in place means every
   * future fan-out pays for a delivery that cannot land.
   */
  unregistered: string[];
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * Sends a push to a person's devices.
 *
 * Mirrors [IMailer] and [ISmsSender]: the driver is chosen by config, and no
 * caller changes when it does. Returning [SendPushResult] rather than void is
 * the one difference — push is the only channel whose provider tells us an
 * address has gone dead, and dropping that on the floor would leave the token
 * table growing forever.
 */
export interface IPushSender {
  send(input: SendPushInput): Promise<SendPushResult>;
}
