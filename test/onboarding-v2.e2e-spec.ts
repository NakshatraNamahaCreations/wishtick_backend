import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from 'src/common/errors/error-codes';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface TaxonomyOption {
  key: string;
  label: string;
  meta?: Record<string, string>;
}

interface OptionsView {
  steps: { step: string; required: boolean }[];
  options: Record<string, TaxonomyOption[]>;
}

interface MeView {
  profile: {
    preferences: {
      interests: string[];
      interestCategories: string[];
      customInterests: string[];
      favouriteColors: string[];
      clothingSize: string | null;
      shoeSize: string | null;
      fitPreference: string | null;
    };
  };
}

interface DateView {
  id: string;
  personName: string;
  relation: string;
  occasionKey: string;
  date: string;
}

/**
 * The Sprint-2 onboarding surface as redesigned in Wishtick-UI-v2: two-level
 * interests with free-text customs, grouped colours, sized-and-fit
 * preferences, and the "Never Miss a Celebration" important dates.
 */
describe('Onboarding v2: taxonomy, preferences, important dates (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const uniquePhone = (): string => `+9198770${String(10000 + ++seq).slice(-5)}`;

  const newPhoneUser = async (): Promise<string> => {
    const phone = uniquePhone();
    await request(app.getHttpServer()).post(`${V1}/auth/otp/request`).send({ phone }).expect(202);
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/otp/verify`)
      .send({ phone, code: ctx.sms.lastCode() })
      .expect(200);
    return (res.body as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  };

  const saveStep = (token: string, step: string, payload: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`${V1}/onboarding/steps/${step}`)
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

  describe('GET /onboarding/options', () => {
    it('serves the v2 taxonomy the screens are built from', async () => {
      const token = await newPhoneUser();
      const res = await request(app.getHttpServer())
        .get(`${V1}/onboarding/options`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const { options } = (res.body as Envelope<OptionsView>).data;

      // The 12 category tiles (Figma 36:839), in display order.
      expect(options.interest_category.map((o) => o.key)).toEqual([
        'fashion',
        'technology',
        'home_living',
        'health_fitness',
        'travel',
        'entertainment',
        'hobbies',
        'kids_family',
        'automotive',
        'sustainable',
        'food_beverages',
        'other',
      ]);

      // Sub-interests carry their category and stay unique despite repeated
      // labels (Gaming exists in technology AND entertainment).
      const gaming = options.interest.filter((o) => o.label === 'Gaming');
      expect(gaming.map((o) => o.key).sort()).toEqual(['ent_gaming', 'tech_gaming']);
      expect(gaming.every((o) => o.meta?.category)).toBe(true);

      // Colours are grouped with hexes for the swatches (Figma 39:1061).
      const colours = options.color;
      expect(colours).toHaveLength(40);
      const plum = colours.find((o) => o.key === 'purple_plum');
      expect(plum?.meta).toMatchObject({
        hex: '#5B1A6E',
        group: 'purple',
        groupLabel: 'Purple & Violet',
      });

      // The retired v1 flat keys are gone from the payload.
      expect(colours.some((o) => o.key === 'red')).toBe(false);
      expect(options.interest.some((o) => o.key === 'music')).toBe(false);

      // Shoe sizes cover all three systems on the 51:42 toggle.
      const systems = new Set(options.shoe_size.map((o) => o.meta?.system).filter(Boolean));
      expect(systems).toEqual(new Set(['uk', 'us', 'eu']));
      expect(options.shoe_size.some((o) => o.key === 'uk_13')).toBe(true);

      expect(options.fit_preference.map((o) => o.key)).toEqual([
        'slim',
        'regular',
        'relaxed',
        'oversized',
      ]);

      // The dates screen's occasion dropdown includes Special Moments.
      expect(options.occasion.some((o) => o.key === 'special_moments')).toBe(true);
    });
  });

  describe('the interests step', () => {
    it('stores categories, granular interests, and free-text customs', async () => {
      const token = await newPhoneUser();

      await saveStep(token, 'interests', {
        interestCategories: ['fashion', 'health_fitness'],
        interests: ['fashion_shoes', 'fashion_watches', 'health_nutrition'],
        customInterests: ['  Astronomy ', 'Anime'],
      }).expect(200);

      const prefs = (await getMe(token)).profile.preferences;
      expect(prefs.interestCategories).toEqual(['fashion', 'health_fitness']);
      expect(prefs.interests).toEqual(['fashion_shoes', 'fashion_watches', 'health_nutrition']);
      // Trimmed on the way in.
      expect(prefs.customInterests).toEqual(['Astronomy', 'Anime']);
    });

    it('rejects an unknown category', async () => {
      const token = await newPhoneUser();
      const res = await saveStep(token, 'interests', {
        interestCategories: ['astrology'],
      }).expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.TAXONOMY_VALUE_INVALID);
    });

    it('rejects a retired v1 interest key', async () => {
      const token = await newPhoneUser();
      const res = await saveStep(token, 'interests', { interests: ['music'] }).expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.TAXONOMY_VALUE_INVALID);
    });

    it('caps a custom interest at 40 characters', async () => {
      const token = await newPhoneUser();
      await saveStep(token, 'interests', {
        customInterests: ['x'.repeat(41)],
      }).expect(400);
    });
  });

  describe('the sizes step', () => {
    it('stores sizes, fit preference, and grouped colours', async () => {
      const token = await newPhoneUser();

      // The colours screen (step 3) and size screen (step 4) both write the
      // backend "sizes" step — each sends only its own fields.
      await saveStep(token, 'sizes', {
        favouriteColors: ['earth_mocha', 'pastel_lemon', 'red_coral', 'neutral_white'],
      }).expect(200);
      await saveStep(token, 'sizes', {
        clothingSize: 'xs',
        shoeSize: 'uk_9',
        fitPreference: 'regular',
      }).expect(200);

      const prefs = (await getMe(token)).profile.preferences;
      // The second save must not clobber the first's colours.
      expect(prefs.favouriteColors).toEqual([
        'earth_mocha',
        'pastel_lemon',
        'red_coral',
        'neutral_white',
      ]);
      expect(prefs.clothingSize).toBe('xs');
      expect(prefs.shoeSize).toBe('uk_9');
      expect(prefs.fitPreference).toBe('regular');
    });

    it('accepts sizes from every system', async () => {
      const token = await newPhoneUser();
      await saveStep(token, 'sizes', { shoeSize: 'us_9' }).expect(200);
      await saveStep(token, 'sizes', { shoeSize: 'eu_42' }).expect(200);
      expect((await getMe(token)).profile.preferences.shoeSize).toBe('eu_42');
    });

    it('rejects an unknown fit preference', async () => {
      const token = await newPhoneUser();
      const res = await saveStep(token, 'sizes', { fitPreference: 'baggy' }).expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.TAXONOMY_VALUE_INVALID);
    });
  });

  describe('/me/important-dates', () => {
    const dates = (token: string) =>
      request(app.getHttpServer())
        .get(`${V1}/me/important-dates`)
        .set('Authorization', `Bearer ${token}`);

    it('saves and lists dates, soonest first', async () => {
      const token = await newPhoneUser();

      await request(app.getHttpServer())
        .post(`${V1}/me/important-dates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          personName: 'Ananya',
          relation: 'Best Friend',
          occasionKey: 'birthday',
          date: '1999-08-17',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${V1}/me/important-dates`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          personName: 'Mom',
          relation: 'Mother',
          occasionKey: 'special_moments',
          date: '1972-03-02',
        })
        .expect(201);

      const res = await dates(token).expect(200);
      const list = (res.body as Envelope<DateView[]>).data;
      expect(list).toHaveLength(2);
      expect(list[0].personName).toBe('Mom');
      expect(list[1]).toMatchObject({
        personName: 'Ananya',
        relation: 'Best Friend',
        occasionKey: 'birthday',
        date: '1999-08-17',
      });
    });

    it('rejects an unknown occasion', async () => {
      const token = await newPhoneUser();
      const res = await request(app.getHttpServer())
        .post(`${V1}/me/important-dates`)
        .set('Authorization', `Bearer ${token}`)
        .send({ personName: 'X', relation: 'Y', occasionKey: 'unbirthday', date: '2000-01-01' })
        .expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.TAXONOMY_VALUE_INVALID);
    });

    it('deletes only the caller’s own dates', async () => {
      const tokenA = await newPhoneUser();
      await ctx.reset();
      const tokenB = await newPhoneUser();

      const created = await request(app.getHttpServer())
        .post(`${V1}/me/important-dates`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ personName: 'A', relation: 'Friend', occasionKey: 'birthday', date: '2000-01-01' })
        .expect(201);
      const id = (created.body as Envelope<DateView>).data.id;

      // Someone else's id 404s exactly like an unknown one.
      await request(app.getHttpServer())
        .delete(`${V1}/me/important-dates/${id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);

      await request(app.getHttpServer())
        .delete(`${V1}/me/important-dates/${id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      const after = await dates(tokenA).expect(200);
      expect((after.body as Envelope<DateView[]>).data).toHaveLength(0);
    });
  });
});
