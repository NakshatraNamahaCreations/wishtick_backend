import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  ANONYMIZE_JOB,
  AccountLifecycleService,
  anonymizeJobId,
} from 'src/modules/profile/account-lifecycle.service';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

describe('Account lifecycle & dashboard (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let userModel: Model<UserDocument>;
  let lifecycle: AccountLifecycleService;
  let seq = 0;

  const uniqueEmail = (): string => `life${++seq}.${Date.now()}@example.com`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (): Promise<{
    token: string;
    refreshToken: string;
    email: string;
    userId: string;
  }> => {
    const email = uniqueEmail();
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const body = res.body as Envelope<{
      user: { id: string };
      tokens: { accessToken: string; refreshToken: string };
    }>;
    return {
      token: body.data.tokens.accessToken,
      refreshToken: body.data.tokens.refreshToken,
      email,
      userId: body.data.user.id,
    };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
    lifecycle = app.get(AccountLifecycleService);
  }, 90_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Exit criterion: soft delete hides the user everywhere, reversible 30d ──

  describe('DELETE /me', () => {
    it('hides the account from every query and ends every session', async () => {
      const { token, refreshToken, email } = await newUser();

      const res = await request(app.getHttpServer())
        .delete(`${V1}/me`)
        .set(auth(token))
        .send({ reason: 'Taking a break' })
        .expect(200);

      const receipt = (res.body as Envelope<{ deletedAt: string; restorableUntil: string }>).data;
      const graceDays =
        (new Date(receipt.restorableUntil).getTime() - new Date(receipt.deletedAt).getTime()) /
        (24 * 60 * 60 * 1_000);
      expect(Math.round(graceDays)).toBe(30);

      // A "deleted" account that still answers to a live token is not deleted
      // in any sense a user would recognise.
      await request(app.getHttpServer()).get(`${V1}/me`).set(auth(token)).expect(401);
      await request(app.getHttpServer())
        .post(`${V1}/auth/refresh`)
        .send({ refreshToken })
        .expect(401);

      // Invisible to login...
      const login = await request(app.getHttpServer())
        .post(`${V1}/auth/login`)
        .send({ identifier: email, password: PASSWORD })
        .expect(401);
      expect((login.body as Envelope<never>).error?.code).toBe(ErrorCode.INVALID_CREDENTIALS);

      // ...and to password reset, which must not email a deleted account.
      ctx.mailer.reset();
      await request(app.getHttpServer())
        .post(`${V1}/auth/password/forgot`)
        .send({ identifier: email })
        .expect(202);
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it('schedules exactly one anonymization job, delayed by the grace period', async () => {
      const { token, userId } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);

      const jobs = ctx.scheduler.jobsNamed(ANONYMIZE_JOB);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].opts.delay).toBe(30 * 24 * 60 * 60 * 1_000);
      // Deterministic id: re-requesting deletion cannot stack duplicates.
      expect(jobs[0].opts.jobId).toBe(anonymizeJobId(userId));
      // BullMQ rejects a custom job id containing ':' — see anonymizeJobId.
      expect(jobs[0].opts.jobId).not.toContain(':');
    });

    it('refuses a second deletion request', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);
      // The token is dead, so a second attempt cannot even authenticate —
      // which is itself the guarantee that no second job is queued.
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(401);
      expect(ctx.scheduler.jobsNamed(ANONYMIZE_JOB)).toHaveLength(1);
    });
  });

  describe('POST /auth/account/restore', () => {
    it('brings the account back inside the grace window', async () => {
      const { token, email } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);

      await request(app.getHttpServer())
        .post(`${V1}/auth/account/restore`)
        .send({ identifier: email, password: PASSWORD })
        .expect(200);

      // Fully usable again.
      const login = await request(app.getHttpServer())
        .post(`${V1}/auth/login`)
        .send({ identifier: email, password: PASSWORD })
        .expect(200);
      const newToken = (login.body as Envelope<{ tokens: { accessToken: string } }>).data.tokens
        .accessToken;
      await request(app.getHttpServer()).get(`${V1}/me`).set(auth(newToken)).expect(200);

      // And the pending erasure is called off.
      expect(ctx.scheduler.jobsNamed(ANONYMIZE_JOB)).toHaveLength(0);
      expect(ctx.scheduler.removed).toHaveLength(1);
    });

    it('refuses restore with the wrong password', async () => {
      const { token, email } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);

      // Otherwise anyone who knew an email could resurrect someone's account.
      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/account/restore`)
        .send({ identifier: email, password: 'not-the-password' })
        .expect(401);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    });

    it('gives the same answer for an unknown account and a live one', async () => {
      const { email } = await newUser();
      // Restoring a NOT-deleted account and an account that never existed must
      // be indistinguishable — this endpoint is unauthenticated by necessity,
      // so any difference is an oracle for who is pending deletion.
      const live = await request(app.getHttpServer())
        .post(`${V1}/auth/account/restore`)
        .send({ identifier: email, password: PASSWORD })
        .expect(401);
      const ghost = await request(app.getHttpServer())
        .post(`${V1}/auth/account/restore`)
        .send({ identifier: 'nobody@example.com', password: PASSWORD })
        .expect(401);

      expect((live.body as Envelope<never>).error?.message).toBe(
        (ghost.body as Envelope<never>).error?.message,
      );
    });

    it('refuses once the grace window has passed', async () => {
      const { token, email, userId } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);

      // Backdate the deletion past the window.
      await userModel.updateOne(
        { _id: userId },
        { $set: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000) } },
      );

      const res = await request(app.getHttpServer())
        .post(`${V1}/auth/account/restore`)
        .send({ identifier: email, password: PASSWORD })
        .expect(410);
      // Honest: the data is genuinely gone, and the caller proved they own it.
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.RESTORE_WINDOW_EXPIRED);
    });
  });

  // ── Anonymization ─────────────────────────────────────────────────────────

  describe('anonymization', () => {
    it('erases PII but keeps the row so references do not dangle', async () => {
      const { token, email, userId } = await newUser();
      await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set(auth(token))
        .send({ displayName: 'Aarav', bio: 'hello' })
        .expect(200);
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);

      const deletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
      await userModel.updateOne({ _id: userId }, { $set: { deletedAt } });

      const result = await lifecycle.anonymize({ userId, deletedAtIso: deletedAt.toISOString() });
      expect(result.anonymized).toBe(true);

      const row = await userModel.findById(userId).exec();
      expect(row).not.toBeNull();
      expect(row!.email).toBeUndefined();
      expect(row!.anonymizedAt).not.toBeNull();

      // The address is freed for reuse — the partial unique index filters on
      // $type: 'string', so an unset field no longer occupies it.
      await request(app.getHttpServer())
        .post(`${V1}/auth/signup`)
        .send({ email, password: PASSWORD })
        .expect(201);
    });

    it('does nothing to a restored account', async () => {
      const { token, email, userId } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);

      const deletedAt = (await userModel.findById(userId).exec())!.deletedAt!;
      await request(app.getHttpServer())
        .post(`${V1}/auth/account/restore`)
        .send({ identifier: email, password: PASSWORD })
        .expect(200);

      // A job that escapes cancellation must be harmless — this is the one
      // operation in the app with no undo.
      const result = await lifecycle.anonymize({ userId, deletedAtIso: deletedAt.toISOString() });
      expect(result).toEqual({ anonymized: false, reason: 'account-restored' });

      const row = await userModel.findById(userId).exec();
      expect(row!.email).toBe(email);
    });

    it('does nothing while the grace period is still running', async () => {
      const { token, userId } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);
      const deletedAt = (await userModel.findById(userId).exec())!.deletedAt!;

      // A job delivered early (clock skew, a manual replay) must not erase an
      // account whose window is still open.
      const result = await lifecycle.anonymize({ userId, deletedAtIso: deletedAt.toISOString() });
      expect(result).toEqual({ anonymized: false, reason: 'grace-period-active' });
    });

    it('does nothing when the account was deleted, restored, and deleted again', async () => {
      const { token, email, userId } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);
      const firstDeletedAt = (await userModel.findById(userId).exec())!.deletedAt!;

      await request(app.getHttpServer())
        .post(`${V1}/auth/account/restore`)
        .send({ identifier: email, password: PASSWORD })
        .expect(200);

      const login = await request(app.getHttpServer())
        .post(`${V1}/auth/login`)
        .send({ identifier: email, password: PASSWORD })
        .expect(200);
      const freshToken = (login.body as Envelope<{ tokens: { accessToken: string } }>).data.tokens
        .accessToken;
      await request(app.getHttpServer())
        .delete(`${V1}/me`)
        .set(auth(freshToken))
        .send({})
        .expect(200);

      // The stale job carries the FIRST deletedAt. Honouring it would erase the
      // account 30 days early, using the old clock.
      const result = await lifecycle.anonymize({
        userId,
        deletedAtIso: firstDeletedAt.toISOString(),
      });
      expect(result).toEqual({ anonymized: false, reason: 'deleted-at-changed' });
    });

    it('sweeps accounts the queue lost', async () => {
      const { token, userId } = await newUser();
      await request(app.getHttpServer()).delete(`${V1}/me`).set(auth(token)).send({}).expect(200);
      await userModel.updateOne(
        { _id: userId },
        { $set: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000) } },
      );

      // Safety net for jobs lost to a Redis flush or a queue migration.
      const swept = await lifecycle.sweepExpired();
      expect(swept).toBeGreaterThanOrEqual(1);
      expect((await userModel.findById(userId).exec())!.anonymizedAt).not.toBeNull();
    });
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  describe('GET /dashboard/summary', () => {
    it('returns all 12 sections with later sprints flagged unavailable', async () => {
      const { token } = await newUser();
      const res = await request(app.getHttpServer())
        .get(`${V1}/dashboard/summary`)
        .set(auth(token))
        .expect(200);

      const data = (
        res.body as Envelope<{
          sections: Record<string, { count: number; badge: number; available: boolean }>;
        }>
      ).data;

      expect(Object.keys(data.sections)).toHaveLength(12);
      // "Not built yet" must stay distinguishable from "you have none".
      expect(data.sections.myWishlists).toEqual({ count: 0, badge: 0, available: false });
      expect(data.sections.profileSettings.available).toBe(true);
    });

    it('reports profile completeness and what is missing', async () => {
      const { token } = await newUser();

      const empty = (
        await request(app.getHttpServer())
          .get(`${V1}/dashboard/summary`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ profile: { completeness: number; missingFields: string[] } }>;
      expect(empty.data.profile.completeness).toBe(0);
      expect(empty.data.profile.missingFields).toContain('interests');

      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(token))
        .send({ displayName: 'Aarav', dateOfBirth: '1995-04-17' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`${V1}/me/preferences`)
        .set(auth(token))
        .send({
          interests: ['ent_music'],
          giftCategories: ['books'],
          favouriteColors: ['blue_navy'],
          clothingSize: 'm',
        })
        .expect(200);

      // The cache is per-user with a 60s TTL, so bust it to read fresh.
      await ctx.redis.flushall();

      const filled = (
        await request(app.getHttpServer())
          .get(`${V1}/dashboard/summary`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ profile: { completeness: number; missingFields: string[] } }>;
      expect(filled.data.profile.completeness).toBe(86); // 6 of 7 — no photo
      expect(filled.data.profile.missingFields).toEqual(['photoUrl']);
    });

    it('caches per user and does not leak one user into another', async () => {
      const a = await newUser();
      const b = await newUser();

      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(a.token))
        .send({ displayName: 'User A' })
        .expect(200);

      const resA = (
        await request(app.getHttpServer())
          .get(`${V1}/dashboard/summary`)
          .set(auth(a.token))
          .expect(200)
      ).body as Envelope<{ profile: { displayName: string | null } }>;
      const resB = (
        await request(app.getHttpServer())
          .get(`${V1}/dashboard/summary`)
          .set(auth(b.token))
          .expect(200)
      ).body as Envelope<{ profile: { displayName: string | null } }>;

      expect(resA.data.profile.displayName).toBe('User A');
      expect(resB.data.profile.displayName).toBeNull();
      expect(await ctx.redis.get(`dashboard:summary:${a.userId}`)).toBeTruthy();
    });

    it('answers quickly on a seeded profile', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(token))
        .send({ displayName: 'Perf User', dateOfBirth: '1990-06-01' })
        .expect(200);
      await ctx.redis.flushall();

      // Uncached, so this measures the aggregation itself. A per-section query
      // design would be 12 round trips here and would grow with the product.
      const startedAt = Date.now();
      await request(app.getHttpServer())
        .get(`${V1}/dashboard/summary`)
        .set(auth(token))
        .expect(200);
      expect(Date.now() - startedAt).toBeLessThan(150);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get(`${V1}/dashboard/summary`).expect(401);
    });
  });
});
