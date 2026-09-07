import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from 'src/common/errors/error-codes';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface MeView {
  id: string;
  email?: string;
  phone?: string;
  emailVerified: boolean;
  profile: {
    displayName: string | null;
    photoUrl: string | null;
    avatarKey: string | null;
    gender: string | null;
    dateOfBirth: string | null;
  };
}

/**
 * The fields the "Create Your Profile" screen (Figma `31:608`) collects beyond
 * what the profile step already supported: gender, a preset avatar, and an email
 * for a user who signed up by phone.
 */
describe('Profile fields: gender, avatar, email (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const uniquePhone = (): string => `+9198760${String(10000 + ++seq).slice(-5)}`;
  const uniqueEmail = (): string => `pf${seq}.${Date.now()}@example.com`;

  /// Signs in by phone, the way a real user reaches this screen.
  const newPhoneUser = async (): Promise<{ token: string; phone: string }> => {
    const phone = uniquePhone();
    await request(app.getHttpServer()).post(`${V1}/auth/otp/request`).send({ phone }).expect(202);
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/otp/verify`)
      .send({ phone, code: ctx.sms.lastCode() })
      .expect(200);
    const body = res.body as Envelope<{ tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, phone };
  };

  const saveProfileStep = (token: string, payload: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`${V1}/onboarding/steps/profile`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

  const getMe = async (token: string): Promise<MeView> => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return (res.body as Envelope<MeView>).data;
  };

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

  describe('the profile step', () => {
    it('saves everything the screen collects in one call', async () => {
      const { token, phone } = await newPhoneUser();
      const email = uniqueEmail();

      await saveProfileStep(token, {
        displayName: 'Ananya Mehra',
        email,
        dateOfBirth: '1998-07-17',
        gender: 'female',
        avatarKey: 'avatar_07',
      }).expect(200);

      const me = await getMe(token);
      expect(me.phone).toBe(phone);
      expect(me.email).toBe(email);
      expect(me.profile.displayName).toBe('Ananya Mehra');
      expect(me.profile.dateOfBirth).toBe('1998-07-17');
      expect(me.profile.gender).toBe('female');
      expect(me.profile.avatarKey).toBe('avatar_07');
    });

    it('marks the step complete so onboarding can finish', async () => {
      const { token } = await newPhoneUser();

      const res = await saveProfileStep(token, {
        displayName: 'Ananya',
        gender: 'other',
      }).expect(200);

      const body = res.body as Envelope<{ status: { completedSteps: string[] } }>;
      expect(body.data.status.completedSteps).toContain('profile');
    });

    it('accepts each of the three genders', async () => {
      for (const gender of ['male', 'female', 'other']) {
        const { token } = await newPhoneUser();
        await saveProfileStep(token, { gender }).expect(200);
        expect((await getMe(token)).profile.gender).toBe(gender);
        await ctx.reset();
      }
    });

    it('rejects a gender outside the three options', async () => {
      const { token } = await newPhoneUser();

      const res = await saveProfileStep(token, { gender: 'unspecified' }).expect(400);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects an avatar key outside the bundled range', async () => {
      const { token } = await newPhoneUser();

      await saveProfileStep(token, { avatarKey: 'avatar_21' }).expect(400);
      await saveProfileStep(token, { avatarKey: 'avatar_7' }).expect(400);
      await saveProfileStep(token, { avatarKey: '../../etc/passwd' }).expect(400);
    });

    it('still refuses fields belonging to another step', async () => {
      const { token } = await newPhoneUser();

      const res = await saveProfileStep(token, {
        displayName: 'Ananya',
        interests: ['music'],
      }).expect(400);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  describe('email', () => {
    it('lands unverified, so possession still has to be proven', async () => {
      const { token } = await newPhoneUser();
      const email = uniqueEmail();

      await saveProfileStep(token, { email }).expect(200);

      const me = await getMe(token);
      expect(me.email).toBe(email);
      expect(me.emailVerified).toBe(false);
    });

    it('cannot be set to an address another account already holds', async () => {
      const first = await newPhoneUser();
      const email = uniqueEmail();
      await saveProfileStep(first.token, { email }).expect(200);
      await ctx.reset();

      const second = await newPhoneUser();
      const res = await saveProfileStep(second.token, { email }).expect(409);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);
    });

    it('is idempotent when re-sent unchanged', async () => {
      const { token } = await newPhoneUser();
      const email = uniqueEmail();

      await saveProfileStep(token, { email }).expect(200);
      // Re-submitting the step must not collide with the user's own address.
      await saveProfileStep(token, { email }).expect(200);

      expect((await getMe(token)).email).toBe(email);
    });

    it('rejects a malformed address', async () => {
      const { token } = await newPhoneUser();
      await saveProfileStep(token, { email: 'not-an-email' }).expect(400);
    });
  });

  describe('avatar and photo are mutually exclusive', () => {
    it('choosing a preset avatar clears an uploaded photo', async () => {
      const { token } = await newPhoneUser();

      await saveProfileStep(token, { avatarKey: 'avatar_03' }).expect(200);
      const me = await getMe(token);

      expect(me.profile.avatarKey).toBe('avatar_03');
      expect(me.profile.photoUrl).toBeNull();
    });

    it('a later avatar choice replaces the earlier one', async () => {
      const { token } = await newPhoneUser();

      await saveProfileStep(token, { avatarKey: 'avatar_03' }).expect(200);
      await saveProfileStep(token, { avatarKey: 'avatar_18' }).expect(200);

      expect((await getMe(token)).profile.avatarKey).toBe('avatar_18');
    });

    it('clearing the avatar leaves no picture', async () => {
      const { token } = await newPhoneUser();

      await saveProfileStep(token, { avatarKey: 'avatar_03' }).expect(200);
      await saveProfileStep(token, { avatarKey: null }).expect(200);

      const me = await getMe(token);
      expect(me.profile.avatarKey).toBeNull();
      expect(me.profile.photoUrl).toBeNull();
    });
  });

  describe('PATCH /me', () => {
    it('can change the same fields after onboarding', async () => {
      const { token } = await newPhoneUser();
      await saveProfileStep(token, {
        displayName: 'Ananya',
        gender: 'female',
        avatarKey: 'avatar_02',
      }).expect(200);

      await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set('Authorization', `Bearer ${token}`)
        .send({ gender: 'other', avatarKey: 'avatar_11' })
        .expect(200);

      const me = await getMe(token);
      expect(me.profile.gender).toBe('other');
      expect(me.profile.avatarKey).toBe('avatar_11');
      expect(me.profile.displayName).toBe('Ananya');
    });
  });
});
