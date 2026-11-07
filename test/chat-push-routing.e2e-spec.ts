import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { AuthService } from 'src/modules/auth/auth.service';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  data: T;
}
interface Actor {
  token: string;
  userId: string;
}

/**
 * A chat push carries what the app needs to open the conversation it is
 * about — not merely the chat list. A message id addresses no screen: a 1:1
 * thread is opened by the person, and a group gift's chat through its gift.
 */
describe('Chat push routing (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let seq = 0;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

  const newUser = async (): Promise<Actor> => {
    const { user, tokens } = await authService.signup(
      {
        email: `push.route${++seq}.${Date.now()}@example.com`,
        password: PASSWORD,
        name: `P${seq}`,
      },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id };
  };

  const withPhone = async (actor: Actor) => {
    await new Promise((r) => setTimeout(r, 300));
    await ctx.drainNotifications();
    await http()
      .post(`${V1}/me/devices`)
      .set(auth(actor.token))
      .send({ token: `phone-${actor.userId}`, platform: 'android', deviceName: 'Pixel 8' })
      .expect(200);
    ctx.push.reset();
  };

  const pushTo = async (actor: Actor) => {
    await new Promise((r) => setTimeout(r, 300));
    await ctx.drainNotifications();
    const pushes = ctx.push.sent.filter(
      (s) => s.data?.type === 'chat_message' && s.tokens.includes(`phone-${actor.userId}`),
    );
    expect(pushes).toHaveLength(1);
    return pushes[0].data ?? {};
  };

  const post = (actor: Actor, chatId: string, body: string) =>
    http().post(`${V1}/chats/${chatId}/messages`).set(auth(actor.token)).send({ body });

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    authService = app.get(AuthService);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it('a direct message says who it is from, to open that conversation', async () => {
    const a = await newUser();
    const b = await newUser();
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      await http().post(`${V1}/people/${y.userId}/request`).set(auth(x.token)).expect(201);
    }
    const chatId = (
      (await http().post(`${V1}/chats/direct/${b.userId}`).set(auth(a.token)).expect(201))
        .body as Envelope<{ chatId: string }>
    ).data.chatId;
    await withPhone(b);

    await post(a, chatId, 'are we still on?').expect(201);

    expect(await pushTo(b)).toMatchObject({
      chatId,
      direct: 'true',
      senderId: a.userId,
      chatType: 'direct',
    });
  });

  it("a group gift's message says which gift, to open its chat", async () => {
    const owner = await newUser();
    const host = await newUser();
    const member = await newUser();
    const wishlistId = (
      (
        await http()
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: 'Birthday', visibility: 'public' })
          .expect(201)
      ).body as Envelope<{ id: string }>
    ).data.id;
    const itemId = (
      (
        await http()
          .post(`${V1}/wishlists/${wishlistId}/items`)
          .set(auth(owner.token))
          .send({ title: 'Speaker', price: { amountMinor: 1000 } })
          .expect(201)
      ).body as Envelope<{ id: string }>
    ).data.id;
    const gg = (
      (
        await http()
          .post(`${V1}/items/${itemId}/group-gift`)
          .set(auth(host.token))
          .set('Idempotency-Key', randomUUID())
          .send({
            title: 'Speaker for Owner',
            targetAmountMinor: 1000,
            visibility: 'visible',
            hostUpiId: 'host@okaxis',
          })
          .expect(201)
      ).body as Envelope<{ id: string; chatId: string }>
    ).data;
    // A member is somebody who chipped in; their first word puts them in the
    // chat's audience.
    await http()
      .post(`${V1}/group-gifts/${gg.id}/contribute`)
      .set(auth(member.token))
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: 500 })
      .expect(201);
    await post(member, gg.chatId, 'I am in!').expect(201);
    await withPhone(member);

    await post(host, gg.chatId, 'Thanks!').expect(201);

    expect(await pushTo(member)).toMatchObject({
      chatId: gg.chatId,
      direct: 'false',
      chatType: 'group_gift',
      chatRefId: gg.id,
    });
  });
});
