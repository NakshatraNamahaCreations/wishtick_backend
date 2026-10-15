import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { AuthService } from 'src/modules/auth/auth.service';
import { ChatService } from 'src/modules/chat/chat.service';
import { migration040 } from 'src/infra/migrations/scripts/040-block-held-link';
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
 * A direct chat after one side blocks the other.
 *
 * The owner's rules: the person blocked is not told. They can keep writing,
 * but nothing they write reaches the blocker — and the blocker reads as
 * missing to them ("User not found"). When the blocker unblocks, everything
 * written meanwhile is there for them, and the two are back to normal:
 * WishMates, talking.
 *
 * Asha blocks Bala throughout.
 */
describe('Direct chat across a block (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let seq = 0;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());

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
    http().post(`${V1}/chats/direct/${other.userId}`).set(auth(actor.token));

  const post = (actor: Actor, chatId: string, body: string) =>
    http().post(`${V1}/chats/${chatId}/messages`).set(auth(actor.token)).send({ body });

  const react = (actor: Actor, messageId: string) =>
    http()
      .post(`${V1}/messages/${messageId}/reactions`)
      .set(auth(actor.token))
      .send({ emoji: '❤️' });

  /** Newest first, as the thread pages. */
  const history = async (actor: Actor, chatId: string): Promise<string[]> =>
    (
      (await http().get(`${V1}/chats/${chatId}/messages`).set(auth(actor.token)).expect(200))
        .body as Envelope<{ items: { body: string }[] }>
    ).data.items.map((m) => m.body);

  const chatOf = async (actor: Actor, chatId: string) =>
    (
      (await http().get(`${V1}/chats/${chatId}`).set(auth(actor.token)).expect(200))
        .body as Envelope<{
        unreadCount: number;
        lastMessage: { body: string } | null;
        counterpart: { online: boolean } | null;
      }>
    ).data;

  const markRead = (actor: Actor, chatId: string) =>
    http().post(`${V1}/chats/${chatId}/read`).set(auth(actor.token)).send({}).expect(200);

  const relationship = async (actor: Actor, other: Actor): Promise<string> =>
    (
      (await http().get(`${V1}/people/${other.userId}`).set(auth(actor.token)).expect(200))
        .body as Envelope<{ relationship: string }>
    ).data.relationship;

  /** Gives [actor] a phone, so a chat message has somewhere to ring. */
  const withPhone = async (actor: Actor) => {
    // Anything already on its way goes first, or it lands on the new phone.
    await new Promise((r) => setTimeout(r, 300));
    await ctx.drainNotifications();
    await http()
      .post(`${V1}/me/devices`)
      .set(auth(actor.token))
      .send({ token: `phone-${actor.userId}`, platform: 'android', deviceName: 'Pixel 8' })
      .expect(200);
    ctx.push.reset();
  };

  /**
   * The chat pushes that reached [actor]'s phone — chat messages are push
   * only, with no row in the notification centre.
   */
  const chatPushes = async (actor: Actor) => {
    // The listener runs after the response; give it a moment to enqueue.
    await new Promise((r) => setTimeout(r, 300));
    await ctx.drainNotifications();
    return ctx.push.sent.filter(
      (s) => s.data?.type === 'chat_message' && s.tokens.includes(`phone-${actor.userId}`),
    );
  };

  const befriend = async (x: Actor, y: Actor) => {
    for (const [from, to] of [
      [x, y],
      [y, x],
    ]) {
      await http().post(`${V1}/people/${to.userId}/request`).set(auth(from.token)).expect(201);
    }
  };

  /** Asha and Bala, WishMates, with a message each in their thread. */
  const conversation = async () => {
    const a = await newUser();
    const b = await newUser();
    await befriend(a, b);
    const chatId = ((await open(a, b).expect(201)).body as Envelope<{ chatId: string }>).data
      .chatId;
    const hers = ((await post(a, chatId, 'Hi Bala').expect(201)).body as Envelope<{ id: string }>)
      .data.id;
    await post(b, chatId, 'Hi Asha').expect(201);
    return { a, b, chatId, hers };
  };

  const block = (blocker: Actor, blocked: Actor) =>
    http().post(`${V1}/people/${blocked.userId}/block`).set(auth(blocker.token)).expect(204);

  const unblock = (blocker: Actor, blocked: Actor) =>
    http().delete(`${V1}/people/${blocked.userId}/block`).set(auth(blocker.token)).expect(204);

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

  it('the one blocked can still write, and sees it sent', async () => {
    const { a, b, chatId } = await conversation();
    await block(a, b);

    await post(b, chatId, 'are you there?').expect(201);

    expect(await history(b, chatId)).toEqual(['are you there?', 'Hi Asha', 'Hi Bala']);
  });

  it('…and none of it reaches the one who blocked them', async () => {
    const { a, b, chatId } = await conversation();
    await withPhone(a);
    // Her phone rings for him while they are WishMates…
    await post(b, chatId, 'Hi again').expect(201);
    expect(await chatPushes(a)).toHaveLength(1);
    await markRead(a, chatId);
    await block(a, b);

    await post(b, chatId, 'are you there?').expect(201);

    expect(await history(a, chatId)).toEqual(['Hi again', 'Hi Asha', 'Hi Bala']);
    const seen = await chatOf(a, chatId);
    expect(seen.unreadCount).toBe(0);
    expect(seen.lastMessage?.body).toBe('Hi again');
    // …and not for what he writes once she has blocked him.
    expect(await chatPushes(a)).toHaveLength(1);
  });

  it('the one who blocked cannot write', async () => {
    const { a, b, chatId } = await conversation();
    await block(a, b);

    await post(a, chatId, 'one more').expect(403);
  });

  it('takes no reaction, from either side', async () => {
    const { a, b, hers } = await conversation();
    // Reacting works while they are WishMates.
    await react(b, hers).expect(200);

    await block(a, b);

    await react(a, hers).expect(403);
    await react(b, hers).expect(403);
  });

  it('the one blocked finds the blocker missing', async () => {
    const { a, b, chatId } = await conversation();
    await block(a, b);

    const res = await http().get(`${V1}/people/${a.userId}`).set(auth(b.token)).expect(404);
    expect((res.body as Envelope<never>).error?.code).toBe('NOT_FOUND');
    // Nor do they watch the blocker come and go.
    expect((await chatOf(b, chatId)).counterpart?.online).toBe(false);
  });

  it('the blocker reading the thread does not mark what is held as read', async () => {
    const { a, b, chatId } = await conversation();
    await block(a, b);
    await post(b, chatId, 'are you there?').expect(201);

    // Opening the thread marks it read up to the newest message — the newest
    // *they can see*, or what is held would arrive already read.
    await markRead(a, chatId);
    await unblock(a, b);

    expect((await chatOf(a, chatId)).unreadCount).toBe(1);
  });

  it('after an unblock: everything written meanwhile, and back to normal', async () => {
    const { a, b, chatId, hers } = await conversation();
    await markRead(a, chatId);
    await block(a, b);
    await post(b, chatId, 'are you there?').expect(201);
    await post(b, chatId, 'hello?').expect(201);
    await withPhone(a);

    await unblock(a, b);

    expect(await history(a, chatId)).toEqual(['hello?', 'are you there?', 'Hi Asha', 'Hi Bala']);
    const seen = await chatOf(a, chatId);
    expect(seen.unreadCount).toBe(2);
    expect(seen.lastMessage?.body).toBe('hello?');
    // WishMates again, both ways, and the thread is open to both.
    expect(await relationship(a, b)).toBe('wishmates');
    expect(await relationship(b, a)).toBe('wishmates');
    // The backlog is there to read, not rung through as notifications.
    expect(await chatPushes(a)).toHaveLength(0);
    await post(a, chatId, 'sorry, I am here').expect(201);
    await post(b, chatId, 'yay').expect(201);
    await react(a, hers).expect(200);
    // What he writes now rings as it always did.
    expect(await chatPushes(a)).toHaveLength(1);
  });

  it('a delete while blocked keeps what was never seen', async () => {
    const { a, b, chatId } = await conversation();
    await block(a, b);
    await post(b, chatId, 'are you there?').expect(201);

    await http().post(`${V1}/chats/${chatId}/clear`).set(auth(a.token)).expect(200);
    await unblock(a, b);

    expect(await history(a, chatId)).toEqual(['are you there?']);
  });

  it('blocked both ways: the connection waits for both to unblock', async () => {
    const { a, b, chatId } = await conversation();
    await block(a, b);
    await block(b, a);

    // Having blocked her, Bala cannot write to Asha either.
    await post(b, chatId, 'one more').expect(403);

    await unblock(a, b);
    // Bala's block still stands, so Asha is now the one blocked: she can
    // write, unseen, and Bala still cannot.
    await post(a, chatId, 'hi?').expect(201);
    expect(await history(b, chatId)).not.toContain('hi?');
    await post(b, chatId, 'one more').expect(403);

    await unblock(b, a);
    expect(await relationship(a, b)).toBe('wishmates');
    expect(await history(b, chatId)).toContain('hi?');
    await post(b, chatId, 'hello again').expect(201);
  });

  it('people who were never WishMates get nothing back from a block', async () => {
    const a = await newUser();
    const b = await newUser();
    await block(a, b);

    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const res = await open(x, y).expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe('NOT_WISHMATES');
    }
    await unblock(a, b);
    expect(await relationship(a, b)).toBe('none');
  });

  describe('blocks made before this (migration 040)', () => {
    const db = () => app.get<Connection>(getConnectionToken()).db!;

    it('holds the connection where a chat shows they were WishMates', async () => {
      const { a, b, chatId } = await conversation();
      // A block as it used to be written: the link deleted, nothing kept.
      await db()
        .collection('wish_links')
        .deleteMany({
          $or: [
            { requesterId: new Types.ObjectId(a.userId) },
            { addresseeId: new Types.ObjectId(a.userId) },
          ],
        });
      await db()
        .collection('user_blocks')
        .insertOne({
          blockerId: new Types.ObjectId(a.userId),
          blockedId: new Types.ObjectId(b.userId),
          createdAt: new Date(),
        });
      await post(b, chatId, 'are you there?').expect(403);

      await migration040.up(db());

      await post(b, chatId, 'are you there?').expect(201);
      await unblock(a, b);
      expect(await relationship(a, b)).toBe('wishmates');
      expect(await history(a, chatId)).toContain('are you there?');
    });

    it('holds nothing between people with no chat', async () => {
      const a = await newUser();
      const b = await newUser();
      await db()
        .collection('user_blocks')
        .insertOne({
          blockerId: new Types.ObjectId(a.userId),
          blockedId: new Types.ObjectId(b.userId),
          createdAt: new Date(),
        });

      await migration040.up(db());

      const row = await db()
        .collection('user_blocks')
        .findOne({ blockerId: new Types.ObjectId(a.userId) });
      expect(row?.heldLink).toBeNull();
      // The pair hash the migration restates must match the service's.
      expect(
        await db()
          .collection('chats')
          .countDocuments({ refId: ChatService.directRefId(a.userId, b.userId) }),
      ).toBe(0);
    });
  });
});
