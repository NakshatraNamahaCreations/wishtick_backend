import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from 'src/common/errors/error-codes';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

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

interface AuthPayload {
  user: { id: string; email?: string; emailVerified: boolean };
  tokens: TokenPair;
}

describe('Auth (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let emailCounter = 0;

  const uniqueEmail = (): string => `user${++emailCounter}.${Date.now()}@example.com`;

  const signup = (email: string, password = PASSWORD) =>
    request(app.getHttpServer()).post(`${V1}/auth/signup`).send({ email, password });

  const login = (identifier: string, password = PASSWORD) =>
    request(app.getHttpServer()).post(`${V1}/auth/login`).send({ identifier, password });

  const refresh = (refreshToken: string) =>
    request(app.getHttpServer()).post(`${V1}/auth/refresh`).send({ refreshToken });

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  // Rate-limit buckets are deliberately tight (5 signups/hour, 5 logins/min),
  // so without a per-test reset the suite would throttle itself and every test
  // after the fifth would fail for the wrong reason.
  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Exit criterion: full signup → verify → login → refresh → logout ────────

  describe('the full authentication cycle', () => {
    it('carries a user from signup through verification, login, refresh, and logout', async () => {
      const email = uniqueEmail();

      // 1. Signup issues a usable session immediately.
      const signupRes = await signup(email).expect(201);
      const signupBody = signupRes.body as Envelope<AuthPayload>;
      expect(signupBody.success).toBe(true);
      expect(signupBody.data.user.email).toBe(email);
      expect(signupBody.data.user.emailVerified).toBe(false);
      expect(signupBody.data.tokens.accessToken).toBeTruthy();

      // 2. A verification code was actually dispatched.
      expect(ctx.mailer.sent).toHaveLength(1);
      const code = ctx.mailer.lastCode();

      // 3. Verifying flips the flag.
      await request(app.getHttpServer())
        .post(`${V1}/auth/verify/email/confirm`)
        .send({ email, code })
        .expect(200);

      // 4. Login works and now reports the account as verified.
      const loginRes = await login(email).expect(200);
      const loginBody = loginRes.body as Envelope<AuthPayload>;
      expect(loginBody.data.user.emailVerified).toBe(true);
      const { accessToken, refreshToken } = loginBody.data.tokens;

      // 5. The access token authenticates a protected route.
      const meRes = await request(app.getHttpServer())
        .get(`${V1}/auth/me`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect((meRes.body as Envelope<{ email: string }>).data.email).toBe(email);

      // 6. Refresh returns a genuinely new pair, not the same one echoed back.
      const refreshRes = await refresh(refreshToken).expect(200);
      const rotated = (refreshRes.body as Envelope<TokenPair>).data;
      expect(rotated.refreshToken).not.toBe(refreshToken);
      expect(rotated.accessToken).toBeTruthy();

      // 7. Logout ends the session.
      await request(app.getHttpServer())
        .post(`${V1}/auth/logout`)
        .set('Authorization', `Bearer ${rotated.accessToken}`)
        .expect(204);

      // 8. The logged-out access token is denylisted immediately.
      const afterLogout = await request(app.getHttpServer())
        .get(`${V1}/auth/me`)
        .set('Authorization', `Bearer ${rotated.accessToken}`)
        .expect(401);
      expect((afterLogout.body as Envelope<never>).error?.code).toBe(ErrorCode.TOKEN_REVOKED);

      // 9. And its refresh token can no longer mint new ones.
      await refresh(rotated.refreshToken).expect(401);
    });

    it('signs up with a phone number and verifies over SMS', async () => {
      const phone = `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

      await request(app.getHttpServer())
        .post(`${V1}/auth/signup`)
        .send({ phone, password: PASSWORD })
        .expect(201);

      expect(ctx.sms.sent).toHaveLength(1);
      await request(app.getHttpServer())
        .post(`${V1}/auth/verify/phone/confirm`)
        .send({ phone, code: ctx.sms.lastCode() })
        .expect(200);

      await login(phone).expect(200);
    });

    it('rejects a signup with neither an email nor a phone number', async () => {
      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/signup`)
        .send({ password: PASSWORD })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.IDENTIFIER_REQUIRED);
    });

    it('rejects a duplicate email', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      const res = await signup(email).expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);
    });

    it('strips unknown fields so a client cannot self-assign a role', async () => {
      // forbidNonWhitelisted makes mass-assignment a 400 rather than a silent drop.
      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/signup`)
        .send({ email: uniqueEmail(), password: PASSWORD, roles: ['admin'] })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('gives the same error for a wrong password and an unknown account', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);

      const wrongPassword = await login(email, 'definitely-not-the-password').expect(401);
      const unknownUser = await login(uniqueEmail()).expect(401);

      // Identical code and message: the login endpoint must not enumerate accounts.
      expect((wrongPassword.body as Envelope<never>).error?.code).toBe(
        ErrorCode.INVALID_CREDENTIALS,
      );
      expect((unknownUser.body as Envelope<never>).error?.message).toBe(
        (wrongPassword.body as Envelope<never>).error?.message,
      );
    });

    it('rejects a weak password even when it is long enough', async () => {
      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/signup`)
        .send({ email: uniqueEmail(), password: 'password123' })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.WEAK_PASSWORD);
    });

    it('requires authentication on protected routes by default', async () => {
      await request(app.getHttpServer()).get(`${V1}/auth/me`).expect(401);
    });
  });

  // ── Exit criterion: refresh-token reuse revokes the whole family ───────────

  describe('refresh token reuse detection', () => {
    it('revokes the entire family when a rotated token is replayed', async () => {
      const email = uniqueEmail();
      const signupBody = (await signup(email).expect(201)).body as Envelope<AuthPayload>;
      const original = signupBody.data.tokens.refreshToken;

      // Legitimate rotation.
      const rotated = ((await refresh(original).expect(200)).body as Envelope<TokenPair>).data;

      // The attacker replays the token the real client already discarded.
      const replay = await refresh(original).expect(401);
      expect((replay.body as Envelope<never>).error?.code).toBe(ErrorCode.REFRESH_TOKEN_REUSED);

      // The victim's freshly-issued token is now dead too — that is the point.
      // We cannot tell victim from thief, so the whole family goes.
      const victim = await refresh(rotated.refreshToken).expect(401);
      expect((victim.body as Envelope<never>).error?.code).toBe(ErrorCode.TOKEN_REVOKED);

      // Logging back in works and is unaffected by the revocation.
      await login(email).expect(200);
    });

    it('survives a rotation chain without false-positive reuse detection', async () => {
      const email = uniqueEmail();
      const signupBody = (await signup(email).expect(201)).body as Envelope<AuthPayload>;

      // A long-lived client rotates many times; none of these are reuse.
      let token = signupBody.data.tokens.refreshToken;
      for (let i = 0; i < 5; i++) {
        const res = await refresh(token).expect(200);
        token = (res.body as Envelope<TokenPair>).data.refreshToken;
      }
      await refresh(token).expect(200);
    });

    it('rejects a forged refresh token', async () => {
      const res = await refresh(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmb3JnZWQiLCJzaWQiOiJ4IiwianRpIjoieSJ9.bogus',
      ).expect(401);
      expect([ErrorCode.TOKEN_INVALID, ErrorCode.UNAUTHENTICATED]).toContain(
        (res.body as Envelope<never>).error?.code,
      );
    });

    it('does not revoke other devices when one session is replayed', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);

      // Two independent logins == two families.
      const deviceA = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data.tokens;
      const deviceB = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data.tokens;

      await refresh(deviceA.refreshToken).expect(200);
      await refresh(deviceA.refreshToken).expect(401); // reuse on A

      // B is a different family and must be untouched.
      await refresh(deviceB.refreshToken).expect(200);
    });
  });

  // ── Exit criterion: brute-force on login is blocked ────────────────────────

  describe('login brute-force protection', () => {
    // These assert the REAL production bucket from AuthController
    // (LOGIN_THROTTLE = 5 per minute), not a limit invented for the test.
    // A synthetic limit would still pass if the decorator were mis-wired.
    it('blocks repeated failed logins with 429 once the bucket is empty', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);

      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await login(email, `wrong-guess-${i}`);
        statuses.push(res.status);
      }

      // First 5 get a real answer (401), the rest are refused unread.
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    });

    it('refuses the correct password too once the bucket is empty', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);

      for (let i = 0; i < 5; i++) {
        await login(email, `wrong-guess-${i}`).expect(401);
      }

      // Fails closed. An attacker who exhausts the bucket cannot then try the
      // real password and get in — and the code says RATE_LIMITED, not
      // INVALID_CREDENTIALS, so a legitimate user is told to wait rather than
      // being told their own password is wrong.
      const blocked = await login(email, PASSWORD).expect(429);
      expect((blocked.body as Envelope<never>).error?.code).toBe(ErrorCode.RATE_LIMITED);
    });
  });

  // ── Exit criterion: OTP flood is blocked ──────────────────────────────────

  describe('OTP abuse protection', () => {
    it('burns the code after too many wrong attempts', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      const realCode = ctx.mailer.lastCode();

      // OTP_MAX_ATTEMPTS is 5 in the test env.
      for (let i = 0; i < 4; i++) {
        const res = await request(app.getHttpServer())
          .post(`${V1}/auth/verify/email/confirm`)
          .send({ email, code: '000000' })
          .expect(400);
        expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.OTP_INVALID);
      }

      const fifth = await request(app.getHttpServer())
        .post(`${V1}/auth/verify/email/confirm`)
        .send({ email, code: '000000' })
        .expect(429);
      expect((fifth.body as Envelope<never>).error?.code).toBe(ErrorCode.OTP_MAX_ATTEMPTS);

      // The genuine code is dead too — the whole point of burning it.
      const withRealCode = await request(app.getHttpServer())
        .post(`${V1}/auth/verify/email/confirm`)
        .send({ email, code: realCode })
        .expect(400);
      expect((withRealCode.body as Envelope<never>).error?.code).toBe(ErrorCode.OTP_EXPIRED);
    });

    it('rate-limits repeated code requests', async () => {
      // Asserts the real OTP_THROTTLE bucket (3 per 5 minutes). Each request
      // past it would otherwise be a billable SMS or email.
      const email = uniqueEmail();
      await signup(email).expect(201);

      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await request(app.getHttpServer())
          .post(`${V1}/auth/verify/email/request`)
          .send({ email });
        statuses.push(res.status);
      }

      expect(statuses.filter((s) => s === 202)).toHaveLength(3);
      expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    });

    it('does not reveal whether an email is registered when requesting a code', async () => {
      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/verify/email/request`)
        .send({ email: 'nobody.here@example.com' })
        .expect(202);
      expect((res.body as Envelope<{ message: string }>).data.message).toContain('If that email');
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it('rejects a code issued for a different address', async () => {
      const emailA = uniqueEmail();
      const emailB = uniqueEmail();
      await signup(emailA).expect(201);
      const codeForA = ctx.mailer.lastCode();
      await signup(emailB).expect(201);

      // Codes are salted per identifier, so A's code is meaningless for B.
      await request(app.getHttpServer())
        .post(`${V1}/auth/verify/email/confirm`)
        .send({ email: emailB, code: codeForA })
        .expect((res) => {
          if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
        });
    });
  });

  // ── Sessions ──────────────────────────────────────────────────────────────

  describe('session management', () => {
    it('lists one session per device and marks the current one', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);

      await login(email).expect(200);
      const current = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data;

      const res = await request(app.getHttpServer())
        .get(`${V1}/auth/sessions`)
        .set('Authorization', `Bearer ${current.tokens.accessToken}`)
        .expect(200);

      const sessions = (res.body as Envelope<{ id: string; current: boolean }[]>).data;
      // signup + 2 logins = 3 families.
      expect(sessions).toHaveLength(3);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);
    });

    it('collapses a rotated family into a single session row', async () => {
      const email = uniqueEmail();
      const tokens = ((await signup(email).expect(201)).body as Envelope<AuthPayload>).data.tokens;

      // Rotating three times creates four token documents in one family.
      let token = tokens.refreshToken;
      for (let i = 0; i < 3; i++) {
        token = ((await refresh(token).expect(200)).body as Envelope<TokenPair>).data.refreshToken;
      }

      const res = await request(app.getHttpServer())
        .get(`${V1}/auth/sessions`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      // A user thinks in devices, not tokens.
      expect((res.body as Envelope<unknown[]>).data).toHaveLength(1);
    });

    it('revokes a single session without touching the others', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      const victim = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data;
      const survivor = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data;

      const sessions = (
        (
          await request(app.getHttpServer())
            .get(`${V1}/auth/sessions`)
            .set('Authorization', `Bearer ${survivor.tokens.accessToken}`)
            .expect(200)
        ).body as Envelope<{ id: string; current: boolean }[]>
      ).data;

      const victimSession = sessions.find((s) => !s.current);
      expect(victimSession).toBeDefined();

      await request(app.getHttpServer())
        .delete(`${V1}/auth/sessions/${victimSession!.id}`)
        .set('Authorization', `Bearer ${survivor.tokens.accessToken}`)
        .expect(204);

      // The revoked family can no longer refresh...
      const revokedFamily = [victim.tokens.refreshToken, survivor.tokens.refreshToken];
      const results = await Promise.all(revokedFamily.map((t) => refresh(t)));
      expect(results.some((r) => r.status === 401)).toBe(true);
      expect(results.some((r) => r.status === 200)).toBe(true);
    });

    it('logout-all kills every session and every outstanding access token', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      const deviceA = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data;
      const deviceB = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data;

      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/logout-all`)
        .set('Authorization', `Bearer ${deviceB.tokens.accessToken}`)
        .expect(200);
      expect((res.body as Envelope<{ sessionsRevoked: number }>).data.sessionsRevoked).toBe(3);

      // A's access token was never presented here, yet it must die too — that is
      // what tokensInvalidBefore buys us over a per-jti denylist.
      const stale = await request(app.getHttpServer())
        .get(`${V1}/auth/me`)
        .set('Authorization', `Bearer ${deviceA.tokens.accessToken}`)
        .expect(401);
      expect((stale.body as Envelope<never>).error?.code).toBe(ErrorCode.TOKEN_REVOKED);

      await refresh(deviceA.tokens.refreshToken).expect(401);
      await refresh(deviceB.tokens.refreshToken).expect(401);
    });
  });

  // ── Password reset ────────────────────────────────────────────────────────

  describe('password reset', () => {
    it('resets the password, invalidates the old one, and ends every session', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      const session = ((await login(email).expect(200)).body as Envelope<AuthPayload>).data;

      ctx.mailer.reset();
      await request(app.getHttpServer())
        .post(`${V1}/auth/password/forgot`)
        .send({ identifier: email })
        .expect(202);

      const token = ctx.mailer.lastResetToken();
      const newPassword = 'an-entirely-different-passphrase';

      await request(app.getHttpServer())
        .post(`${V1}/auth/password/reset`)
        .send({ token, password: newPassword })
        .expect(200);

      // Old password no longer works; new one does.
      await login(email, PASSWORD).expect(401);
      await login(email, newPassword).expect(200);

      // Existing sessions are gone — a reset is how a victim evicts an attacker,
      // so leaving the attacker's session alive would defeat the whole feature.
      await refresh(session.tokens.refreshToken).expect(401);
      const stale = await request(app.getHttpServer())
        .get(`${V1}/auth/me`)
        .set('Authorization', `Bearer ${session.tokens.accessToken}`)
        .expect(401);
      expect((stale.body as Envelope<never>).error?.code).toBe(ErrorCode.TOKEN_REVOKED);
    });

    it('rejects a reused reset token', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      ctx.mailer.reset();

      await request(app.getHttpServer())
        .post(`${V1}/auth/password/forgot`)
        .send({ identifier: email })
        .expect(202);
      const token = ctx.mailer.lastResetToken();

      await request(app.getHttpServer())
        .post(`${V1}/auth/password/reset`)
        .send({ token, password: 'first-new-passphrase-here' })
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(`${V1}/auth/password/reset`)
        .send({ token, password: 'second-new-passphrase-here' })
        .expect(400);
      expect((second.body as Envelope<never>).error?.code).toBe(ErrorCode.RESET_TOKEN_INVALID);
    });

    it('invalidates an older reset token when a newer one is requested', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      ctx.mailer.reset();

      await request(app.getHttpServer())
        .post(`${V1}/auth/password/forgot`)
        .send({ identifier: email })
        .expect(202);
      const firstToken = ctx.mailer.lastResetToken();

      await request(app.getHttpServer())
        .post(`${V1}/auth/password/forgot`)
        .send({ identifier: email })
        .expect(202);
      const secondToken = ctx.mailer.lastResetToken();
      expect(secondToken).not.toBe(firstToken);

      // Only the newest link should work.
      await request(app.getHttpServer())
        .post(`${V1}/auth/password/reset`)
        .send({ token: firstToken, password: 'passphrase-from-old-link' })
        .expect(400);
      await request(app.getHttpServer())
        .post(`${V1}/auth/password/reset`)
        .send({ token: secondToken, password: 'passphrase-from-new-link' })
        .expect(200);
    });

    it('responds identically for a known and an unknown account', async () => {
      const email = uniqueEmail();
      await signup(email).expect(201);
      ctx.mailer.reset();

      const known = await request(app.getHttpServer())
        .post(`${V1}/auth/password/forgot`)
        .send({ identifier: email })
        .expect(202);
      const unknown = await request(app.getHttpServer())
        .post(`${V1}/auth/password/forgot`)
        .send({ identifier: 'ghost@example.com' })
        .expect(202);

      expect((known.body as Envelope<{ message: string }>).data.message).toBe(
        (unknown.body as Envelope<{ message: string }>).data.message,
      );
    });
  });

  // ── Response contract ─────────────────────────────────────────────────────

  describe('response envelope', () => {
    it('wraps successes and failures in their documented shapes', async () => {
      const ok = await signup(uniqueEmail()).expect(201);
      expect(ok.body).toMatchObject({ success: true, data: expect.any(Object) });
      expect(ok.body).toHaveProperty('requestId');

      const fail = await login('nobody@example.com').expect(401);
      expect(fail.body).toMatchObject({
        success: false,
        error: { code: ErrorCode.INVALID_CREDENTIALS, message: expect.any(String) },
      });
    });

    it('echoes an inbound x-request-id so a trace survives across services', async () => {
      const res = await request(app.getHttpServer())
        .get(`${V1}/auth/me`)
        .set('x-request-id', 'trace-me-123')
        .expect(401);
      expect(res.headers['x-request-id']).toBe('trace-me-123');
      expect((res.body as { requestId?: string }).requestId).toBe('trace-me-123');
    });
  });
});
