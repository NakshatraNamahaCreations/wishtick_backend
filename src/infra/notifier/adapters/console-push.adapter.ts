import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';
import type { IPushSender, SendPushInput, SendPushResult } from '../push.port';

/**
 * The dev default: logs what would have been pushed and reports success.
 *
 * Deliberately not a throw. Push is the one channel whose credentials belong to
 * a Firebase project we may not have yet, and a notification whose *other*
 * channels are fine should not fail its whole dispatch because nobody has set
 * FIREBASE_* — so this no-ops loudly instead. Swap to FCM by setting
 * `PUSH_DRIVER=fcm`; no calling code changes.
 */
@Injectable()
export class ConsolePushAdapter implements IPushSender {
  private readonly logger = new Logger('Push');
  private warnedInProduction = false;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  send(input: SendPushInput): Promise<SendPushResult> {
    // Unlike the console mailer this does not throw in production — see the
    // class doc — but it says so, once, loudly enough to notice in a log.
    if (this.config.get('app.isProduction', { infer: true }) && !this.warnedInProduction) {
      this.warnedInProduction = true;
      this.logger.warn(
        'Push is not configured (PUSH_DRIVER is not "fcm"). Notifications are ' +
          'being delivered on their other channels only.',
      );
    }
    this.logger.log(
      `\n──────── PUSH ────────\nTo: ${input.tokens.length} device(s)\n` +
        `${input.title}\n${input.body}\n──────────────────────`,
    );
    return Promise.resolve({ sent: input.tokens.length, unregistered: [] });
  }
}
