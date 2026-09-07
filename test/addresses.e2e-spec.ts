import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from 'src/common/errors/error-codes';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface Actor {
  token: string;
  userId: string;
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

describe('Addresses (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (): Promise<Actor> => {
    const email = `addr${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'Siya Rao' })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  /** The exact field set of `324:1340`. */
  const PAYLOAD = {
    label: 'home',
    fullName: 'Siya',
    mobile: '9890900089',
    line1: 'D-Block',
    locality: 'JP Nagar',
    pincode: '570031',
    city: 'Mysuru',
    state: 'Karnataka',
  };

  const addAddress = async (
    actor: Actor,
    over: Record<string, unknown> = {},
  ): Promise<AddressView> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/me/addresses`)
      .set(auth(actor.token))
      .send({ ...PAYLOAD, ...over })
      .expect(201);
    return (res.body as Envelope<AddressView>).data;
  };

  const list = async (actor: Actor): Promise<AddressView[]> =>
    (
      (
        await request(app.getHttpServer())
          .get(`${V1}/me/addresses`)
          .set(auth(actor.token))
          .expect(200)
      ).body as Envelope<AddressView[]>
    ).data;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  // Signup is capped at 5/hour per IP and most tests here mint two users.
  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Creating ───────────────────────────────────────────────────────────────

  it('saves an address and formats the card line the way the design reads', async () => {
    const user = await newUser();
    const saved = await addAddress(user);

    expect(saved.formatted).toBe('D-Block, JP Nagar, Mysuru, Karnataka 570031');
    expect(saved.countryCode).toBe('IN');
    expect(saved.altMobile).toBeNull();
    expect(saved.landmark).toBeNull();
  });

  it('folds a landmark into the formatted line when one is given', async () => {
    const user = await newUser();
    const saved = await addAddress(user, { landmark: 'Near the temple' });
    expect(saved.formatted).toBe('D-Block, JP Nagar, Near the temple, Mysuru, Karnataka 570031');
  });

  it('makes the first address the default even when the client did not ask', async () => {
    const user = await newUser();
    const first = await addAddress(user, { isDefault: false });
    expect(first.isDefault).toBe(true);
  });

  it('rejects a malformed pincode and a malformed mobile', async () => {
    const user = await newUser();
    await request(app.getHttpServer())
      .post(`${V1}/me/addresses`)
      .set(auth(user.token))
      .send({ ...PAYLOAD, pincode: '!!' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${V1}/me/addresses`)
      .set(auth(user.token))
      .send({ ...PAYLOAD, mobile: 'call me' })
      .expect(400);
  });

  it('treats a blank optional field as absent rather than an empty string', async () => {
    const user = await newUser();
    const saved = await addAddress(user, { landmark: '  ' });
    expect(saved.landmark).toBeNull();
  });

  // ── The default ────────────────────────────────────────────────────────────

  it('keeps exactly one default as addresses are added and promoted', async () => {
    const user = await newUser();
    const home = await addAddress(user);
    const work = await addAddress(user, { label: 'work', isDefault: true });

    let book = await list(user);
    expect(book.filter((a) => a.isDefault).map((a) => a.id)).toEqual([work.id]);
    // The default sorts to the top of the address book.
    expect(book[0].id).toBe(work.id);
    expect(home.isDefault).toBe(true);

    await request(app.getHttpServer())
      .post(`${V1}/me/addresses/${home.id}/default`)
      .set(auth(user.token))
      .expect(200);

    book = await list(user);
    expect(book.filter((a) => a.isDefault).map((a) => a.id)).toEqual([home.id]);
  });

  it('promotes a survivor when the default is deleted', async () => {
    const user = await newUser();
    const home = await addAddress(user);
    const work = await addAddress(user, { label: 'work' });
    expect(home.isDefault).toBe(true);

    await request(app.getHttpServer())
      .delete(`${V1}/me/addresses/${home.id}`)
      .set(auth(user.token))
      .expect(204);

    const book = await list(user);
    expect(book).toHaveLength(1);
    expect(book[0].id).toBe(work.id);
    expect(book[0].isDefault).toBe(true);
  });

  it('refuses to clear the only default rather than leaving the book with none', async () => {
    const user = await newUser();
    const only = await addAddress(user);

    // 400, not a silent no-op: the caller asked for something that cannot be
    // honoured, and answering 200 would report a change that did not happen.
    await request(app.getHttpServer())
      .patch(`${V1}/me/addresses/${only.id}`)
      .set(auth(user.token))
      .send({ isDefault: false })
      .expect(400);
  });

  // ── Ownership ──────────────────────────────────────────────────────────────

  it('never shows, edits or deletes another person’s address', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const saved = await addAddress(owner);

    expect(await list(stranger)).toHaveLength(0);

    // 404, not 403 — a stranger must not learn that this id exists.
    //
    // Each request is built inside the loop: supertest fires on the first
    // `then`, so constructing all three up front races them against each
    // other's server teardown.
    const path = `${V1}/me/addresses/${saved.id}`;
    for (const build of [
      () => request(app.getHttpServer()).patch(path).send({ city: 'Delhi' }),
      () => request(app.getHttpServer()).delete(path),
      () => request(app.getHttpServer()).post(`${path}/default`),
    ]) {
      const res = await build().set(auth(stranger.token)).expect(404);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.NOT_FOUND);
    }

    // And it is still there, untouched, for its owner.
    const book = await list(owner);
    expect(book).toHaveLength(1);
    expect(book[0].city).toBe('Mysuru');
  });

  it('answers 404 for a malformed id rather than blowing up on the cast', async () => {
    const user = await newUser();
    await request(app.getHttpServer())
      .delete(`${V1}/me/addresses/not-an-id`)
      .set(auth(user.token))
      .expect(404);
  });

  it('requires a token', async () => {
    await request(app.getHttpServer()).get(`${V1}/me/addresses`).expect(401);
  });
});
