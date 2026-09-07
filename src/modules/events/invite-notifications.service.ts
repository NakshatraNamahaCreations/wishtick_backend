import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';

/**
 * Where an invitation lives on the web.
 *
 * This used to send the invitation too, by email or SMS. It does not any more:
 * an invite is addressed to a WishMate, who is told in the app, and everybody
 * else arrives through a share link the host sends by whatever means they
 * already use. What is left is the one thing both paths still need — the URL
 * that a token resolves to, used for the host's copyable link and for the
 * link preview crawlers see.
 */
@Injectable()
export class InviteNotificationsService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  inviteUrl(token: string): string {
    const webUrl = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
    return `${webUrl}/i/${token}`;
  }
}
