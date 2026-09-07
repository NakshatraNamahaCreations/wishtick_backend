import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from 'src/common/errors/error-codes';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

interface OtpLoginPayload {
  user: { id: string; phone?: string; name?: string; phoneVerified: boolean };
  tokens: TokenPair;
  isNewUser: boolean;
}

/**
 * Passwordless phone sign-in — the flow the Figma design specifies: enter a
 * number, receive a code, and land in the app with a session, whether or not an
 * account existed beforehand.
 */
describe('Passwordless OTP sign-in (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let phoneCounter = 0;

  // Distinct per test so one test's cooldown never bleeds into the next.
  const uniquePhone = (): string => `+9198765${String(10000 + ++phoneCounter).slice(-5)}`;

  const requestCode = (phone: string) =>
    request(app.getHttpServer()).post(`${V1}/auth/otp/request`).send({ phone });

  const verifyCode = (phone: string, code: string, extra: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(`${V1}/auth/otp/verify`)
      .send({ phone, code, ...extra });

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  describe('first-time sign-in', () => {
    it('creates a verified, passwordless account and returns a session', async () => {
      const phone = uniquePhone();

      const requested = await requestCode(phone).expect(202);
      expect(
        (requested.body as Envelope<{ expiresInSeconds: number }>).data.expiresInSeconds,
      ).toBeGreaterThan(0);
      expect(ctx.sms.sent).toHaveLength(1);

      // Outside production the response echoes the code it just sent by SMS —
      // lets the app show it inline instead of the tester reading it off a
      // console log. Must match the code that actually verifies the sign-in.
      expect((requested.body as Envelope<{ devCode?: string }>).data.devCode).toBe(
        ctx.sms.lastCode(),
      );

      const res = await verifyCode(phone, ctx.sms.lastCode(), { name: 'Ananya' }).expect(200);
      const body = res.body as Envelope<OtpLoginPayload>;

      expect(body.data.isNewUser).toBe(true);
      expect(body.data.user.phone).toBe(phone);
      expect(body.data.user.name).toBe('Ananya');
      // Possession of the number was just proven, so it starts out verified.
      expect(body.data.user.phoneVerified).toBe(true);
      expect(body.data.tokens.accessToken).toBeTruthy();
    });

    it('issues a session that authenticates against /auth/me', async () => {
      const phone = uniquePhone();
      await requestCode(phone).expect(202);
      const res = await verifyCode(phone, ctx.sms.lastCode()).expect(200);
      const { tokens } = (res.body as Envelope<OtpLoginPayload>).data;

      const me = await request(app.getHttpServer())
        .get(`${V1}/auth/me`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect((me.body as Envelope<{ phone?: string }>).data.phone).toBe(phone);
    });
  });

  describe('returning sign-in', () => {
    it('signs the same account back in rather than creating a second one', async () => {
      const phone = uniquePhone();

      await requestCode(phone).expect(202);
      const first = await verifyCode(phone, ctx.sms.lastCode(), { name: 'Ananya' }).expect(200);
      const firstBody = (first.body as Envelope<OtpLoginPayload>).data;

      await ctx.reset();
      await requestCode(phone).expect(202);
      const second = await verifyCode(phone, ctx.sms.lastCode()).expect(200);
      const secondBody = (second.body as Envelope<OtpLoginPayload>).data;

      expect(secondBody.isNewUser).toBe(false);
      expect(secondBody.user.id).toBe(firstBody.user.id);
      // The name from the first call is not overwritten by a later sign-in.
      expect(secondBody.user.name).toBe('Ananya');
    });
  });

  describe('code handling', () => {
    it('rejects a wrong code and reports the attempts left', async () => {
      const phone = uniquePhone();
      await requestCode(phone).expect(202);

      const res = await verifyCode(phone, '000000').expect(400);
      const body = res.body as Envelope<unknown>;

      expect(body.success).toBe(false);
      expect(body.error?.code).toBe(ErrorCode.OTP_INVALID);
      expect(body.error?.details).toMatchObject({ attemptsRemaining: expect.any(Number) });
    });

    it('refuses to reuse a code', async () => {
      const phone = uniquePhone();
      await requestCode(phone).expect(202);
      const code = ctx.sms.lastCode();

      await verifyCode(phone, code).expect(200);
      // Consumed on success, so a replay finds nothing.
      const replay = await verifyCode(phone, code).expect(400);
      expect((replay.body as Envelope<unknown>).error?.code).toBe(ErrorCode.OTP_EXPIRED);
    });

    it('rejects a verification for a number that never requested one', async () => {
      const res = await verifyCode(uniquePhone(), '123456').expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.OTP_EXPIRED);
    });

    it('leaves nothing for the separate phone-verification flow to do', async () => {
      const phone = uniquePhone();
      await requestCode(phone).expect(202);
      await verifyCode(phone, ctx.sms.lastCode()).expect(200);
      await ctx.reset();

      // Signing in already proved possession, so re-verifying is a no-op the
      // API refuses outright rather than spending another SMS on.
      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/verify/phone/request`)
        .send({ phone })
        .expect(409);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.ALREADY_VERIFIED);
      expect(ctx.sms.sent).toHaveLength(0);
    });

    // The resend cooldown lives in OtpService and is covered by its unit spec;
    // the e2e env sets OTP_RESEND_COOLDOWN_SECONDS=0 so suites can request codes
    // back-to-back, so asserting it here would test the test environment.
  });

  describe('accounts pending deletion', () => {
    it('explains the state instead of failing on a duplicate key', async () => {
      const phone = uniquePhone();
      await requestCode(phone).expect(202);
      const signIn = await verifyCode(phone, ctx.sms.lastCode()).expect(200);
      const { tokens } = (signIn.body as Envelope<OtpLoginPayload>).data;

      await request(app.getHttpServer())
        .delete(`${V1}/me`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);
      await ctx.reset();

      // The number is still held by the soft-deleted account, so a fresh
      // sign-in must not silently create a second one.
      await requestCode(phone).expect(202);
      const res = await verifyCode(phone, ctx.sms.lastCode()).expect(403);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.ACCOUNT_DELETED);
    });
  });

  describe('interaction with password login', () => {
    it('does not let a passwordless account log in with any password', async () => {
      const phone = uniquePhone();
      await requestCode(phone).expect(202);
      await verifyCode(phone, ctx.sms.lastCode()).expect(200);
      await ctx.reset();

      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/login`)
        .send({ identifier: phone, password: 'anything-at-all-here' })
        .expect(401);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    });
  });
});
