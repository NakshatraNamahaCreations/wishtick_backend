import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AuthService } from 'src/modules/auth/auth.service';
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

/**
 * A direct chat after one side blocks the other: the conversation stays — it
 * opens, and everything said in it can be read — but nothing more can be
 * said in it, not even a reaction.
 */
describe('Direct chat across a block (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let seq = 0;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const newUser = async (): Promise<Actor> => {
    const { user, tokens } = await authService.signup(
      {
        email: `blocked.chat${++seq}.${Date.now()}@example.com`,
        password: PASSWORD,
        name: `U${seq}`,
      },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id };
  };

  const open = (actor: Actor, other: Actor) =>
    request(app.getHttpServer()).post(`${V1}/chats/direct/${other.userId}`).set(auth(actor.token));

  const post = (actor: Actor, chatId: string, body: string) =>
    request(app.getHttpServer())
      .post(`${V1}/chats/${chatId}/messages`)
      .set(auth(actor.token))
      .send({ body });

  const react = (actor: Actor, messageId: string) =>
    request(app.getHttpServer())
      .post(`${V1}/messages/${messageId}/reactions`)
      .set(auth(actor.token))
      .send({ emoji: '❤️' });

  const history = async (actor: Actor, chatId: string): Promise<string[]> =>
    (
      (
        await request(app.getHttpServer())
          .get(`${V1}/chats/${chatId}/messages`)
          .set(auth(actor.token))
          .expect(200)
      ).body as Envelope<{ items: { body: string }[] }>
    ).data.items.map((m) => m.body);

  /** Asha and Bala, WishMates, with a message each in their thread. */
  const conversation = async () => {
    const a = await newUser();
    const b = await newUser();
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      await request(app.getHttpServer())
        .post(`${V1}/people/${y.userId}/request`)
        .set(auth(x.token))
        .expect(201);
    }
    const chatId = ((await open(a, b).expect(201)).body as Envelope<{ chatId: string }>).data
      .chatId;
    const hers = ((await post(a, chatId, 'Hi Bala').expect(201)).body as Envelope<{ id: string }>)
      .data.id;
    await post(b, chatId, 'Hi Asha').expect(201);
    return { a, b, chatId, hers };
  };

  const block = (blocker: Actor, blocked: Actor) =>
    request(app.getHttpServer())
      .post(`${V1}/people/${blocked.userId}/block`)
      .set(auth(blocker.token))
      .expect(204);

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

  it('still opens, for both, with everything said in it', async () => {
    const { a, b, chatId } = await conversation();

    await block(a, b);

    for (const actor of [a, b]) {
      const reopened = (await open(actor, actor === a ? b : a).expect(201)).body as Envelope<{
        chatId: string;
      }>;
      expect(reopened.data.chatId).toBe(chatId);
      expect(await history(actor, chatId)).toEqual(['Hi Asha', 'Hi Bala']);
    }
  });

  it('takes no new message, from either side', async () => {
    const { a, b, chatId } = await conversation();

    await block(a, b);

    await post(a, chatId, 'one more').expect(403);
    await post(b, chatId, 'one more').expect(403);
  });

  it('takes no reaction, from either side', async () => {
    const { a, b, hers } = await conversation();
    // Reacting works while they are WishMates.
    await react(b, hers).expect(200);

    await block(a, b);

    await react(a, hers).expect(403);
    await react(b, hers).expect(403);
  });

  it('after an unblock, the history is still there to read — but not to add to', async () => {
    const { a, b, chatId, hers } = await conversation();
    await block(a, b);

    await request(app.getHttpServer())
      .delete(`${V1}/people/${b.userId}/block`)
      .set(auth(a.token))
      .expect(204);

    // The block ended the connection; unblocking does not restore it.
    expect(await history(a, chatId)).toEqual(['Hi Asha', 'Hi Bala']);
    await post(a, chatId, 'hello again').expect(403);
    await react(a, hers).expect(403);
  });

  it('still starts no thread between people who never had one', async () => {
    const a = await newUser();
    const b = await newUser();
    await block(a, b);

    const res = await open(a, b).expect(403);
    expect((res.body as Envelope<never>).error?.code).toBe('NOT_WISHMATES');
  });
});
