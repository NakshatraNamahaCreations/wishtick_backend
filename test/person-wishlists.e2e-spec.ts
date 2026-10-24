import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import {
  WishLink,
  WishLinkStatus,
  type WishLinkDocument,
} from 'src/modules/wishmates/schemas/wish-link.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  data: T;
}
interface Actor {
  token: string;
  userId: string;
}

const PASSWORD = 'correct-horse-battery-staple';

/**
 * Somebody's wishlists on their profile: only the ones the viewer may open —
 * shared with WishMates, public, or shared with them — never a private one.
 */
describe("A person's wishlists (e2e)", () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (name: string): Promise<Actor> => {
    const email = `plists${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  const makeWishmates = async (a: Actor, b: Actor): Promise<void> => {
    await app.get<Model<WishLinkDocument>>(getModelToken(WishLink.name)).create({
      requesterId: new Types.ObjectId(a.userId),
      addresseeId: new Types.ObjectId(b.userId),
      status: WishLinkStatus.ACCEPTED,
      respondedAt: new Date(),
    });
  };

  const makeList = async (owner: Actor, title: string, visibility: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/wishlists`)
      .set(auth(owner.token))
      .send({ title, visibility })
      .expect(201);
    return (res.body as Envelope<{ id: string }>).data.id;
  };

  const listsOf = async (viewer: Actor, owner: Actor): Promise<string[]> =>
    (
      (
        await request(app.getHttpServer())
          .get(`${V1}/people/${owner.userId}/wishlists`)
          .set(auth(viewer.token))
          .expect(200)
      ).body as Envelope<{ title: string }[]>
    ).data.map((l) => l.title);

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

  it('a WishMate sees the shared and public lists, never the private one', async () => {
    const suma = await newUser('Suma');
    const ravi = await newUser('Ravi');
    await makeWishmates(suma, ravi);
    await makeList(suma, 'Birthday', 'wishmates');
    await makeList(suma, 'Everyone', 'public');
    await makeList(suma, 'Just mine', 'private');

    const titles = await listsOf(ravi, suma);
    expect(titles.sort()).toEqual(['Birthday', 'Everyone']);
  });

  it('a stranger sees only the public ones', async () => {
    const suma = await newUser('Suma');
    const stranger = await newUser('Stranger');
    await makeList(suma, 'Birthday', 'wishmates');
    await makeList(suma, 'Everyone', 'public');

    expect(await listsOf(stranger, suma)).toEqual(['Everyone']);
  });

  it('your own profile lists nothing here', async () => {
    const suma = await newUser('Suma');
    await makeList(suma, 'Birthday', 'wishmates');
    expect(await listsOf(suma, suma)).toEqual([]);
  });
});
