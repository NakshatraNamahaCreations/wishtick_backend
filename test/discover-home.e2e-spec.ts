import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface AddressView {
  id: string;
  label: string;
  fullName: string;
  mobile: string;
  altMobile: string | null;
  email: string | null;
  line1: string;
  locality: string;
  landmark: string | null;
  pincode: string;
  city: string;
  state: string;
  countryCode: string;
  isDefault: boolean;
  formatted: string;
}

interface UpcomingOccasionView {
  id: string;
  personName: string;
  relation: string;
  occasionKey: string;
  date: string;
  nextOccurrence: string;
  daysAway: number;
  turningAge: number | null;
}

interface DiscoverSection {
  kind: 'person_occasion' | 'price_band' | 'premium';
  title: string;
  subtitle: string | null;
  person: { name: string; relation: string; occasionKey: string; daysAway: number } | null;
  maxPriceMinor: number | null;
  minPriceMinor: number | null;
  items: { externalId: string; amountMinor: number | null; listPriceMinor: number | null }[];
  exploreQuery: {
    category: string | null;
    minPriceMinor: number | null;
    maxPriceMinor: number | null;
  };
}

interface DiscoverFeed {
  sections: DiscoverSection[];
  generatedAt: string;
}

/**
 * Sprint 4 — everything Home and Discover read that did not exist before:
 * the address book, the upcoming-occasions projection over important dates,
 * and the Discover feed itself.
 */
