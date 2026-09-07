import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from 'src/common/errors/error-codes';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { TAXONOMY_CACHE_KEY } from 'src/modules/taxonomy/taxonomy.service';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface MeView {
  id: string;
  email?: string;
  profile: {
    displayName: string | null;
    photoUrl: string | null;
    dateOfBirth: string | null;
    timezone: string;
    preferences: {
      interests: string[];
      favouriteColors: string[];
      clothingSize: string | null;
      shoeSize: string | null;
      giftCategories: string[];
      lifestyle: string[];
      occasions: string[];
    };
    onboarding: { completed: boolean; completedSteps: string[] };
  };
}

interface UploadTicket {
  mediaId: string;
  uploadUrl: string;
  storageKey: string;
  maxBytes: number;
}

/** A tiny but genuinely valid PNG, so content-type checks see real bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('Onboarding, profile & media (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const uniqueEmail = (): string => `ob${++seq}.${Date.now()}@example.com`;

  /** Signs up and returns a bearer token. */
  const newUser = async (): Promise<{ token: string; email: string; userId: string }> => {
    const email = uniqueEmail();
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, email, userId: body.data.user.id };
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 90_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Taxonomy / options ────────────────────────────────────────────────────

  describe('GET /onboarding/options', () => {
    it('serves the seeded taxonomy without authentication', async () => {
      // Public so a client can render onboarding before the account exists.
      const res = await request(app.getHttpServer()).get(`${V1}/onboarding/options`).expect(200);
      const { steps, options } = (
        res.body as Envelope<{
          steps: { step: string; required: boolean }[];
          options: Record<string, unknown[]>;
        }>
      ).data;

      expect(steps.length).toBeGreaterThan(0);
      expect(steps.filter((s) => s.required).map((s) => s.step)).toEqual(['profile']);

      // Came from the real migration, not a test fixture.
      expect(options.interest.length).toBeGreaterThan(5);
      expect(options.gift_category.length).toBeGreaterThan(5);
      expect(options.color).toContainEqual({
        key: 'purple_plum',
        label: 'Plum',
        meta: { hex: '#5B1A6E', group: 'purple', groupLabel: 'Purple & Violet' },
      });
    });

    it('returns every kind, even ones with no rows', async () => {
      const res = await request(app.getHttpServer()).get(`${V1}/onboarding/options`).expect(200);
      const { options } = (res.body as Envelope<{ options: Record<string, unknown[]> }>).data;
      // A client must not have to handle "key present" and "key absent".
      for (const kind of [
        'interest',
        'color',
        'clothing_size',
        'shoe_size',
        'gift_category',
        'lifestyle',
        'occasion',
        'event_type',
      ]) {
        expect(Array.isArray(options[kind])).toBe(true);
      }
    });

    it('serves the second request from cache', async () => {
      await request(app.getHttpServer()).get(`${V1}/onboarding/options`).expect(200);
      // The real key, not a copy of it: the key is bumped whenever a new kind
      // is added, and a hardcoded one silently stops testing anything.
      const cached = await ctx.redis.get(TAXONOMY_CACHE_KEY);
      expect(cached).toBeTruthy();
    });
  });

  // ── Exit criterion: onboarding → photo → fully populated /me ──────────────

  describe('the full onboarding journey', () => {
    it('carries a new user through every step, a photo, and a populated /me', async () => {
      const { token } = await newUser();

      // 1. Nothing done yet; the required step is outstanding.
      const initial = await request(app.getHttpServer())
        .get(`${V1}/onboarding/status`)
        .set(auth(token))
        .expect(200);
      expect(
        (initial.body as Envelope<{ remainingRequiredSteps: string[] }>).data
          .remainingRequiredSteps,
      ).toEqual(['profile']);

      // 2. Required step.
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(token))
        .send({ displayName: 'Aarav Sharma', dateOfBirth: '1995-04-17', timezone: 'Asia/Kolkata' })
        .expect(200);

      // 3. Optional steps.
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/interests`)
        .set(auth(token))
        .send({ interests: ['ent_music', 'travel_road_trips', 'food_dining_experiences'] })
        .expect(200);

      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/sizes`)
        .set(auth(token))
        .send({ clothingSize: 'm', shoeSize: 'uk_8', favouriteColors: ['blue_navy', 'green_sage'] })
        .expect(200);

      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/gifting`)
        .set(auth(token))
        .send({ giftCategories: ['books', 'electronics'], lifestyle: ['minimalist'] })
        .expect(200);

      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/occasions`)
        .set(auth(token))
        .send({ occasions: ['birthday', 'anniversary'] })
        .expect(200);

      // 4. Upload a profile photo end to end: presign → PUT the real bytes → confirm.
      const ticket = (
        await request(app.getHttpServer())
          .post(`${V1}/media/upload-url`)
          .set(auth(token))
          .send({ purpose: MediaPurpose.PROFILE_PHOTO, contentType: 'image/png' })
          .expect(201)
      ).body as Envelope<UploadTicket>;

      const uploadPath =
        new URL(ticket.data.uploadUrl).pathname + new URL(ticket.data.uploadUrl).search;
      await request(app.getHttpServer())
        .put(uploadPath)
        .set('Content-Type', 'image/png')
        .send(PNG_BYTES)
        .expect(200);

      const confirmed = (
        await request(app.getHttpServer())
          .post(`${V1}/media/confirm`)
          .set(auth(token))
          .send({ mediaId: ticket.data.mediaId })
          .expect(201)
      ).body as Envelope<{ status: string; sizeBytes: number; url: string }>;
      expect(confirmed.data.status).toBe('ready');
      expect(confirmed.data.sizeBytes).toBe(PNG_BYTES.length);

      await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set(auth(token))
        .send({ photoMediaId: ticket.data.mediaId })
        .expect(200);

      // 5. Complete.
      const completed = await request(app.getHttpServer())
        .post(`${V1}/onboarding/complete`)
        .set(auth(token))
        .expect(200);
      expect((completed.body as Envelope<{ completed: boolean }>).data.completed).toBe(true);

      // 6. /me reads back everything that went in.
      const me = (await request(app.getHttpServer()).get(`${V1}/me`).set(auth(token)).expect(200))
        .body as Envelope<MeView>;

      expect(me.data.profile).toMatchObject({
        displayName: 'Aarav Sharma',
        dateOfBirth: '1995-04-17',
        timezone: 'Asia/Kolkata',
        preferences: {
          interests: ['ent_music', 'travel_road_trips', 'food_dining_experiences'],
          favouriteColors: ['blue_navy', 'green_sage'],
          clothingSize: 'm',
          shoeSize: 'uk_8',
          giftCategories: ['books', 'electronics'],
          lifestyle: ['minimalist'],
          occasions: ['birthday', 'anniversary'],
        },
        onboarding: { completed: true },
      });
      expect(me.data.profile.photoUrl).toContain(ticket.data.storageKey);
      expect(me.data.profile.onboarding.completedSteps).toEqual(
        expect.arrayContaining(['profile', 'interests', 'sizes', 'gifting', 'occasions']),
      );
    }, 30_000);

    it('keeps the birthday on the intended calendar day', async () => {
      const { token } = await newUser();
      // Stored UTC-midnight. Parsing a date-only string in a server-local zone
      // can shift it a day, which would unlock the birthday reel early.
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(token))
        .send({
          displayName: 'Edge Case',
          dateOfBirth: '1990-01-01',
          timezone: 'Pacific/Kiritimati',
        })
        .expect(200);

      const me = (await request(app.getHttpServer()).get(`${V1}/me`).set(auth(token)).expect(200))
        .body as Envelope<MeView>;
      expect(me.data.profile.dateOfBirth).toBe('1990-01-01');
    });
  });

  // ── Step semantics ────────────────────────────────────────────────────────

  describe('step saving', () => {
    it('is idempotent — re-saving updates the answer and records the step once', async () => {
      const { token } = await newUser();

      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/interests`)
        .set(auth(token))
        .send({ interests: ['ent_music'] })
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/interests`)
        .set(auth(token))
        .send({ interests: ['tech_gaming', 'hobby_art_craft'] })
        .expect(200);

      const status = (second.body as Envelope<{ status: { completedSteps: string[] } }>).data
        .status;
      expect(status.completedSteps.filter((s) => s === 'interests')).toHaveLength(1);

      const me = (await request(app.getHttpServer()).get(`${V1}/me`).set(auth(token)).expect(200))
        .body as Envelope<MeView>;
      expect(me.data.profile.preferences.interests).toEqual(['tech_gaming', 'hobby_art_craft']);
    });

    it('lets a client resume a half-finished onboarding', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/interests`)
        .set(auth(token))
        .send({ interests: ['ent_music'] })
        .expect(200);

      const status = (
        await request(app.getHttpServer())
          .get(`${V1}/onboarding/status`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ completedSteps: string[]; remainingRequiredSteps: string[] }>;
      expect(status.data.completedSteps).toEqual(['interests']);
      expect(status.data.remainingRequiredSteps).toEqual(['profile']);
    });

    it('rejects an unknown step', async () => {
      const { token } = await newUser();
      const res = await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/favourite-cheese`)
        .set(auth(token))
        .send({ interests: ['ent_music'] })
        .expect(404);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.ONBOARDING_STEP_UNKNOWN);
    });

    it('refuses fields that belong to a different step', async () => {
      const { token } = await newUser();
      // Otherwise one request could post everything to one step and bypass the
      // rest of the flow's validation.
      const res = await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/occasions`)
        .set(auth(token))
        .send({ occasions: ['birthday'], interests: ['ent_music'] })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('rejects taxonomy keys that do not exist', async () => {
      const { token } = await newUser();
      const res = await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/interests`)
        .set(auth(token))
        .send({ interests: ['ent_music', 'competitive-napping'] })
        .expect(400);

      // Free text here would make "users interested in music" unanswerable in
      // the Sprint 11 analytics.
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.TAXONOMY_VALUE_INVALID);
      expect((res.body as Envelope<never>).error?.details).toMatchObject({
        unknown: ['competitive-napping'],
      });
    });

    it('rejects an invalid timezone', async () => {
      const { token } = await newUser();
      // A bad zone would break the birthday reel release in Sprint 10.
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(token))
        .send({ displayName: 'X', timezone: 'Mars/Olympus_Mons' })
        .expect(400);
    });

    it.each(['Asia/Kolkata', 'Asia/Calcutta', 'Europe/Kyiv', 'America/New_York'])(
      'accepts the real-world timezone %s',
      async (timezone) => {
        // Asia/Kolkata is what a browser in the product's primary market reports,
        // and an earlier allowlist built from Intl.supportedValuesOf() rejected
        // it outright. Both the modern name and its legacy alias must work.
        const { token } = await newUser();
        await request(app.getHttpServer())
          .post(`${V1}/onboarding/steps/profile`)
          .set(auth(token))
          .send({ displayName: 'Zone Test', timezone })
          .expect(200);

        const me = (await request(app.getHttpServer()).get(`${V1}/me`).set(auth(token)).expect(200))
          .body as Envelope<MeView>;
        expect(me.data.profile.timezone).toBe(timezone);
      },
    );
  });

  describe('POST /onboarding/complete', () => {
    it('refuses until the required step is done', async () => {
      const { token } = await newUser();
      const res = await request(app.getHttpServer())
        .post(`${V1}/onboarding/complete`)
        .set(auth(token))
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.ONBOARDING_INCOMPLETE);
      expect((res.body as Envelope<never>).error?.details).toMatchObject({
        missingSteps: ['profile'],
      });
    });

    it('succeeds with only the required step, without the optional ones', async () => {
      const { token } = await newUser();
      // Personalization must not gate access to the product.
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(token))
        .send({ displayName: 'Minimal User' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/complete`)
        .set(auth(token))
        .expect(200);
    });

    it('rejects completing twice', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/steps/profile`)
        .set(auth(token))
        .send({ displayName: 'Twice' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/onboarding/complete`)
        .set(auth(token))
        .expect(200);

      // The completion timestamp is an acquisition metric; it must not move.
      const res = await request(app.getHttpServer())
        .post(`${V1}/onboarding/complete`)
        .set(auth(token))
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.ONBOARDING_ALREADY_COMPLETE);
    });
  });

  // ── Profile ───────────────────────────────────────────────────────────────

  describe('profile', () => {
    it('creates a profile lazily for a user who has never touched onboarding', async () => {
      const { token } = await newUser();
      const me = (await request(app.getHttpServer()).get(`${V1}/me`).set(auth(token)).expect(200))
        .body as Envelope<MeView>;
      expect(me.data.profile.timezone).toBe('UTC');
      expect(me.data.profile.preferences.interests).toEqual([]);
    });

    it('merges partial preference updates instead of wiping the rest', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .patch(`${V1}/me/preferences`)
        .set(auth(token))
        .send({ interests: ['ent_music'], giftCategories: ['books'] })
        .expect(200);

      // Sending only one field must not clear the others.
      const res = await request(app.getHttpServer())
        .patch(`${V1}/me/preferences`)
        .set(auth(token))
        .send({ interests: ['tech_gaming'] })
        .expect(200);

      const me = (res.body as Envelope<MeView>).data;
      expect(me.profile.preferences.interests).toEqual(['tech_gaming']);
      expect(me.profile.preferences.giftCategories).toEqual(['books']);
    });

    it('rejects a future date of birth', async () => {
      const { token } = await newUser();
      await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set(auth(token))
        .send({ dateOfBirth: '2999-01-01' })
        .expect(400);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get(`${V1}/me`).expect(401);
      await request(app.getHttpServer()).patch(`${V1}/me`).send({ displayName: 'x' }).expect(401);
    });
  });

  // ── Media ─────────────────────────────────────────────────────────────────

  describe('media', () => {
    const getTicket = async (token: string, contentType = 'image/png'): Promise<UploadTicket> => {
      const res = await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(token))
        .send({ purpose: MediaPurpose.PROFILE_PHOTO, contentType })
        .expect(201);
      return (res.body as Envelope<UploadTicket>).data;
    };

    const pathOf = (url: string): string => new URL(url).pathname + new URL(url).search;

    it('rejects a disallowed content type up front', async () => {
      const { token } = await newUser();
      // SVG is stored XSS if it is ever served from our origin — allowlist only.
      const res = await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(token))
        .send({ purpose: MediaPurpose.PROFILE_PHOTO, contentType: 'image/svg+xml' })
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.MEDIA_TYPE_NOT_ALLOWED);
    });

    it('rejects a declared size over the purpose limit', async () => {
      const { token } = await newUser();
      const res = await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(token))
        .send({
          purpose: MediaPurpose.PROFILE_PHOTO,
          contentType: 'image/png',
          sizeBytes: 9_999_999,
        })
        .expect(413);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.MEDIA_TOO_LARGE);
    });

    it('refuses to confirm before the bytes arrive', async () => {
      const { token } = await newUser();
      const ticket = await getTicket(token);
      // The upload URL was issued but nothing was PUT.
      const res = await request(app.getHttpServer())
        .post(`${V1}/media/confirm`)
        .set(auth(token))
        .send({ mediaId: ticket.mediaId })
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.MEDIA_NOT_UPLOADED);
    });

    it('is idempotent on confirm', async () => {
      const { token } = await newUser();
      const ticket = await getTicket(token);
      await request(app.getHttpServer())
        .put(pathOf(ticket.uploadUrl))
        .set('Content-Type', 'image/png')
        .send(PNG_BYTES)
        .expect(200);

      const first = await request(app.getHttpServer())
        .post(`${V1}/media/confirm`)
        .set(auth(token))
        .send({ mediaId: ticket.mediaId })
        .expect(201);
      // A client retrying a dropped response must not get an error.
      const second = await request(app.getHttpServer())
        .post(`${V1}/media/confirm`)
        .set(auth(token))
        .send({ mediaId: ticket.mediaId })
        .expect(201);

      expect((second.body as Envelope<{ url: string }>).data.url).toBe(
        (first.body as Envelope<{ url: string }>).data.url,
      );
    });

    it('rejects a tampered upload signature', async () => {
      const { token } = await newUser();
      const ticket = await getTicket(token);
      // Raising maxBytes in the URL invalidates the signature that covers it.
      const tampered = pathOf(ticket.uploadUrl).replace(/maxBytes=\d+/, 'maxBytes=99999999');
      const res = await request(app.getHttpServer())
        .put(tampered)
        .set('Content-Type', 'image/png')
        .send(PNG_BYTES)
        .expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.MEDIA_SIGNATURE_INVALID);
    });

    it('rejects an expired upload URL', async () => {
      const { token } = await newUser();
      const ticket = await getTicket(token);
      const expired = pathOf(ticket.uploadUrl).replace(
        /expires=\d+/,
        `expires=${Date.now() - 1_000}`,
      );
      const res = await request(app.getHttpServer())
        .put(expired)
        .set('Content-Type', 'image/png')
        .send(PNG_BYTES)
        .expect(410);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.MEDIA_URL_EXPIRED);
    });

    it("will not let one user confirm or attach another user's media", async () => {
      const owner = await newUser();
      const attacker = await newUser();
      const ticket = await getTicket(owner.token);
      await request(app.getHttpServer())
        .put(pathOf(ticket.uploadUrl))
        .set('Content-Type', 'image/png')
        .send(PNG_BYTES)
        .expect(200);

      // 404 rather than 403: distinguishing them would let anyone probe for
      // valid media ids.
      await request(app.getHttpServer())
        .post(`${V1}/media/confirm`)
        .set(auth(attacker.token))
        .send({ mediaId: ticket.mediaId })
        .expect(404);

      await request(app.getHttpServer())
        .post(`${V1}/media/confirm`)
        .set(auth(owner.token))
        .send({ mediaId: ticket.mediaId })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set(auth(attacker.token))
        .send({ photoMediaId: ticket.mediaId })
        .expect(404);
    });

    it('refuses to attach an unconfirmed photo', async () => {
      const { token } = await newUser();
      const ticket = await getTicket(token);
      const res = await request(app.getHttpServer())
        .patch(`${V1}/me`)
        .set(auth(token))
        .send({ photoMediaId: ticket.mediaId })
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.MEDIA_NOT_UPLOADED);
    });

    it('serves an uploaded file back with nosniff', async () => {
      const { token } = await newUser();
      const ticket = await getTicket(token);
      await request(app.getHttpServer())
        .put(pathOf(ticket.uploadUrl))
        .set('Content-Type', 'image/png')
        .send(PNG_BYTES)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`${V1}/media/local/${ticket.storageKey}`)
        .expect(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });
});
