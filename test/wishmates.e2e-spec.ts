import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { PresenceService } from 'src/modules/wishmates/presence.service';
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
 * WishMates — the connection graph (`4177:138`, `4177:77`, `4177:111`,
 * `4177:42`, `4177:217`, `4177:267`).
 *
 * The rules worth proving are the ones a second row would break: one link per
 * pair whichever way round it was made, direction deciding which tab a request
 * appears in, and a declined request staying invisible to the person who sent
 * it.
 */
describe('WishMates (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A signed-in user who has claimed a handle — the only discoverable kind. */
  const someone = async (username: string): Promise<Actor> => {
    const email = `wm${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: username })
      .expect(201);
    const body = res.body as Envelope<{
      user: { id: string };
      tokens: { accessToken: string };
    }>;
    const actor = { token: body.data.tokens.accessToken, userId: body.data.user.id };
    await request(app.getHttpServer())
      .post(`${V1}/me/username`)
      .set(auth(actor.token))
      .send({ username })
      .expect(201);
    return actor;
  };

  /** Signed in, but never claimed a handle. */
  const anonymousAccount = async (): Promise<Actor> => {
    const email = `wm${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'No Handle' })
      .expect(201);
    const body = res.body as Envelope<{
      user: { id: string };
      tokens: { accessToken: string };
    }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  const get = (a: Actor, path: string) =>
    request(app.getHttpServer()).get(`${V1}${path}`).set(auth(a.token));
  const post = (a: Actor, path: string) =>
    request(app.getHttpServer()).post(`${V1}${path}`).set(auth(a.token));
  const patch = (a: Actor, path: string) =>
    request(app.getHttpServer()).patch(`${V1}${path}`).set(auth(a.token));
  const del = (a: Actor, path: string) =>
    request(app.getHttpServer()).delete(`${V1}${path}`).set(auth(a.token));

  describe('the face other people see', () => {
    it('carries the bundled avatar somebody picked, not just an upload', async () => {
      const alice = await someone('alice_av');
      const bob = await someone('bob_av');
      await patch(alice, '/me').send({ avatarKey: 'avatar_07' }).expect(200);

      // Onboarding offers the twenty bundled avatars before it offers an
      // upload, so this is what most accounts have. It has no URL — the asset
      // ships in the app — so a view that carries only `photoUrl` shows these
      // people to everybody else as a bare initial while looking correct to
      // them. That is the bug this asserts against.
      const profile = await get(bob, `/people/${alice.userId}`).expect(200);
      expect(profile.body.data.person.avatarKey).toBe('avatar_07');
      expect(profile.body.data.person.photoUrl).toBeNull();

      // And on the search rows, which is where a stranger is first seen.
      const found = await get(bob, '/people/search?q=alice_av').expect(200);
      expect(found.body.data[0].avatarKey).toBe('avatar_07');
    });

    it('leaves it null for an account that picked nothing', async () => {
      const alice = await someone('alice_none');
      const bob = await someone('bob_none');

      const profile = await get(bob, `/people/${alice.userId}`).expect(200);
      // Null rather than a default. A stock face here would make every account
      // that has chosen nothing look like the same person.
      expect(profile.body.data.person.avatarKey).toBeNull();
    });
  });

  describe('handles', () => {
    it('claims a handle and makes the account findable', async () => {
      await someone('rohanm');
      const viewer = await someone('viewer1');

      const res = await get(viewer, '/people/search?q=rohan').expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].username).toBe('rohanm');
    });

    it('refuses a handle someone already holds', async () => {
      await someone('taken_one');
      const other = await anonymousAccount();

      const res = await request(app.getHttpServer())
        .post(`${V1}/me/username`)
        .set(auth(other.token))
        .send({ username: 'TAKEN_ONE' }) // case must not create a second holder
        .expect(409);

      expect(res.body.error.code).toBe('USERNAME_TAKEN');
    });

    it('refuses a handle that is not a handle', async () => {
      const user = await anonymousAccount();
      const res = await request(app.getHttpServer())
        .post(`${V1}/me/username`)
        .set(auth(user.token))
        .send({ username: 'no spaces!' })
        .expect(400);
      expect(res.body.error.code).toBe('USERNAME_INVALID');
    });

    it('reports the handle on /me, so the app knows to offer the claim screen', async () => {
      const noHandle = await anonymousAccount();

      const before = await get(noHandle, '/me').expect(200);
      // Null, not absent: the app branches on it to decide whether any of the
      // WishMates screens can be reached at all.
      expect(before.body.data.profile).toHaveProperty('username', null);

      await post(noHandle, '/me/username').send({ username: 'me_check' }).expect(201);

      const after = await get(noHandle, '/me').expect(200);
      expect(after.body.data.profile.username).toBe('me_check');
    });

    it('leaves an account with no handle undiscoverable', async () => {
      await anonymousAccount(); // never claims one
      const viewer = await someone('viewer2');

      // Searching the display name of a handle-less account finds nothing:
      // being findable is opt-in.
      const res = await get(viewer, '/people/search?q=test').expect(200);
      expect(res.body.data.every((p: { username: string }) => p.username !== null)).toBe(true);
    });
  });

  describe('requesting', () => {
    it('lands in the sender’s Sent tab and the receiver’s Received tab', async () => {
      const a = await someone('alice_a');
      const b = await someone('bob_b');

      await post(a, `/people/${b.userId}/request`).expect(201);

      const sent = await get(a, '/wishlinks/sent').expect(200);
      const received = await get(b, '/wishlinks/received').expect(200);

      expect(sent.body.data).toHaveLength(1);
      expect(sent.body.data[0].person.username).toBe('bob_b');
      expect(received.body.data).toHaveLength(1);
      expect(received.body.data[0].person.username).toBe('alice_a');
      // The other side of each is empty — direction is what splits the tabs.
      expect((await get(a, '/wishlinks/received').expect(200)).body.data).toHaveLength(0);
      expect((await get(b, '/wishlinks/sent').expect(200)).body.data).toHaveLength(0);
    });

    it('treats asking back as consent rather than opening a second request', async () => {
      const a = await someone('alice_c');
      const b = await someone('bob_c');

      await post(a, `/people/${b.userId}/request`).expect(201);
      // B asks A, who already asked B. B has plainly agreed.
      const res = await post(b, `/people/${a.userId}/request`).expect(201);

      expect(res.body.data.relationship).toBe('wishmates');
      expect((await get(a, '/wishmates').expect(200)).body.data).toHaveLength(1);
      expect((await get(b, '/wishmates').expect(200)).body.data).toHaveLength(1);
      // And no request is left waiting on either side.
      expect((await get(a, '/wishlinks/sent').expect(200)).body.data).toHaveLength(0);
      expect((await get(b, '/wishlinks/received').expect(200)).body.data).toHaveLength(0);
    });

    it('refuses to add yourself', async () => {
      const a = await someone('alice_d');
      const res = await post(a, `/people/${a.userId}/request`).expect(400);
      expect(res.body.error.code).toBe('WISHMATE_SELF');
    });

    it('re-requesting does not stack up rows', async () => {
      const a = await someone('alice_e');
      const b = await someone('bob_e');

      await post(a, `/people/${b.userId}/request`).expect(201);
      await post(a, `/people/${b.userId}/request`).expect(201);

      expect((await get(b, '/wishlinks/received').expect(200)).body.data).toHaveLength(1);
    });
  });

  describe('responding', () => {
    it('accept connects both sides and clears the request', async () => {
      const a = await someone('alice_f');
      const b = await someone('bob_f');
      await post(a, `/people/${b.userId}/request`).expect(201);
      const linkId = (await get(b, '/wishlinks/received')).body.data[0].linkId;

      await post(b, `/wishlinks/${linkId}/accept`).expect(201);

      expect((await get(a, '/wishmates')).body.data).toHaveLength(1);
      expect((await get(b, '/wishmates')).body.data).toHaveLength(1);
      expect((await get(b, '/wishlinks/received')).body.data).toHaveLength(0);
    });

    it('decline is invisible to the person who asked', async () => {
      const a = await someone('alice_g');
      const b = await someone('bob_g');
      await post(a, `/people/${b.userId}/request`).expect(201);
      const linkId = (await get(b, '/wishlinks/received')).body.data[0].linkId;

      await post(b, `/wishlinks/${linkId}/decline`).expect(201);

      // A sees no rejection anywhere — not in Sent, not on the profile.
      expect((await get(a, '/wishlinks/sent')).body.data).toHaveLength(0);
      const profile = await get(a, `/people/${b.userId}`).expect(200);
      expect(profile.body.data.relationship).toBe('none');
    });

    it('only the addressee can accept', async () => {
      const a = await someone('alice_h');
      const b = await someone('bob_h');
      await post(a, `/people/${b.userId}/request`).expect(201);
      const linkId = (await get(b, '/wishlinks/received')).body.data[0].linkId;

      // The requester cannot accept their own request into existence.
      await post(a, `/wishlinks/${linkId}/accept`).expect(404);
    });

    it('withdrawing a sent request removes it from the receiver too', async () => {
      const a = await someone('alice_i');
      const b = await someone('bob_i');
      await post(a, `/people/${b.userId}/request`).expect(201);
      const linkId = (await get(a, '/wishlinks/sent')).body.data[0].linkId;

      await del(a, `/wishlinks/${linkId}`).expect(204);

      expect((await get(b, '/wishlinks/received')).body.data).toHaveLength(0);
    });
  });

  describe('removing', () => {
    it('removes from both sides, from either side', async () => {
      const a = await someone('alice_j');
      const b = await someone('bob_j');
      await post(a, `/people/${b.userId}/request`).expect(201);
      await post(b, `/people/${a.userId}/request`).expect(201); // consent shortcut

      await del(b, `/wishmates/${a.userId}`).expect(204);

      expect((await get(a, '/wishmates')).body.data).toHaveLength(0);
      expect((await get(b, '/wishmates')).body.data).toHaveLength(0);
    });

    it('refuses to remove someone who is not a WishMate', async () => {
      const a = await someone('alice_k');
      const b = await someone('bob_k');
      const res = await del(a, `/wishmates/${b.userId}`).expect(404);
      expect(res.body.error.code).toBe('NOT_WISHMATES');
    });
  });

  describe('mutuals and suggestions', () => {
    /**
     * a—m and b—m, so a and b share exactly one mutual.
     *
     * Handles are unique per call: `ctx.reset()` clears Redis but not Mongo,
     * so a fixed handle would be taken the second time this ran.
     */
    const triangle = async () => {
      const tag = `t${++seq}`;
      const a = await someone(`${tag}_a`);
      const b = await someone(`${tag}_b`);
      const m = await someone(`${tag}_m`);
      for (const [x, y] of [
        [a, m],
        [b, m],
      ]) {
        await post(x, `/people/${y.userId}/request`).expect(201);
        await post(y, `/people/${x.userId}/request`).expect(201);
      }
      return { a, b, m, mutualUsername: `${tag}_m` };
    };

    it('counts the WishMates two people share', async () => {
      const { a, b, mutualUsername } = await triangle();

      const profile = await get(a, `/people/${b.userId}`).expect(200);

      expect(profile.body.data.person.mutualCount).toBe(1);
      expect(profile.body.data.mutuals).toHaveLength(1);
      expect(profile.body.data.mutuals[0].username).toBe(mutualUsername);
    });

    it('suggests a friend-of-a-friend, and never someone already linked', async () => {
      const { a, b, m } = await triangle();

      const res = await get(a, '/people/suggestions').expect(200);
      const ids = res.body.data.map((p: { userId: string }) => p.userId);

      expect(ids).toContain(b.userId); // shares m with a
      expect(ids).not.toContain(m.userId); // already a WishMate
      expect(ids).not.toContain(a.userId); // never yourself
    });

    it('drops someone from suggestions once a request exists', async () => {
      const { a, b } = await triangle();
      await post(a, `/people/${b.userId}/request`).expect(201);

      const res = await get(a, '/people/suggestions').expect(200);
      const ids = res.body.data.map((p: { userId: string }) => p.userId);

      // Suggesting someone you are already waiting on is worse than nothing.
      expect(ids).not.toContain(b.userId);
    });
  });

  describe('the profile screen', () => {
    it('reports the relationship each screen state depends on', async () => {
      const a = await someone('rel_a');
      const b = await someone('rel_b');

      expect((await get(a, `/people/${b.userId}`)).body.data.relationship).toBe('none');

      await post(a, `/people/${b.userId}/request`).expect(201);
      expect((await get(a, `/people/${b.userId}`)).body.data.relationship).toBe('request_sent');
      expect((await get(b, `/people/${a.userId}`)).body.data.relationship).toBe('request_received');

      await post(b, `/people/${a.userId}/request`).expect(201);
      expect((await get(a, `/people/${b.userId}`)).body.data.relationship).toBe('wishmates');

      expect((await get(a, `/people/${a.userId}`)).body.data.relationship).toBe('self');
    });

    it('never leaks contact details a stranger has no business seeing', async () => {
      const a = await someone('priv_a');
      const b = await someone('priv_b');

      const res = await get(a, `/people/${b.userId}`).expect(200);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain('@example');
      expect(res.body.data.person).not.toHaveProperty('email');
      expect(res.body.data.person).not.toHaveProperty('phone');
      expect(res.body.data).not.toHaveProperty('deliveryAddress');
    });
  });

  /**
   * "Recent Activity" (`4177:267`).
   *
   * The whole of this section is one rule: a viewer sees an event on someone
   * else's profile only when they were invited to it *themselves* and both of
   * them are going. Every test below is a way that rule could be broken into a
   * leak — a guest list read off a profile, an unanswered invite exposed, or
   * someone's calendar visible to a person who was never asked.
   */
  describe('recent activity', () => {
    /** Publishes an event and invites everyone in [guests] by user id. */
    const partyFor = async (
      host: Actor,
      guests: Actor[],
      over: Record<string, unknown> = {},
    ): Promise<{ eventId: string; tokenFor: (guest: Actor) => Promise<string> }> => {
      const created = await post(host, '/events')
        .send({
          title: 'Ananya’s Birthday',
          type: 'birthday',
          startsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000).toISOString(),
          timezone: 'Asia/Kolkata',
          venue: 'Infinite Rooftop',
          ...over,
        })
        .expect(201);
      const eventId = created.body.data.id as string;
      await post(host, `/events/${eventId}/publish`).expect(200);
      await post(host, `/events/${eventId}/invites`)
        .send({ recipients: guests.map((g) => ({ userId: g.userId })) })
        .expect(200);

      const invites = await get(host, `/events/${eventId}/invites`).expect(200);
      const tokenFor = async (guest: Actor): Promise<string> => {
        const invite = (invites.body.data as { id: string; invitedUserId: string }[]).find(
          (i) => i.invitedUserId === guest.userId,
        )!;
        const link = await get(host, `/events/${eventId}/invites/${invite.id}/link`).expect(200);
        return new URL(link.body.data.url as string).pathname.split('/').pop()!;
      };
      return { eventId, tokenFor };
    };

    const rsvp = async (token: string, response: string) =>
      request(app.getHttpServer())
        .post(`${V1}/public/invites/${token}/rsvp`)
        .send({ response })
        .expect(200);

    /** a and b are WishMates, and c hosts. */
    const cast = async (tag: string) => {
      const a = await someone(`${tag}_a`);
      const b = await someone(`${tag}_b`);
      const host = await someone(`${tag}_h`);
      await post(a, `/people/${b.userId}/request`).expect(201);
      await post(b, `/people/${a.userId}/request`).expect(201);
      return { a, b, host };
    };

    it('shows an event both of them are going to, with both answers', async () => {
      const { a, b, host } = await cast(`ra${++seq}`);
      const party = await partyFor(host, [a, b]);
      await rsvp(await party.tokenFor(a), 'yes');
      await rsvp(await party.tokenFor(b), 'maybe');

      const profile = await get(a, `/people/${b.userId}`).expect(200);

      expect(profile.body.data.recentActivity).toHaveLength(1);
      expect(profile.body.data.recentActivity[0]).toMatchObject({
        eventId: party.eventId,
        title: 'Ananya’s Birthday',
        venue: 'Infinite Rooftop',
        // Theirs, then the viewer's — the card says "Attending", so it has to
        // be able to tell the two apart.
        rsvp: 'maybe',
        viewerRsvp: 'yes',
      });
    });

    it('hides an event the viewer was never invited to', async () => {
      const { a, b, host } = await cast(`ra${++seq}`);
      const party = await partyFor(host, [b]);
      await rsvp(await party.tokenFor(b), 'yes');

      const profile = await get(a, `/people/${b.userId}`).expect(200);

      // Otherwise a profile becomes a way to read a host's guest list.
      expect(profile.body.data.recentActivity).toEqual([]);
    });

    it('hides an event the viewer was invited to but has not answered', async () => {
      const { a, b, host } = await cast(`ra${++seq}`);
      const party = await partyFor(host, [a, b]);
      await rsvp(await party.tokenFor(b), 'yes');
      // `a` leaves their invite pending.

      const profile = await get(a, `/people/${b.userId}`).expect(200);

      expect(profile.body.data.recentActivity).toEqual([]);
    });

    it('hides an event the other person declined', async () => {
      const { a, b, host } = await cast(`ra${++seq}`);
      const party = await partyFor(host, [a, b]);
      await rsvp(await party.tokenFor(a), 'yes');
      await rsvp(await party.tokenFor(b), 'no');

      const profile = await get(a, `/people/${b.userId}`).expect(200);

      // "Attending" has to mean attending.
      expect(profile.body.data.recentActivity).toEqual([]);
    });

    it('hides a party that has already happened', async () => {
      const { a, b, host } = await cast(`ra${++seq}`);
      const upcoming = await partyFor(host, [a, b]);
      await rsvp(await upcoming.tokenFor(a), 'yes');
      await rsvp(await upcoming.tokenFor(b), 'yes');

      // Published while still in the future, then moved into the past — the
      // publish endpoint refuses a date that has already gone.
      const past = await partyFor(host, [a, b], { title: 'Last Year' });
      await rsvp(await past.tokenFor(a), 'yes');
      await rsvp(await past.tokenFor(b), 'yes');
      await ctx.app
        .get<Model<EventDocument>>(getModelToken(Event.name))
        .updateOne(
          { _id: new Types.ObjectId(past.eventId) },
          { $set: { startsAt: new Date(Date.now() - 24 * 60 * 60 * 1_000) } },
        )
        .exec();

      const profile = await get(a, `/people/${b.userId}`).expect(200);

      const titles = profile.body.data.recentActivity.map((e: { title: string }) => e.title);
      expect(titles).toEqual(['Ananya’s Birthday']);
    });

    it('is empty on your own profile', async () => {
      const { a, host } = await cast(`ra${++seq}`);
      const party = await partyFor(host, [a]);
      await rsvp(await party.tokenFor(a), 'yes');

      const profile = await get(a, `/people/${a.userId}`).expect(200);

      expect(profile.body.data.recentActivity).toEqual([]);
    });
  });

  describe('presence', () => {
    it('reports offline with no socket, and never omits the fields', async () => {
      const a = await someone('pres_a');
      const b = await someone('pres_b');

      const profile = await get(a, `/people/${b.userId}`).expect(200);

      // The dot has to render something on first paint; an absent field would
      // make "offline" and "unknown" indistinguishable to the client.
      expect(profile.body.data.person.online).toBe(false);
      expect(profile.body.data.person).toHaveProperty('lastSeenAt');
    });

    it('marks someone online while they hold a connection, and offline after', async () => {
      const a = await someone('pres_c');
      const b = await someone('pres_d');
      const presence = app.get(PresenceService);

      await presence.connected(b.userId);
      expect((await get(a, `/people/${b.userId}`)).body.data.person.online).toBe(true);

      await presence.disconnected(b.userId);
      expect((await get(a, `/people/${b.userId}`)).body.data.person.online).toBe(false);
    });

    it('stays online until the LAST socket closes', async () => {
      const a = await someone('pres_e');
      const b = await someone('pres_f');
      const presence = app.get(PresenceService);

      // Phone and web at once.
      await presence.connected(b.userId);
      await presence.connected(b.userId);
      await presence.disconnected(b.userId);

      // Closing one tab must not black out the other device.
      expect((await get(a, `/people/${b.userId}`)).body.data.person.online).toBe(true);

      await presence.disconnected(b.userId);
      expect((await get(a, `/people/${b.userId}`)).body.data.person.online).toBe(false);
    });

    it('a stray disconnect cannot strand someone offline', async () => {
      const a = await someone('pres_g');
      const b = await someone('pres_h');
      const presence = app.get(PresenceService);

      // A restart mid-session loses the connect but still delivers the close.
      await presence.disconnected(b.userId);
      await presence.connected(b.userId);

      // Counting into negatives would leave them offline no matter what.
      expect((await get(a, `/people/${b.userId}`)).body.data.person.online).toBe(true);
    });

    it('carries presence into the WishMates list too', async () => {
      const a = await someone('pres_i');
      const b = await someone('pres_j');
      await post(a, `/people/${b.userId}/request`).expect(201);
      await post(b, `/people/${a.userId}/request`).expect(201);
      await app.get(PresenceService).connected(b.userId);

      const mates = await get(a, '/wishmates').expect(200);

      expect(mates.body.data[0].online).toBe(true);
    });
  });

  describe('direct messages', () => {
    it('opens one thread per pair, whichever side opens it', async () => {
      const a = await someone('dm_a');
      const b = await someone('dm_b');
      await post(a, `/people/${b.userId}/request`).expect(201);
      await post(b, `/people/${a.userId}/request`).expect(201);

      const first = await post(a, `/chats/direct/${b.userId}`).expect(201);
      const second = await post(b, `/chats/direct/${a.userId}`).expect(201);

      // Two threads would mean each side talking to itself.
      expect(second.body.data.chatId).toBe(first.body.data.chatId);
    });

    it('refuses to open a thread with someone who is not a WishMate', async () => {
      const a = await someone('dm_c');
      const b = await someone('dm_d');

      const res = await post(a, `/chats/direct/${b.userId}`).expect(403);

      expect(res.body.error.code).toBe('NOT_WISHMATES');
    });
  });
});
