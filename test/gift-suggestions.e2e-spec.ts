import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ProductsService } from 'src/modules/products/products.service';
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
      items: { title: string; externalId: string }[];
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
