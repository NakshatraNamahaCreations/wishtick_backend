import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CacheService } from 'src/infra/redis/cache.service';
import { ProductsService } from 'src/modules/products/products.service';
import { TastePrewarmService } from 'src/modules/suggestions/taste-prewarm.service';
import { DAILY_SEARCH_HARD_CAP } from 'src/modules/suggestions/vendor-budget.service';
import { FixtureProductProvider } from 'src/modules/products/providers/fixture-provider';
import { ProviderGuard } from 'src/modules/products/providers/provider-guard.service';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  data: T;
  error?: { code: string };
}

interface Actor {
  token: string;
  userId: string;
}

interface SuggestionsBody {
  title: string;
  items: {
    product: { title: string; externalId: string };
    matchScore: number;
    reasons: string[];
  }[];
  personalised: boolean;
  reasonCode: string | null;
  note: string | null;
  partial: boolean;
  exploreQuery: { category: string | null };
}

interface TasteBody {
  title: string;
  interests: { key: string; label: string }[];
  customInterests: string[];
  colours: { key: string; label: string; hex: string | null }[];
  sizes: { clothing: string | null; shoe: string | null; fit: string | null } | null;
  isSelf: boolean;
}

/**
 * Gift ideas tuned to a person, and what one person may read about another's
 * taste.
 *
 * Until this, the interests, colours and sizes collected at registration were
 * shown to nobody and used for nothing. These are the rules for changing
 * that: WishMates only, sizes behind their owner's switch, and never more than
 * three paid searches for one request.
 */
