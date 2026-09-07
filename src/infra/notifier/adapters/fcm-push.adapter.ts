import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';
import type { AppConfig } from 'src/config/configuration';
import type { IPushSender, SendPushInput, SendPushResult } from '../push.port';

/** Google mints access tokens for an hour; refresh a little early. */
const TOKEN_TTL_SECONDS = 3_600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * FCM HTTP v1, selected when `PUSH_DRIVER=fcm`.
 *
 * Signs a service-account JWT and exchanges it for an access token rather than
 * pulling in `firebase-admin`: the whole of that SDK for one authenticated POST
 * is a poor trade, and the v1 send contract is three fields.
 *
 * > **The network path here has never run.** It is written against the
 * > documented v1 contract, but this project has no Firebase credentials, so
 * > nothing has exercised a real send. Treat the first deploy with
 * > `PUSH_DRIVER=fcm` as the point where it is actually tested — the token
 * > registry, the channel plumbing, and the unregistered-token pruning around
 * > it *are* covered.
 */
@Injectable()
export class FcmPushAdapter implements IPushSender {
  private readonly logger = new Logger('Push:FCM');
  private readonly projectId: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(config: ConfigService<AppConfig, true>) {
    const fcm = config.get('delivery.fcm', { infer: true });
    this.projectId = fcm.projectId;
    this.clientEmail = fcm.clientEmail;
    // Env vars cannot hold real newlines, so the key is stored with `\n`
    // escapes; without this the PEM is one line and signing fails.
    this.privateKey = fcm.privateKey.replace(/\\n/g, '\n');
  }

  async send(input: SendPushInput): Promise<SendPushResult> {
    if (input.tokens.length === 0) return { sent: 0, unregistered: [] };

    const accessToken = await this.authorize();
    const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;
    const unregistered: string[] = [];
    let sent = 0;

    // v1 has no multicast: one request per token. A person's device count is
    // small, and doing them in sequence keeps one dead token from failing the
    // rest.
    for (const token of input.tokens) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: input.title, body: input.body },
            data: input.data ?? {},
          },
        }),
      });

      if (res.ok) {
        sent += 1;
        continue;
      }
      // 404 UNREGISTERED / 400 INVALID_ARGUMENT on the token mean this address
      // is dead for good; anything else is transient and worth a retry.
      if (res.status === 404 || res.status === 400) {
        unregistered.push(token);
        continue;
      }
      throw new Error(`FCM returned ${res.status} ${res.statusText}`);
    }

    if (unregistered.length > 0) {
      this.logger.debug(`FCM reported ${unregistered.length} dead token(s)`);
    }
    return { sent, unregistered };
  }

  /** A cached OAuth access token, minted from the service-account key. */
  private async authorize(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = FcmPushAdapter.base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = FcmPushAdapter.base64url(
      JSON.stringify({
        iss: this.clientEmail,
        scope: SCOPE,
        aud: OAUTH_URL,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
      }),
    );
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(this.privateKey, 'base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
    });
    if (!res.ok) {
      throw new Error(`FCM auth returned ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FCM auth returned no access_token');

    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + (body.expires_in ?? TOKEN_TTL_SECONDS) * 1_000;
    return this.accessToken;
  }

  private static base64url(value: string): string {
    return Buffer.from(value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
}
