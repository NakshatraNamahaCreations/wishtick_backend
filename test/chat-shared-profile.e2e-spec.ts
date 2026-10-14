import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthService } from 'src/modules/auth/auth.service';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
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
interface SharedMessage {
  id: string;
  kind: string;
  body: string;
  sharedUserId: string | null;
  sharedProfile: {
    userId: string;
    displayName: string | null;
    username: string | null;
  } | null;
}

/**
 * Sharing somebody's profile into a chat — a direct one, a wishlist's or a
 * group gift's — as a card with Send Request and View Profile.
 */
describe('Shared profiles in chat (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let seq = 0;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const newUser = async (name: string): Promise<Actor> => {
    const email = `share.profile${++seq}.${Date.now()}@example.com`;
    const { user, tokens } = await authService.signup(
      { email, password: PASSWORD, name },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    const actor = { token: tokens.accessToken, userId: user.id };
    await rename(actor, name);
    return actor;
  };

  const rename = async (actor: Actor, displayName: string): Promise<void> => {
    await request(app.getHttpServer())
      .patch(`${V1}/me`)
      .set(auth(actor.token))
      .send({ displayName })
      .expect(200);
  };

  const befriend = async (a: Actor, b: Actor): Promise<void> => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      await request(app.getHttpServer())
        .post(`${V1}/people/${y.userId}/request`)
        .set(auth(x.token))
        .expect(201);
    }
  };

  /** Asha and Bala, WishMates with a thread between them. */
  const thread = async (): Promise<{ a: Actor; b: Actor; chatId: string }> => {
    const a = await newUser('Asha');
    const b = await newUser('Bala');
    await befriend(a, b);
    const opened = (
      await request(app.getHttpServer())
        .post(`${V1}/chats/direct/${b.userId}`)
        .set(auth(a.token))
        .expect(201)
    ).body as Envelope<{ chatId: string }>;
    return { a, b, chatId: opened.data.chatId };
  };

  const share = (actor: Actor, chatId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`${V1}/chats/${chatId}/messages`)
      .set(auth(actor.token))
      .send(body);

  const history = async (actor: Actor, chatId: string): Promise<SharedMessage[]> =>
    (
      (
        await request(app.getHttpServer())
          .get(`${V1}/chats/${chatId}/messages`)
          .set(auth(actor.token))
          .expect(200)
      ).body as Envelope<{ items: SharedMessage[] }>
    ).data.items;

  const block = async (blocker: Actor, blocked: Actor): Promise<void> => {
    await request(app.getHttpServer())
      .post(`${V1}/people/${blocked.userId}/block`)
      .set(auth(blocker.token))
      .expect((res) => expect([200, 201, 204]).toContain(res.status));
  };

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

  describe('in a direct chat', () => {
    it('arrives as a card naming the person, for the sender and the reader', async () => {
      const { a, b, chatId } = await thread();
      const chitra = await newUser('Chitra');

      const sent = (await share(a, chatId, { sharedUserId: chitra.userId }).expect(201))
        .body as Envelope<SharedMessage>;
      expect(sent.data).toMatchObject({
        kind: 'profile',
        body: '',
        sharedUserId: chitra.userId,
        sharedProfile: { userId: chitra.userId, displayName: 'Chitra' },
      });

      const [seen] = await history(b, chatId);
      expect(seen.sharedProfile).toMatchObject({ userId: chitra.userId, displayName: 'Chitra' });
    });

    it('shows the person as they are now, not as they were', async () => {
      const { a, b, chatId } = await thread();
      const chitra = await newUser('Chitra');
      await share(a, chatId, { sharedUserId: chitra.userId }).expect(201);

      await rename(chitra, 'Chitra Rao');

      const [seen] = await history(b, chatId);
      expect(seen.sharedProfile?.displayName).toBe('Chitra Rao');
    });

    it('can carry a note', async () => {
      const { a, chatId } = await thread();
      const chitra = await newUser('Chitra');

      const sent = (
        await share(a, chatId, {
          sharedUserId: chitra.userId,
          body: 'You two should meet!',
        }).expect(201)
      ).body as Envelope<SharedMessage>;
      expect(sent.data).toMatchObject({ kind: 'profile', body: 'You two should meet!' });
    });

    // Chat messages reach a phone as a push only — the chat list carries its
    // own unread dots, so they have no row in the notification centre.
    it('says what it is on the lock screen', async () => {
      const { a, b, chatId } = await thread();
      const chitra = await newUser('Chitra');
      await request(app.getHttpServer())
        .post(`${V1}/me/devices`)
        .set(auth(b.token))
        .send({ token: 'bala-phone', platform: 'android', deviceName: 'Pixel 8' })
        .expect(200);
      ctx.push.reset();

      await share(a, chatId, { sharedUserId: chitra.userId }).expect(201);
      // The listener runs after the response; give it a moment to enqueue.
      await new Promise((r) => setTimeout(r, 300));
      await ctx.drainNotifications();

      const pushes = ctx.push.sent.filter((s) => s.data?.type === 'chat_message');
      expect(pushes).toHaveLength(1);
      expect(pushes[0].body).toContain('Shared a profile: Chitra');
    });

    it('shows as a profile in the chat list', async () => {
      const { a, b, chatId } = await thread();
      const chitra = await newUser('Chitra');
      await share(a, chatId, { sharedUserId: chitra.userId }).expect(201);

      const chats = (
        (await request(app.getHttpServer()).get(`${V1}/chats`).set(auth(b.token)).expect(200))
          .body as Envelope<{ id: string; lastMessage: { kind: string } | null }[]>
      ).data;
      expect(chats.find((c) => c.id === chatId)?.lastMessage?.kind).toBe('profile');
    });

    it('leaves nothing behind once deleted', async () => {
      const { a, b, chatId } = await thread();
      const chitra = await newUser('Chitra');
      const sent = (await share(a, chatId, { sharedUserId: chitra.userId }).expect(201))
        .body as Envelope<SharedMessage>;

      await request(app.getHttpServer())
        .delete(`${V1}/messages/${sent.data.id}`)
        .set(auth(a.token))
        .expect(200);

      const [seen] = await history(b, chatId);
      expect(seen).toMatchObject({ sharedUserId: null, sharedProfile: null });
    });
  });

  describe('whose profile can be shared', () => {
    it('anyone the sender could open — not only their WishMates', async () => {
      const { a, chatId } = await thread();
      const stranger = await newUser('Stranger');

      await share(a, chatId, { sharedUserId: stranger.userId }).expect(201);
    });

    it('not somebody the sender blocked', async () => {
      const { a, chatId } = await thread();
      const chitra = await newUser('Chitra');
      await block(a, chitra);

      await share(a, chatId, { sharedUserId: chitra.userId }).expect(404);
    });

    it('not somebody who blocked the sender', async () => {
      const { a, chatId } = await thread();
      const chitra = await newUser('Chitra');
      await block(chitra, a);

      await share(a, chatId, { sharedUserId: chitra.userId }).expect(404);
    });

    it('not an account that does not exist', async () => {
      const { a, chatId } = await thread();

      await share(a, chatId, { sharedUserId: '64b000000000000000000000' }).expect(404);
      await share(a, chatId, { sharedUserId: 'not-an-id' }).expect(400);
    });

    it('a reader blocked from that person sees the card, not who it was', async () => {
      const { a, b, chatId } = await thread();
      const chitra = await newUser('Chitra');
      await share(a, chatId, { sharedUserId: chitra.userId }).expect(201);

      await block(b, chitra);

      const [forB] = await history(b, chatId);
      expect(forB).toMatchObject({ kind: 'profile', sharedProfile: null });
      // Everybody else still sees it.
      const [forA] = await history(a, chatId);
      expect(forA.sharedProfile?.displayName).toBe('Chitra');
    });
  });

  describe('in a wishlist chat and a group gift chat', () => {
    const wishlistWithItem = async (owner: Actor) => {
      const wl = (
        (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists`)
            .set(auth(owner.token))
            .send({ title: 'Birthday list', visibility: WishlistVisibility.PUBLIC })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      const item = (
        (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists/${wl}/items`)
            .set(auth(owner.token))
            .send({ title: 'Speaker', price: { amountMinor: 1000 } })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      return { wl, item };
    };

    it('works in a wishlist chat', async () => {
      const owner = await newUser('Owner');
      const friend = await newUser('Friend');
      const chitra = await newUser('Chitra');
      const { wl } = await wishlistWithItem(owner);
      const chatId = (
        (
          await request(app.getHttpServer())
            .get(`${V1}/wishlists/${wl}/chat`)
            .set(auth(friend.token))
            .expect(200)
        ).body as Envelope<{ id: string }>
      ).data.id;

      await share(owner, chatId, { sharedUserId: chitra.userId }).expect(201);

      const [seen] = await history(friend, chatId);
      expect(seen).toMatchObject({ kind: 'profile', sharedProfile: { displayName: 'Chitra' } });
    });

    it('works in a group gift chat', async () => {
      const owner = await newUser('Owner');
      const initiator = await newUser('Initiator');
      const chitra = await newUser('Chitra');
      const { item } = await wishlistWithItem(owner);
      const gg = (
        (
          await request(app.getHttpServer())
            .post(`${V1}/items/${item}/group-gift`)
            .set(auth(initiator.token))
            .set('Idempotency-Key', randomUUID())
            .send({ title: 'Speaker for Owner', targetAmountMinor: 1000 })
            .expect(201)
        ).body as Envelope<{ chatId: string }>
      ).data;

      const sent = (await share(initiator, gg.chatId, { sharedUserId: chitra.userId }).expect(201))
        .body as Envelope<SharedMessage>;
      expect(sent.data).toMatchObject({
        kind: 'profile',
        sharedProfile: { displayName: 'Chitra' },
      });
    });

    // So the app can offer them as places to send a profile, by name.
    it('lists both by name', async () => {
      const owner = await newUser('Owner');
      const initiator = await newUser('Initiator');
      const { wl, item } = await wishlistWithItem(owner);
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wl}/chat`)
        .set(auth(initiator.token))
        .expect(200);
      await request(app.getHttpServer())
        .post(`${V1}/items/${item}/group-gift`)
        .set(auth(initiator.token))
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Speaker for Owner', targetAmountMinor: 1000 })
        .expect(201);

      const chats = (
        (
          await request(app.getHttpServer())
            .get(`${V1}/chats`)
            .set(auth(initiator.token))
            .expect(200)
        ).body as Envelope<{ type: string; title: string | null }[]>
      ).data;
      expect(chats.find((c) => c.type === 'wishlist')?.title).toBe('Birthday list');
      expect(chats.find((c) => c.type === 'group_gift')?.title).toBe('Speaker for Owner');
    });
  });
});