describe('Gift suggestions (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let fixture: FixtureProductProvider;
  let products: ProductsService;
  let guard: ProviderGuard;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixture = app.get(FixtureProductProvider);
    products = app.get(ProductsService);
    guard = app.get(ProviderGuard);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fixture.faults = {};
    // A test that takes the provider down trips its breaker, which would
    // otherwise stay open and fail every search in the tests after it.
    guard.resetBreaker('fixture');
    jest.restoreAllMocks();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const someone = async (username: string, displayName: string): Promise<Actor> => {
    const email = `gs${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: displayName })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    const actor = { token: body.data.tokens.accessToken, userId: body.data.user.id };
    await request(app.getHttpServer())
      .post(`${V1}/me/username`)
      .set(auth(actor.token))
      .send({ username })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${V1}/onboarding/steps/profile`)
      .set(auth(actor.token))
      .send({ displayName, dateOfBirth: '1995-04-17' })
      .expect(200);
    return actor;
  };

  const connect = async (a: Actor, b: Actor) => {
    await request(app.getHttpServer())
      .post(`${V1}/people/${b.userId}/request`)
      .set(auth(a.token))
      .expect(201);
    const received = await request(app.getHttpServer())
      .get(`${V1}/wishlinks/received`)
      .set(auth(b.token))
      .expect(200);
    const linkId = (received.body as Envelope<{ linkId: string }[]>).data[0].linkId;
    await request(app.getHttpServer())
      .post(`${V1}/wishlinks/${linkId}/accept`)
      .set(auth(b.token))
      .expect(201);
  };

  const setTaste = (actor: Actor, preferences: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`${V1}/me/preferences`)
      .set(auth(actor.token))
      .send(preferences)
      .expect(200);

  const suggestionsFor = (viewer: Actor, target: Actor, query = '') =>
    request(app.getHttpServer())
      .get(`${V1}/people/${target.userId}/gift-suggestions${query}`)
      .set(auth(viewer.token));

  const profileOf = async (viewer: Actor, target: Actor) => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/people/${target.userId}`)
      .set(auth(viewer.token))
      .expect(200);
    return (res.body as Envelope<{ taste: TasteBody | null }>).data;
  };

  const techLover = {
    interests: ['tech_smart_home', 'tech_audio_devices'],
    interestCategories: ['technology'],
    customInterests: ['Vinyl records'],
    favouriteColors: ['blue_navy'],
    clothingSize: 'xl',
    shoeSize: 'uk_9',
    fitPreference: 'relaxed',
  };

  // ── Phase 3 ──────────────────────────────────────────────────────────────

  /** A date this many days from now, as a saved birthday from 1995. */
  const soon = (days: number) => {
    const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return `1995-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  const saveDate = async (owner: Actor, body: Record<string, unknown>) => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/me/important-dates`)
      .set(auth(owner.token))
      .send({ occasionKey: 'birthday', date: soon(10), ...body })
      .expect(201);
    return (res.body as Envelope<{ id: string; linkedUserId: string | null }>).data;
  };

  const linkDate = (owner: Actor, dateId: string, target: Actor) =>
    request(app.getHttpServer())
      .put(`${V1}/me/important-dates/${dateId}/link`)
      .set(auth(owner.token))
      .send({ userId: target.userId });

  const myDates = async (owner: Actor) => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/me/important-dates`)
      .set(auth(owner.token))
      .expect(200);
    return (res.body as Envelope<{ id: string; linkedUserId: string | null }[]>).data;
  };

  interface FeedBody {
    sections: {
      kind: string;
      title: string;
      person: { importantDateId: string } | null;
      exploreQuery: { category: string | null; recipientUserId?: string | null };
    }[];
  }

  const feedOf = async (viewer: Actor) => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/discover/feed`)
      .set(auth(viewer.token))
      .expect(200);
    return (res.body as Envelope<FeedBody>).data;
  };

  describe('a saved date that is a WishMate', () => {
    it('can be linked only to an accepted WishMate', async () => {
      const priyal = await someone('priyal_l1', 'Priyal');
      const rohan = await someone('rohan_l1', 'Rohan');
      const date = await saveDate(rohan, { personName: 'Priyal' });

      const refused = await linkDate(rohan, date.id, priyal).expect(403);
      expect((refused.body as Envelope<unknown>).error?.code).toBe('NOT_WISHMATES');
      expect((await myDates(rohan))[0].linkedUserId).toBeNull();

      await connect(rohan, priyal);
      await linkDate(rohan, date.id, priyal).expect(200);
      expect((await myDates(rohan))[0].linkedUserId).toBe(priyal.userId);
    });

    it('stops counting the moment they are no longer WishMates', async () => {
      const priyal = await someone('priyal_l2', 'Priyal');
      const rohan = await someone('rohan_l2', 'Rohan');
      await connect(rohan, priyal);
      const date = await saveDate(rohan, { personName: 'Priyal' });
      await linkDate(rohan, date.id, priyal).expect(200);

      await request(app.getHttpServer())
        .delete(`${V1}/wishmates/${rohan.userId}`)
        .set(auth(priyal.token))
        .expect(204);

      // Nothing was written to the date; the read decided.
      expect((await myDates(rohan))[0].linkedUserId).toBeNull();
    });

    it("someone else's date cannot be linked", async () => {
      const priyal = await someone('priyal_l3', 'Priyal');
      const rohan = await someone('rohan_l3', 'Rohan');
      const other = await someone('other_l3', 'Other');
      await connect(other, priyal);
      const date = await saveDate(rohan, { personName: 'Priyal' });

      await linkDate(other, date.id, priyal).expect(404);
    });

    it('unlinking keeps the date', async () => {
      const priyal = await someone('priyal_l4', 'Priyal');
      const rohan = await someone('rohan_l4', 'Rohan');
      await connect(rohan, priyal);
      const date = await saveDate(rohan, { personName: 'Priyal' });
      await linkDate(rohan, date.id, priyal).expect(200);

      await request(app.getHttpServer())
        .delete(`${V1}/me/important-dates/${date.id}/link`)
        .set(auth(rohan.token))
        .expect(200);

      const dates = await myDates(rohan);
      expect(dates).toHaveLength(1);
      expect(dates[0].linkedUserId).toBeNull();
    });
  });

  describe('the Discover feed', () => {
    it("ranks a linked WishMate's shelf by what they like", async () => {
      const priyal = await someone('priyal_f1', 'Priyal');
      const rohan = await someone('rohan_f1', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);
      const date = await saveDate(rohan, { personName: 'Priyal', relation: 'Sister' });
      await linkDate(rohan, date.id, priyal).expect(200);

      const feed = await feedOf(rohan);
      const shelf = feed.sections.find((s) => s.person?.importantDateId === date.id);

      expect(shelf?.kind).toBe('wishmate_taste');
      expect(shelf?.title).toBe("Picked for Priyal's Birthday");
      expect(shelf?.exploreQuery.recipientUserId).toBe(priyal.userId);
    });

    it('goes back to the occasion once they are removed', async () => {
      const priyal = await someone('priyal_f2', 'Priyal');
      const rohan = await someone('rohan_f2', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);
      const date = await saveDate(rohan, { personName: 'Priyal' });
      await linkDate(rohan, date.id, priyal).expect(200);
      await request(app.getHttpServer())
        .delete(`${V1}/wishmates/${rohan.userId}`)
        .set(auth(priyal.token))
        .expect(204);

      const shelf = (await feedOf(rohan)).sections.find(
        (s) => s.person?.importantDateId === date.id,
      );

      expect(shelf?.kind).toBe('person_occasion');
      expect(shelf?.exploreQuery.recipientUserId ?? null).toBeNull();
    });

    it('lets who somebody is choose the shelf for their occasion', async () => {
      const rohan = await someone('rohan_f3', 'Rohan');
      const mum = await saveDate(rohan, { personName: 'Asha', relation: 'Mom' });
      const dad = await saveDate(rohan, { personName: 'Ravi', relation: 'Dad', date: soon(12) });

      const sections = (await feedOf(rohan)).sections;
      const shelfFor = (id: string) => sections.find((s) => s.person?.importantDateId === id);

      expect(shelfFor(mum.id)?.exploreQuery.category).toBe('beauty');
      expect(shelfFor(dad.id)?.exploreQuery.category).toBe('electronics');
    });

    it('a Home tile opens the same shelf its Discover section showed', async () => {
      const rohan = await someone('rohan_f5', 'Rohan');
      const shelfFor = async (query: string) => {
        const res = await request(app.getHttpServer())
          .get(`${V1}/discover/occasions/birthday${query}`)
          .set(auth(rohan.token))
          .expect(200);
        return (res.body as Envelope<{ exploreQuery: { category: string | null } }>).data
          .exploreQuery.category;
      };

      expect(await shelfFor('?relation=Mom')).toBe('beauty');
      expect(await shelfFor('?relation=Dad')).toBe('electronics');
      // Without one, what it always was.
      expect(await shelfFor('')).toBe('electronics');
    });

    it('a linked date costs the feed no more searches than an unlinked one', async () => {
      const priyal = await someone('priyal_f4', 'Priyal');
      const rohan = await someone('rohan_f4', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);
      const date = await saveDate(rohan, { personName: 'Priyal' });

      const search = jest.spyOn(products, 'search');
      await feedOf(rohan);
      const unlinked = search.mock.calls.length;

      await linkDate(rohan, date.id, priyal).expect(200);
      search.mockClear();
      await feedOf(rohan);

      expect(search.mock.calls.length).toBeLessThanOrEqual(unlinked);
    });
  });

  describe('a guest holding an invitation', () => {
    const inviteTokenFor = async (host: Actor, guest: Actor, event: Record<string, unknown>) => {
      const created = await request(app.getHttpServer())
        .post(`${V1}/events`)
        .set(auth(host.token))
        .send({
          title: 'Big Party',
          type: 'birthday',
          startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          timezone: 'Asia/Kolkata',
          ...event,
        })
        .expect(201);
      const eventId = (created.body as Envelope<{ id: string }>).data.id;
      await request(app.getHttpServer())
        .post(`${V1}/events/${eventId}/publish`)
        .set(auth(host.token))
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/events/${eventId}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);
      const list = await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites`)
        .set(auth(host.token))
        .expect(200);
      const inviteId = (list.body as Envelope<{ id: string }[]>).data[0].id;
      const link = await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites/${inviteId}/link`)
        .set(auth(host.token))
        .expect(200);
      return (link.body as Envelope<{ url: string }>).data.url.split('/').pop()!;
    };

    const shelfFor = (token: string) =>
      request(app.getHttpServer()).get(`${V1}/public/invites/${token}/gift-suggestions`);

    it("is shown the occasion's shelf, and never who anybody is", async () => {
      const priyal = await someone('priyal_i1', 'Priyal');
      const host = await someone('host_i1', 'Host');
      const guest = await someone('guest_i1', 'Guest');
      await connect(host, priyal);
      await setTaste(priyal, techLover);
      const token = await inviteTokenFor(host, guest, {
        personName: 'Priyal',
        personUserId: priyal.userId,
        relation: 'parents_mother',
      });

      const res = await shelfFor(token).expect(200);
      const body = (
        res.body as Envelope<{
          title: string;
          items: unknown[];
          personalised: boolean;
          exploreQuery: { category: string | null };
        }>
      ).data;

      expect(body.title).toBe('Gift ideas for Priyal');
      expect(body.personalised).toBe(false);
      // Birthday, for a mother — the relation picks the shelf, not her taste.
      expect(body.exploreQuery.category).toBe('beauty');
      // No id of anybody's, anywhere in what an unauthenticated caller gets.
      const raw = JSON.stringify(res.body);
      for (const id of [priyal.userId, host.userId, guest.userId]) {
        expect(raw).not.toContain(id);
      }
    });

    it('a failing search is an empty shelf, not an error', async () => {
      const host = await someone('host_i2', 'Host');
      const guest = await someone('guest_i2', 'Guest');
      const token = await inviteTokenFor(host, guest, { personName: 'Siya' });
      fixture.faults = { fail: true };

      const res = await shelfFor(token).expect(200);

      expect((res.body as Envelope<{ items: unknown[] }>).data.items).toEqual([]);
    });

    it('an unknown token is not found', async () => {
      await shelfFor('no-such-token').expect(404);
    });
  });

  describe('the daily search budget', () => {
    it('past the cap, a shelf with nothing cached is quiet rather than paid for', async () => {
      const priyal = await someone('priyal_b0', 'Priyal');
      const rohan = await someone('rohan_b0', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);
      const today = new Date().toISOString().slice(0, 10);
      await app
        .get(CacheService)
        .set(`suggestions:budget:v1:${rohan.userId}:${today}`, DAILY_SEARCH_HARD_CAP, 60);
      const vendor = jest.spyOn(fixture, 'search');

      // Not a 503: the budget is ours, and the vendor is not down.
      const res = await suggestionsFor(rohan, priyal).expect(200);

      expect(vendor).not.toHaveBeenCalled();
      expect((res.body as Envelope<SuggestionsBody>).data.items).toEqual([]);
    });

    it('past the cap, the shelf comes from the cache and nothing new is searched', async () => {
      const priyal = await someone('priyal_b1', 'Priyal');
      const rohan = await someone('rohan_b1', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);
      // Warm the shelves, then spend the day.
      await suggestionsFor(rohan, priyal).expect(200);
      const today = new Date().toISOString().slice(0, 10);
      await app
        .get(CacheService)
        .set(`suggestions:budget:v1:${rohan.userId}:${today}`, DAILY_SEARCH_HARD_CAP, 60);
      // A different limit is a different shelf, so this is not the 15-minute
      // result cache answering.
      const vendor = jest.spyOn(fixture, 'search');

      const res = await suggestionsFor(rohan, priyal, '?limit=5').expect(200);

      expect(vendor).not.toHaveBeenCalled();
      expect((res.body as Envelope<SuggestionsBody>).data.items.length).toBeGreaterThan(0);
    });
  });

  describe('the taste prewarm', () => {
    it('warms the keyword searches real taste asks for, and only those', async () => {
      const priyal = await someone('priyal_w1', 'Priyal');
      const rohan = await someone('rohan_w1', 'Rohan');
      await setTaste(priyal, techLover);
      await setTaste(rohan, techLover);
      const vendor = jest.spyOn(fixture, 'search');

      const report = await app.get(TastePrewarmService).prewarm();

      expect(report.queries).toBeGreaterThan(0);
      expect(report.warmed).toBe(report.queries);
      // The plain category shelves are the shared prewarm's; this one only
      // pays for what has a keyword on it.
      for (const [query] of vendor.mock.calls) expect(query.q).toBeTruthy();
    });
  });

  describe('who may ask', () => {
    it('a stranger is refused', async () => {
      const priyal = await someone('priyal_s1', 'Priyal');
      const rohan = await someone('rohan_s1', 'Rohan');

      const res = await suggestionsFor(rohan, priyal).expect(403);

      expect((res.body as Envelope<unknown>).error?.code).toBe('NOT_WISHMATES');
    });

    it('a pending request is not enough', async () => {
      const priyal = await someone('priyal_s2', 'Priyal');
      const rohan = await someone('rohan_s2', 'Rohan');
      await request(app.getHttpServer())
        .post(`${V1}/people/${priyal.userId}/request`)
        .set(auth(rohan.token))
        .expect(201);

      await suggestionsFor(rohan, priyal).expect(403);
    });

    it('an accepted WishMate is answered', async () => {
      const priyal = await someone('priyal_s3', 'Priyal');
      const rohan = await someone('rohan_s3', 'Rohan');
      await connect(rohan, priyal);

      const res = await suggestionsFor(rohan, priyal).expect(200);
      const body = (res.body as Envelope<SuggestionsBody>).data;

      expect(body.title).toBe('Gift ideas for Priyal');
      expect(body.items.length).toBeGreaterThan(0);
    });

    it('so is the person themself', async () => {
      const priyal = await someone('priyal_s4', 'Priyal');

      const res = await suggestionsFor(priyal, priyal).expect(200);

      expect((res.body as Envelope<SuggestionsBody>).data.title).toBe('Gift ideas for you');
    });

    it('an id that is not an account is not found, not refused', async () => {
      // A 403 would confirm the account exists.
      const rohan = await someone('rohan_s5', 'Rohan');

      await request(app.getHttpServer())
        .get(`${V1}/people/507f1f77bcf86cd799439011/gift-suggestions`)
        .set(auth(rohan.token))
        .expect(404);
    });
  });

  describe('what comes back', () => {
    it('is ranked by what the person said they like', async () => {
      const priyal = await someone('priyal_s6', 'Priyal');
      const rohan = await someone('rohan_s6', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);

      const res = await suggestionsFor(rohan, priyal).expect(200);
      const body = (res.body as Envelope<SuggestionsBody>).data;

      expect(body.personalised).toBe(true);
      expect(body.reasonCode).toBeNull();
      expect(body.note).toBeNull();
      // "Smart Speaker" matches the smart-home interest; it leads the shelf.
      expect(body.items[0].product.title).toBe('Smart Speaker');
      expect(body.items[0].reasons).toContain('Likes Smart Home');
      expect(body.exploreQuery.category).toBe('electronics');
    });

    it('says so when it could not be personal', async () => {
      // Nothing said, so the shelf goes by the default — and must not claim
      // otherwise.
      const priyal = await someone('priyal_s7', 'Priyal');
      const rohan = await someone('rohan_s7', 'Rohan');
      await connect(rohan, priyal);

      const res = await suggestionsFor(rohan, priyal).expect(200);
      const body = (res.body as Envelope<SuggestionsBody>).data;

      expect(body.personalised).toBe(false);
      expect(body.reasonCode).toBe('no_preferences');
      expect(body.note).toBe('Priyal has not added any likes yet, so these are popular picks.');
    });

    it('never costs more than three product searches', async () => {
      // The regression that costs real money.
      const priyal = await someone('priyal_s8', 'Priyal');
      const rohan = await someone('rohan_s8', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);
      const search = jest.spyOn(products, 'search');

      await suggestionsFor(rohan, priyal).expect(200);

      expect(search.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('a dead product search is a 503 the app already understands', async () => {
      const priyal = await someone('priyal_s9', 'Priyal');
      const rohan = await someone('rohan_s9', 'Rohan');
      await connect(rohan, priyal);
      fixture.faults = { fail: true };

      const res = await suggestionsFor(rohan, priyal, '?maxPriceMinor=777777').expect(503);

      expect((res.body as Envelope<unknown>).error?.code).toBe('PRODUCT_SEARCH_UNAVAILABLE');
    });
  });

  describe('searching for somebody', () => {
    interface SearchBody {
      items: {
        title: string;
        externalId: string;
        matchScore: number;
        reasons: string[];
      }[];
      recipient: { userId: string; displayName: string | null };
      personalised: boolean;
      page: number;
    }

    const searchFor = (viewer: Actor, target: Actor, query: string) =>
      request(app.getHttpServer())
        .get(`${V1}/people/${target.userId}/gift-search${query}`)
        .set(auth(viewer.token));

    it('a stranger is refused', async () => {
      const priyal = await someone('priyal_g1', 'Priyal');
      const rohan = await someone('rohan_g1', 'Rohan');

      await searchFor(rohan, priyal, '?category=electronics').expect(403);
    });

    it('returns the same products as the ordinary search, reordered', async () => {
      // Nothing about the person reaches the vendor or the cache: the page is
      // the page everybody gets, in an order that suits them.
      const priyal = await someone('priyal_g2', 'Priyal');
      const rohan = await someone('rohan_g2', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);

      const plain = await request(app.getHttpServer())
        .get(`${V1}/products/search?category=electronics`)
        .set(auth(rohan.token))
        .expect(200);
      const forHer = await searchFor(rohan, priyal, '?category=electronics').expect(200);

      const plainIds = (plain.body as Envelope<SearchBody>).data.items.map((i) => i.externalId);
      const body = (forHer.body as Envelope<SearchBody>).data;
      expect([...body.items.map((i) => i.externalId)].sort()).toEqual([...plainIds].sort());
      expect(body.items[0].title).toBe('Smart Speaker');
      expect(body.personalised).toBe(true);
      expect(body.recipient).toEqual({ userId: priyal.userId, displayName: 'Priyal' });
    });

    it('carries per-row reasons, so the app can say why a product is there', async () => {
      const priyal = await someone('priyal_g6', 'Priyal');
      const rohan = await someone('rohan_g6', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);

      const res = await searchFor(rohan, priyal, '?category=electronics').expect(200);
      const items = (res.body as Envelope<SearchBody>).data.items;

      // On the product, not wrapping it: an app built before this shipped
      // reads these pages as plain products.
      for (const item of items) {
        expect(typeof item.matchScore).toBe('number');
        expect(Array.isArray(item.reasons)).toBe(true);
      }
      expect(items.some((i) => i.reasons.length > 0)).toBe(true);
    });

    it('answers with empty reasons when there is no taste to explain', async () => {
      const priyal = await someone('priyal_g7', 'Priyal');
      const rohan = await someone('rohan_g7', 'Rohan');
      await connect(rohan, priyal);

      const res = await searchFor(rohan, priyal, '?category=electronics').expect(200);
      const items = (res.body as Envelope<SearchBody>).data.items;

      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.reasons.length === 0 && i.matchScore === 0)).toBe(true);
    });

    it('keeps the paging of the ordinary search', async () => {
      const priyal = await someone('priyal_g3', 'Priyal');
      const rohan = await someone('rohan_g3', 'Rohan');
      await connect(rohan, priyal);

      const res = await searchFor(rohan, priyal, '?page=2&pageSize=5').expect(200);
      const body = (res.body as Envelope<SearchBody>).data;

      expect(body.page).toBe(2);
      expect(body.items).toHaveLength(5);
    });

    it('says when there was nothing to order by', async () => {
      const priyal = await someone('priyal_g4', 'Priyal');
      const rohan = await someone('rohan_g4', 'Rohan');
      await connect(rohan, priyal);

      const res = await searchFor(rohan, priyal, '?category=books').expect(200);

      expect((res.body as Envelope<SearchBody>).data.personalised).toBe(false);
    });

    it('the suggestion shelf hands its person to Explore More', async () => {
      const priyal = await someone('priyal_g5', 'Priyal');
      const rohan = await someone('rohan_g5', 'Rohan');
      await connect(rohan, priyal);

      const res = await suggestionsFor(rohan, priyal).expect(200);
      const query = (
        res.body as Envelope<{
          exploreQuery: { recipientUserId: string; recipientName: string };
        }>
      ).data.exploreQuery;

      expect(query.recipientUserId).toBe(priyal.userId);
      expect(query.recipientName).toBe('Priyal');
    });
  });

  describe('the taste summary on a profile', () => {
    it('a WishMate sees it, in labels', async () => {
      const priyal = await someone('priyal_t1', 'Priyal');
      const rohan = await someone('rohan_t1', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);

      const { taste } = await profileOf(rohan, priyal);

      expect(taste).not.toBeNull();
      expect(taste!.title).toBe('What Priyal likes');
      expect(taste!.interests.map((i) => i.label)).toContain('Smart Home');
      expect(taste!.colours[0]).toEqual(
        expect.objectContaining({ key: 'blue_navy', label: 'Navy' }),
      );
      expect(taste!.customInterests).toEqual(['Vinyl records']);
    });

    it('a stranger gets nothing — not an empty card, nothing', async () => {
      const priyal = await someone('priyal_t2', 'Priyal');
      const rohan = await someone('rohan_t2', 'Rohan');
      await setTaste(priyal, techLover);

      const { taste } = await profileOf(rohan, priyal);

      expect(taste).toBeNull();
    });

    it('sizes are shared by default', async () => {
      const priyal = await someone('priyal_t3', 'Priyal');
      const rohan = await someone('rohan_t3', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, techLover);

      const { taste } = await profileOf(rohan, priyal);

      expect(taste!.sizes).toEqual({ clothing: 'XL', shoe: 'UK 9', fit: 'Relaxed' });
    });

    it('and withheld entirely once the owner turns them off', async () => {
      const priyal = await someone('priyal_t4', 'Priyal');
      const rohan = await someone('rohan_t4', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, { ...techLover, shareSizes: false });

      const res = await request(app.getHttpServer())
        .get(`${V1}/people/${priyal.userId}`)
        .set(auth(rohan.token))
        .expect(200);
      const { taste } = (res.body as Envelope<{ taste: TasteBody | null }>).data;

      expect(taste!.sizes).toBeNull();
      // Not anywhere in the payload, not merely blanked in one place.
      expect(JSON.stringify(res.body)).not.toContain('"XL"');
      // The rest of the taste is still there.
      expect(taste!.interests.length).toBeGreaterThan(0);
    });

    it('hidden interests leave the card, and the shelf', async () => {
      const priyal = await someone('priyal_v1', 'Priyal');
      const rohan = await someone('rohan_v1', 'Rohan');
      await connect(rohan, priyal);
      await setTaste(priyal, { ...techLover, shareInterests: false });

      const res = await request(app.getHttpServer())
        .get(`${V1}/people/${priyal.userId}`)
        .set(auth(rohan.token))
        .expect(200);
      const { taste } = (res.body as Envelope<{ taste: TasteBody | null }>).data;
      expect(taste!.interests).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('Smart Home');
      // Only interests: colours and the free text are still shared.
      expect(taste!.colours.length).toBeGreaterThan(0);

      // Nor may the suggestions give them away in a reason.
      const shelf = (await suggestionsFor(rohan, priyal).expect(200))
        .body as Envelope<SuggestionsBody>;
      const reasons = shelf.data.items.flatMap((i) => i.reasons);
      expect(reasons.filter((r) => r.startsWith('Likes'))).toEqual([]);
    });

    it('the owner still sees, and is still shopped for by, all of it', async () => {
      const priyal = await someone('priyal_v2', 'Priyal');
      await setTaste(priyal, {
        ...techLover,
        shareInterests: false,
        shareColours: false,
        shareCustomInterests: false,
      });

      const own = await profileOf(priyal, priyal);
      expect(own.taste!.interests.length).toBeGreaterThan(0);
      expect(own.taste!.colours.length).toBeGreaterThan(0);
      expect(own.taste!.customInterests).toEqual(['Vinyl records']);
    });

    it('each switch is readable back from /me, and on by default', async () => {
      const priyal = await someone('priyal_v3', 'Priyal');
      const me = async () =>
        (
          (await request(app.getHttpServer()).get(`${V1}/me`).set(auth(priyal.token)).expect(200))
            .body as Envelope<{ profile: { preferences: Record<string, unknown> } }>
        ).data.profile.preferences;

      expect(await me()).toMatchObject({
        shareInterests: true,
        shareCustomInterests: true,
        shareColours: true,
        shareSizes: true,
      });
      await setTaste(priyal, { shareColours: false });
      // Turning one off leaves the others, and the taste itself, alone.
      expect(await me()).toMatchObject({ shareColours: false, shareInterests: true });
    });

    it('the owner sees their own sizes whatever the switch says', async () => {
      const priyal = await someone('priyal_t5', 'Priyal');
      await setTaste(priyal, { ...techLover, shareSizes: false });

      const { taste } = await profileOf(priyal, priyal);

      expect(taste!.isSelf).toBe(true);
      expect(taste!.sizes?.clothing).toBe('XL');
    });

    it('the switch is readable back from /me', async () => {
      const priyal = await someone('priyal_t6', 'Priyal');
      await setTaste(priyal, { shareSizes: false });

      const res = await request(app.getHttpServer())
        .get(`${V1}/me`)
        .set(auth(priyal.token))
        .expect(200);
      const me = (res.body as Envelope<{ profile: { preferences: { shareSizes: boolean } } }>).data;

      expect(me.profile.preferences.shareSizes).toBe(false);
    });
  });
});
