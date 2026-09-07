import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AuthService } from 'src/modules/auth/auth.service';
import { ErrorCode } from 'src/common/errors/error-codes';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}
interface Actor {
  token: string;
  userId: string;
}

describe('Hardening & launch readiness (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let connection: Connection;
  let seq = 0;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const server = (): Server => app.getHttpServer() as Server;

  const newUser = async (): Promise<Actor> => {
    const email = `harden-${++seq}.${Date.now()}@example.com`;
    const { user, tokens } = await authService.signup(
      { email, password: PASSWORD, name: `User ${seq}` },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    authService = app.get(AuthService);
    connection = app.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Security headers (helmet) ────────────────────────────────────────────────

  describe('security headers', () => {
    it('sets helmet hardening headers on API responses', async () => {
      const res = await request(server()).get(`${V1}/onboarding/options`).expect(200);
      // The reliably-set helmet signals: MIME-sniffing off, framing locked down,
      // and the framework fingerprint stripped.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']?.toLowerCase()).toBe('sameorigin');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('gzip-compresses a large response when the client accepts it', async () => {
      const res = await request(server())
        .get(`${V1}/onboarding/options`)
        .set('Accept-Encoding', 'gzip')
        .expect(200);
      // The taxonomy payload is well over the 1 KB compression threshold.
      expect(res.headers['content-encoding']).toBe('gzip');
    });
  });

  // ── NoSQL operator-injection defence ─────────────────────────────────────────

  describe('NoSQL injection defence', () => {
    it('rejects an operator object in a public login body before it reaches a query', async () => {
      const res = await request(server())
        .post(`${V1}/auth/login`)
        .send({ identifier: { $ne: null }, password: { $ne: null } })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.SUSPECT_INPUT_REJECTED);
    });

    it('rejects a nested operator in an authenticated body, before auth or validation', async () => {
      const user = await newUser();
      // The guard is the first global guard, so it fires even ahead of JwtAuthGuard
      // and the ValidationPipe — a $-key never reaches a query.
      const res = await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(user.token))
        .send({ title: { $ne: null }, visibility: WishlistVisibility.PRIVATE })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.SUSPECT_INPUT_REJECTED);
    });

    it('still accepts a normal request with a $ inside a value', async () => {
      const user = await newUser();
      // "$5 gift card" — a dollar sign in a value must not trip the guard.
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(user.token))
        .send({ title: 'Budget: $5 and up', visibility: WishlistVisibility.PRIVATE })
        .expect(201);
    });
  });

  // ── GDPR data export ─────────────────────────────────────────────────────────

  describe('GET /me/export', () => {
    it('returns the caller’s data across domains and none of another user’s', async () => {
      const alice = await newUser();
      const bob = await newUser();

      // Alice owns a wishlist; Bob owns his own.
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(alice.token))
        .send({ title: 'Alice list', visibility: WishlistVisibility.PRIVATE })
        .expect(201);
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(bob.token))
        .send({ title: 'Bob secret list', visibility: WishlistVisibility.PRIVATE })
        .expect(201);

      const exp = (
        await request(server()).get(`${V1}/me/export`).set(auth(alice.token)).expect(200)
      ).body as Envelope<{
        meta: { userId: string };
        account: { _id: string; email: string; passwordHash?: string } | null;
        wishlists: { _id: string; title: string }[];
      }>;

      // It is Alice's export, with Alice's account…
      expect(exp.data.meta.userId).toBe(alice.userId);
      expect(exp.data.account?.email).toBeTruthy();
      // …secrets redacted…
      expect(exp.data.account?.passwordHash).toBeUndefined();
      // …her wishlist present…
      const titles = exp.data.wishlists.map((w) => w.title);
      expect(titles).toContain('Alice list');
      // …and nothing of Bob's.
      expect(titles).not.toContain('Bob secret list');
    });

    it('is bearer-protected', async () => {
      await request(server()).get(`${V1}/me/export`).expect(401);
    });
  });

  // ── Retention: every user store is TTL-bounded ───────────────────────────────

  describe('retention TTL indexes', () => {
    const hasTtl = async (collection: string): Promise<boolean> => {
      const indexes = (await connection.collection(collection).indexes()) as {
        expireAfterSeconds?: number;
      }[];
      return indexes.some((i) => typeof i.expireAfterSeconds === 'number');
    };

    it('bounds notifications, analytics events, and refresh tokens with a TTL', async () => {
      expect(await hasTtl('notifications')).toBe(true); // closed in Sprint 12
      expect(await hasTtl('analytics_events')).toBe(true);
      expect(await hasTtl('refresh_tokens')).toBe(true);
    });
  });
});