describe('Sprint 4: Home & Discover (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const uniquePhone = (): string => `+9198770${String(10000 + ++seq).slice(-5)}`;

  const newUser = async (): Promise<string> => {
    const phone = uniquePhone();
    await request(app.getHttpServer()).post(`${V1}/auth/otp/request`).send({ phone }).expect(202);
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/otp/verify`)
      .send({ phone, code: ctx.sms.lastCode() })
      .expect(200);
    return (res.body as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const validAddress = (over: Partial<Record<string, unknown>> = {}) => ({
    label: 'home',
    fullName: 'Ananya Sharma',
    mobile: '+919876543210',
    line1: 'D-Block',
    locality: 'JP Nagar',
    city: 'Mysuru',
    state: 'Karnataka',
    pincode: '570031',
    ...over,
  });

  const addAddress = (token: string, over: Partial<Record<string, unknown>> = {}) =>
    request(app.getHttpServer())
      .post(`${V1}/me/addresses`)
      .set(auth(token))
      .send(validAddress(over));

  const listAddresses = async (token: string): Promise<AddressView[]> => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/me/addresses`)
      .set(auth(token))
      .expect(200);
    return (res.body as Envelope<AddressView[]>).data;
  };

  /** A saved date whose next occurrence is `daysFromNow` away. */
  const addDate = (token: string, daysFromNow: number, over: Record<string, unknown> = {}) => {
    const when = new Date();
    when.setUTCDate(when.getUTCDate() + daysFromNow);
    return request(app.getHttpServer())
      .post(`${V1}/me/important-dates`)
      .set(auth(token))
      .send({
        personName: 'Siya',
        relation: 'Best Friend',
        occasionKey: 'birthday',
        // 1999 so turningAge is a real number.
        date: `1999-${String(when.getUTCMonth() + 1).padStart(2, '0')}-${String(
          when.getUTCDate(),
        ).padStart(2, '0')}`,
        ...over,
      });
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

  describe('address book', () => {
    it('makes the first saved address the default without being asked', async () => {
      const token = await newUser();

      const res = await addAddress(token).expect(201);
      const created = (res.body as Envelope<AddressView>).data;

      expect(created.isDefault).toBe(true);
      expect(created.countryCode).toBe('IN');
      expect(created.landmark).toBeNull();
      expect(created.formatted).toBe('D-Block, JP Nagar, Mysuru, Karnataka 570031');
    });

    it('promoting an address demotes the previous default', async () => {
      const token = await newUser();
      await addAddress(token, { label: 'home' }).expect(201);
      const second = (await addAddress(token, { label: 'work' }).expect(201))
        .body as Envelope<AddressView>;

      expect(second.data.isDefault).toBe(false);

      await request(app.getHttpServer())
        .patch(`${V1}/me/addresses/${second.data.id}`)
        .set(auth(token))
        .send({ isDefault: true })
        .expect(200);

      const all = await listAddresses(token);
      expect(all.filter((a) => a.isDefault)).toHaveLength(1);
      // Default sorts first, so the promoted one leads.
      expect(all[0].label).toBe('work');
    });

    it('refuses to clear the only default, so checkout always has one', async () => {
      const token = await newUser();
      const created = (await addAddress(token).expect(201)).body as Envelope<AddressView>;

      await request(app.getHttpServer())
        .patch(`${V1}/me/addresses/${created.data.id}`)
        .set(auth(token))
        .send({ isDefault: false })
        .expect(400);
    });

    it('removing the default promotes the next-oldest', async () => {
      const token = await newUser();
      const first = (await addAddress(token, { label: 'home' }).expect(201))
        .body as Envelope<AddressView>;
      await addAddress(token, { label: 'work' }).expect(201);

      await request(app.getHttpServer())
        .delete(`${V1}/me/addresses/${first.data.id}`)
        .set(auth(token))
        .expect(204);

      const all = await listAddresses(token);
      expect(all).toHaveLength(1);
      expect(all[0].label).toBe('work');
      expect(all[0].isDefault).toBe(true);
    });

    it('rejects a pincode that is not a six-digit Indian PIN', async () => {
      const token = await newUser();
      await addAddress(token, { pincode: '57003' }).expect(400);
      await addAddress(token, { pincode: '0570031' }).expect(400);
      await addAddress(token, { pincode: 'ABC123' }).expect(400);
    });

    it("never returns another user's address", async () => {
      const mine = await newUser();
      const theirs = await newUser();
      const created = (await addAddress(theirs).expect(201)).body as Envelope<AddressView>;

      expect(await listAddresses(mine)).toHaveLength(0);
      await request(app.getHttpServer())
        .patch(`${V1}/me/addresses/${created.data.id}`)
        .set(auth(mine))
        .send({ city: 'Delhi' })
        .expect(404);
    });
  });

  describe('upcoming occasions', () => {
    it('resolves a saved date to its next yearly occurrence', async () => {
      const token = await newUser();
      await addDate(token, 3).expect(201);

      const res = await request(app.getHttpServer())
        .get(`${V1}/me/important-dates/upcoming`)
        .set(auth(token))
        .expect(200);
      const rows = (res.body as Envelope<UpcomingOccasionView[]>).data;

      expect(rows).toHaveLength(1);
      expect(rows[0].personName).toBe('Siya');
      expect(rows[0].daysAway).toBe(3);
      // Stored in 1999, so the next occurrence is this year or next.
      expect(Number(rows[0].nextOccurrence.slice(0, 4))).toBeGreaterThan(2000);
      expect(rows[0].turningAge).toBeGreaterThan(20);
    });

    it('honours withinDays, so Home can ask for 30 and Discover for more', async () => {
      const token = await newUser();
      await addDate(token, 5, { personName: 'Soon' }).expect(201);
      await addDate(token, 50, { personName: 'Later' }).expect(201);

      const near = await request(app.getHttpServer())
        .get(`${V1}/me/important-dates/upcoming?withinDays=30`)
        .set(auth(token))
        .expect(200);
      expect((near.body as Envelope<UpcomingOccasionView[]>).data.map((r) => r.personName)).toEqual(
        ['Soon'],
      );

      const far = await request(app.getHttpServer())
        .get(`${V1}/me/important-dates/upcoming?withinDays=90`)
        .set(auth(token))
        .expect(200);
      expect((far.body as Envelope<UpcomingOccasionView[]>).data.map((r) => r.personName)).toEqual([
        'Soon',
        'Later',
      ]);
    });

    it('sorts soonest first regardless of the year stored', async () => {
      const token = await newUser();
      await addDate(token, 20, { personName: 'Third' }).expect(201);
      await addDate(token, 2, { personName: 'First' }).expect(201);
      await addDate(token, 10, { personName: 'Second' }).expect(201);

      const res = await request(app.getHttpServer())
        .get(`${V1}/me/important-dates/upcoming?withinDays=60`)
        .set(auth(token))
        .expect(200);

      expect((res.body as Envelope<UpcomingOccasionView[]>).data.map((r) => r.personName)).toEqual([
        'First',
        'Second',
        'Third',
      ]);
    });
  });

  describe('discover feed', () => {
    const getFeed = async (token: string): Promise<DiscoverFeed> => {
      const res = await request(app.getHttpServer())
        .get(`${V1}/discover/feed`)
        .set(auth(token))
        .expect(200);
      return (res.body as Envelope<DiscoverFeed>).data;
    };

    it('serves the price-band and premium shelves to a user with no saved dates', async () => {
      const token = await newUser();

      const feed = await getFeed(token);
      const kinds = feed.sections.map((s) => s.kind);

      expect(kinds).toContain('price_band');
      expect(kinds).toContain('premium');
      expect(kinds).not.toContain('person_occasion');
    });

    it('adds a shelf for an approaching saved date, named after the person', async () => {
      const token = await newUser();
      await addDate(token, 7).expect(201);

      const feed = await getFeed(token);
      const person = feed.sections.find((s) => s.kind === 'person_occasion');

      expect(person).toBeDefined();
      expect(person?.title).toBe("Gift suggestions for Siya's Birthday");
      expect(person?.subtitle).toBe('Best Friend');
      expect(person?.person?.daysAway).toBe(7);
      expect(person?.items.length).toBeGreaterThan(0);
    });

    it('keeps every shelf within its own price bounds', async () => {
      const token = await newUser();
      const feed = await getFeed(token);

      const band = feed.sections.find((s) => s.kind === 'price_band');
      expect(band?.maxPriceMinor).not.toBeNull();
      for (const item of band?.items ?? []) {
        expect(item.amountMinor).not.toBeNull();
        expect(item.amountMinor!).toBeLessThanOrEqual(band!.maxPriceMinor!);
      }

      const premium = feed.sections.find((s) => s.kind === 'premium');
      expect(premium?.minPriceMinor).not.toBeNull();
      for (const item of premium?.items ?? []) {
        expect(item.amountMinor!).toBeGreaterThanOrEqual(premium!.minPriceMinor!);
      }
    });

    it('hands back an exploreQuery that products/search accepts as-is', async () => {
      const token = await newUser();
      const feed = await getFeed(token);
      const band = feed.sections.find((s) => s.kind === 'price_band')!;

      const params = new URLSearchParams();
      if (band.exploreQuery.category) params.set('category', band.exploreQuery.category);
      if (band.exploreQuery.minPriceMinor !== null) {
        params.set('minPriceMinor', String(band.exploreQuery.minPriceMinor));
      }
      if (band.exploreQuery.maxPriceMinor !== null) {
        params.set('maxPriceMinor', String(band.exploreQuery.maxPriceMinor));
      }

      await request(app.getHttpServer())
        .get(`${V1}/products/search?${params.toString()}`)
        .set(auth(token))
        .expect(200);
    });

    it('carries listPriceMinor so a discount can be shown honestly', async () => {
      const token = await newUser();
      const feed = await getFeed(token);
      const items = feed.sections.flatMap((s) => s.items);

      // The fixture catalogue marks some rows down and leaves others at list
      // price; both shapes must survive the round trip.
      expect(items.some((i) => i.listPriceMinor !== null)).toBe(true);
      for (const item of items) {
        if (item.listPriceMinor !== null && item.amountMinor !== null) {
          expect(item.listPriceMinor).toBeGreaterThan(item.amountMinor);
        }
      }
    });

    it('requires a bearer token', async () => {
      await request(app.getHttpServer()).get(`${V1}/discover/feed`).expect(401);
    });
  });

  describe('group gifts I take part in', () => {
    it('is empty for a user who has joined none', async () => {
      const token = await newUser();

      const res = await request(app.getHttpServer())
        .get(`${V1}/group-gifts/mine`)
        .set(auth(token))
        .expect(200);

      expect((res.body as Envelope<unknown[]>).data).toEqual([]);
    });

    it("does not treat 'mine' as a group-gift id", async () => {
      const token = await newUser();
      // Proves the route ordering: a bare id would 404 here, not 200.
      await request(app.getHttpServer()).get(`${V1}/group-gifts/mine`).set(auth(token)).expect(200);
    });

    it('requires a bearer token', async () => {
      await request(app.getHttpServer()).get(`${V1}/group-gifts/mine`).expect(401);
    });
  });
});
