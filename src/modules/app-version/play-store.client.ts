import { createSign } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from 'src/config/configuration';

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const TOKEN_TTL_SECONDS = 3_600;
const REQUEST_TIMEOUT_MS = 15_000;

/** Play allows 500 characters of release notes per language. */
export const RELEASE_NOTES_MAX = 500;

/** Version names people read: "1.0.2", "1.0.2-beta". */
const VERSION_NAME = /^\d+(\.\d+){0,3}([-+][\w.]+)?$/;

/** One release on a Play track, reduced to what the update prompt needs. */
export interface PlayRelease {
  versionCode: number;
  /** From the release's name: Play names it "3 (1.0.2)" unless renamed. */
  versionName: string | null;
  /** `completed` is out to everyone; `inProgress` is a staged rollout. */
  status: string;
  /** The share a staged rollout has reached, 0 to 1. Null when completed. */
  userFraction: number | null;
  /** The English "What's new" text, if the release has one. */
  notes: string | null;
}

/** A failure worth showing an admin as it is: no stack, no secrets. */
export class PlayStoreError extends Error {}

interface TrackJson {
  releases?: {
    name?: string;
    versionCodes?: string[];
    status?: string;
    userFraction?: number;
    releaseNotes?: { language?: string; text?: string }[];
  }[];
}

/**
 * Reads Google Play's production track through the Play Developer API, with
 * a read-only service account. It never writes: the edit it opens to read
 * the track is deleted, not committed.
 */
@Injectable()
export class PlayStoreClient {
  private readonly logger = new Logger('PlayStore');
  private readonly packageName: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(config: ConfigService<AppConfig, true>) {
    const play = config.get('playStore', { infer: true });
    this.packageName = play.packageName;
    this.clientEmail = play.clientEmail;
    // Env vars cannot hold real newlines, so the key is stored with `\n`
    // escapes, as the push key is.
    this.privateKey = play.privateKey.replace(/\\n/g, '\n');
  }

  /** Whether a service account has been set up at all. */
  get configured(): boolean {
    return Boolean(this.clientEmail && this.privateKey);
  }

  /** Every release on the production track, as Play has them now. */
  async productionReleases(): Promise<PlayRelease[]> {
    if (!this.configured) throw new PlayStoreError('Google Play is not connected');
    const token = await this.authorize();
    const app = `${API}/${encodeURIComponent(this.packageName)}`;
    const headers = { Authorization: `Bearer ${token}` };

    // Tracks are only readable inside an edit, Play's draft of a change.
    const edit = await this.call<{ id?: string }>(`${app}/edits`, { method: 'POST', headers });
    if (!edit.id) throw new PlayStoreError('Google Play did not open an edit');
    const editUrl = `${app}/edits/${encodeURIComponent(edit.id)}`;
    try {
      const track = await this.call<TrackJson>(`${editUrl}/tracks/production`, { headers });
      return (track.releases ?? []).flatMap((r) => PlayStoreClient.release(r));
    } finally {
      // Never committed. Deleted so it does not sit in the Console as a draft;
      // Play also drops idle edits on its own, so a failure here is harmless.
      await fetch(editUrl, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => undefined);
    }
  }

  /** One release per build: a release can carry several version codes. */
  private static release(r: NonNullable<TrackJson['releases']>[number]): PlayRelease[] {
    const codes = (r.versionCodes ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (codes.length === 0) return [];
    return [
      {
        versionCode: Math.max(...codes),
        versionName: PlayStoreClient.versionName(r.name),
        status: r.status ?? 'unknown',
        userFraction: typeof r.userFraction === 'number' ? r.userFraction : null,
        notes: PlayStoreClient.notes(r.releaseNotes),
      },
    ];
  }

  /** "3 (1.0.2)" is 1.0.2; a release renamed "1.0.2" is too; anything else, none. */
  static versionName(name: string | undefined): string | null {
    const trimmed = (name ?? '').trim();
    const inBrackets = /\(([^()]+)\)\s*$/.exec(trimmed)?.[1]?.trim();
    if (inBrackets && VERSION_NAME.test(inBrackets)) return inBrackets;
    return VERSION_NAME.test(trimmed) ? trimmed : null;
  }

  /** English first (en-US, then en-IN, then any en), else whatever there is. */
  static notes(notes: { language?: string; text?: string }[] | undefined): string | null {
    const list = (notes ?? []).filter((n) => n.text?.trim());
    const pick =
      list.find((n) => n.language === 'en-US') ??
      list.find((n) => n.language === 'en-IN') ??
      list.find((n) => n.language?.startsWith('en')) ??
      list[0];
    const text = pick?.text?.trim();
    return text ? text.slice(0, RELEASE_NOTES_MAX) : null;
  }

  private async call<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new PlayStoreError('Could not reach Google Play');
    }
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    this.logger.warn(`Play API ${res.status}: ${body?.error?.message ?? res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      throw new PlayStoreError(
        'Google Play refused the service account. Check it is invited to the Play Console with "View app information".',
      );
    }
    if (res.status === 404) {
      throw new PlayStoreError(`Google Play has no app ${this.packageName}`);
    }
    throw new PlayStoreError(`Google Play answered ${res.status}`);
  }

  /** A cached OAuth access token, minted from the service-account key. */
  private async authorize(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const now = Math.floor(Date.now() / 1000);
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64(
      JSON.stringify({
        iss: this.clientEmail,
        scope: SCOPE,
        aud: OAUTH_URL,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
      }),
    );
    let signature: string;
    try {
      signature = createSign('RSA-SHA256')
        .update(`${header}.${claims}`)
        .sign(this.privateKey, 'base64url');
    } catch {
      throw new PlayStoreError('PLAY_PRIVATE_KEY is not a valid private key');
    }

    let res: Response;
    try {
      res = await fetch(OAUTH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${header}.${claims}.${signature}`,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PlayStoreError('Could not reach Google to sign in');
    }
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || !body.access_token) {
      throw new PlayStoreError(
        'Google refused the service account key. Check PLAY_CLIENT_EMAIL and PLAY_PRIVATE_KEY.',
      );
    }
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + (body.expires_in ?? TOKEN_TTL_SECONDS) * 1_000;
    return this.accessToken;
  }
}
