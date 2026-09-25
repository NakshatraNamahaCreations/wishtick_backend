import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ErrorCode } from 'src/common/errors/error-codes';
import { JoinRequestsService } from 'src/modules/events/join-requests.service';
import {
  EventJoinRequest,
  type EventJoinRequestDocument,
} from 'src/modules/events/schemas/event-join-request.schema';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';
const IN_A_MONTH = (): string => new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface Actor {
  token: string;
  userId: string;
}

interface JoinStatus {
  status: 'none' | 'pending' | 'declined' | 'closed' | 'invited';
  token?: string;
}

interface JoinRequestRow {
  id: string;
  userId: string;
  person: { displayName: string | null } | null;
}

/**
 * Asking to be let into a private event through its share link.
 *
 * A private event used to turn away everybody not on its guest list. Links
 * travel, so the person holding one now asks, and the host decides.
 */
describe('Event join requests (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let eventModel: Model<EventDocument>;
  let requestModel: Model<EventJoinRequestDocument>;
  let joinRequests: JoinRequestsService;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  const newUser = async (name = 'Guest Person'): Promise<Actor> => {
    const res = await http()
      .post(`${V1}/auth/signup`)
      .send({ email: `jr${++seq}.${Date.now()}@example.com`, password: PASSWORD, name })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  /** A published event, and its share slug. */
  const newEvent = async (
    host: Actor,
    visibility: 'private' | 'invite_only' | 'public' = 'private',
  ): Promise<{ id: string; slug: string }> => {
    const created = (
      await http()
        .post(`${V1}/events`)
        .set(auth(host.token))
        .send({
          title: 'Rooftop Party',
          type: 'birthday',
          startsAt: IN_A_MONTH(),
          timezone: 'Asia/Kolkata',
          visibility,
        })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    await http().post(`${V1}/events/${created.data.id}/publish`).set(auth(host.token)).expect(200);
    const full = (
      await http().get(`${V1}/events/${created.data.id}`).set(auth(host.token)).expect(200)
    ).body as Envelope<{ share: { slug: string } }>;
    return { id: created.data.id, slug: full.data.share.slug };
  };

  const status = async (actor: Actor, slug: string): Promise<JoinStatus> =>
    (
      (
        await http()
          .get(`${V1}/events/by-slug/${slug}/join-request`)
          .set(auth(actor.token))
          .expect(200)
      ).body as Envelope<JoinStatus>
    ).data;

  const ask = (actor: Actor, slug: string) =>
    http().post(`${V1}/events/by-slug/${slug}/join-request`).set(auth(actor.token));

  const queue = async (host: Actor, eventId: string): Promise<JoinRequestRow[]> =>
    (
      (await http().get(`${V1}/events/${eventId}/join-requests`).set(auth(host.token)).expect(200))
        .body as Envelope<JoinRequestRow[]>
    ).data;

  const inbox = async (actor: Actor): Promise<{ type: string; refId: string }[]> => {
    await delay(150);
    await ctx.drainNotifications();
    return (
      (await http().get(`${V1}/notifications`).set(auth(actor.token)).expect(200)).body as Envelope<
        { type: string; refId: string }[]
      >
    ).data;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    eventModel = app.get<Model<EventDocument>>(getModelToken(Event.name));
    requestModel = app.get<Model<EventJoinRequestDocument>>(getModelToken(EventJoinRequest.name));
    joinRequests = app.get(JoinRequestsService);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  describe('asking', () => {
    it('a stranger holding a private link may ask, and the host is told', async () => {
      const host = await newUser('Host Person');
      const stranger = await newUser('Meera Rao');
      const event = await newEvent(host);

      // The link still refuses them outright...
      const refused = await http()
        .post(`${V1}/events/by-slug/${event.slug}/join`)
        .set(auth(stranger.token))
        .expect(403);
      expect((refused.body as Envelope<unknown>).error?.code).toBe(ErrorCode.EVENT_INVITE_REQUIRED);
      // ...but now there is something to do about it.
      expect(await status(stranger, event.slug)).toEqual({ status: 'none' });

      const asked = (await ask(stranger, event.slug).expect(200)).body as Envelope<JoinStatus>;
      expect(asked.data).toEqual({ status: 'pending' });
      expect(await status(stranger, event.slug)).toEqual({ status: 'pending' });

      const rows = await queue(host, event.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(stranger.userId);
      expect(rows[0].person?.displayName).toBe('Meera Rao');

      const notes = (await inbox(host)).filter((n) => n.type === 'event_join_requested');
      expect(notes).toHaveLength(1);
      // The event first, so the app can open that event's queue.
      expect(notes[0].refId).toBe(`${event.id}:${rows[0].id}`);
    });

    it('asking twice is one ask, and one notification', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await newEvent(host);

      await ask(stranger, event.slug).expect(200);
      await ask(stranger, event.slug).expect(200);

      expect(await queue(host, event.id)).toHaveLength(1);
      expect((await inbox(host)).filter((n) => n.type === 'event_join_requested')).toHaveLength(1);
    });

    it('someone the link already admits is let straight in instead', async () => {
      // Only private events ask. Anywhere else the link is the invitation.
      const host = await newUser();
      const guest = await newUser();
      const event = await newEvent(host, 'invite_only');

      const res = (await ask(guest, event.slug).expect(200)).body as Envelope<JoinStatus>;

      expect(res.data.status).toBe('invited');
      expect(res.data.token).toEqual(expect.any(String));
      expect(await queue(host, event.id)).toHaveLength(0);
    });

    it('the host cannot ask to join their own event', async () => {
      const host = await newUser();
      const event = await newEvent(host);

      const res = await ask(host, event.slug).expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.CANNOT_INVITE_HOST);
    });

    it('nobody may ask once the event has started', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await newEvent(host);
      await eventModel
        .updateOne({ _id: new Types.ObjectId(event.id) }, { startsAt: new Date(Date.now() - 1) })
        .exec();

      expect(await status(stranger, event.slug)).toEqual({ status: 'closed' });
      const res = await ask(stranger, event.slug).expect(409);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.EVENT_ALREADY_STARTED);
    });
  });

  /**
   * Found building this: a private event's link gave up on anyone with no
   * verified phone number before checking whether they were invited by name,
   * so a guest the host invited from their WishMates was refused by the link
   * to the party they were on the list for.
   */
  it('a guest invited by name can open the private link', async () => {
    const host = await newUser();
    const guest = await newUser();
    const event = await newEvent(host);
    await http()
      .post(`${V1}/events/${event.id}/invites`)
      .set(auth(host.token))
      .send({ recipients: [{ userId: guest.userId }] })
      .expect(200);

    const joined = (
      await http()
        .post(`${V1}/events/by-slug/${event.slug}/join`)
        .set(auth(guest.token))
        .expect(201)
    ).body as Envelope<{ token: string }>;
    expect(joined.data.token).toEqual(expect.any(String));
  });

  describe('answering', () => {
    it('accepting puts them on the guest list and tells them', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await newEvent(host);
      await ask(stranger, event.slug).expect(200);
      const [row] = await queue(host, event.id);

      const accepted = (
        await http()
          .post(`${V1}/events/${event.id}/join-requests/${row.id}/accept`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ invitedUserId: string }>;
      expect(accepted.data.invitedUserId).toBe(stranger.userId);

      // Gone from the queue — it is a guest now, not an ask.
      expect(await queue(host, event.id)).toHaveLength(0);

      // The link lets them in now.
      const joined = (
        await http()
          .post(`${V1}/events/by-slug/${event.slug}/join`)
          .set(auth(stranger.token))
          .expect(201)
      ).body as Envelope<{ token: string }>;
      expect((await status(stranger, event.slug)).status).toBe('invited');

      const notes = (await inbox(stranger)).filter((n) => n.type === 'event_join_accepted');
      expect(notes).toHaveLength(1);
      // Their invitation, which is what the notification opens.
      expect(notes[0].refId).toBe(joined.data.token);
    });

    it('declining takes it off the list, tells nobody, and they cannot ask again', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await newEvent(host);
      await ask(stranger, event.slug).expect(200);
      const [row] = await queue(host, event.id);

      await http()
        .post(`${V1}/events/${event.id}/join-requests/${row.id}/decline`)
        .set(auth(host.token))
        .expect(204);

      expect(await queue(host, event.id)).toHaveLength(0);
      expect(await status(stranger, event.slug)).toEqual({ status: 'declined' });
      expect((await inbox(stranger)).filter((n) => n.type.startsWith('event_join'))).toHaveLength(
        0,
      );

      const again = await ask(stranger, event.slug).expect(409);
      expect((again.body as Envelope<unknown>).error?.code).toBe(ErrorCode.JOIN_REQUEST_DECLINED);
      expect(await queue(host, event.id)).toHaveLength(0);
    });

    it('an ask can be answered only once', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await newEvent(host);
      await ask(stranger, event.slug).expect(200);
      const [row] = await queue(host, event.id);

      await http()
        .post(`${V1}/events/${event.id}/join-requests/${row.id}/decline`)
        .set(auth(host.token))
        .expect(204);
      const res = await http()
        .post(`${V1}/events/${event.id}/join-requests/${row.id}/accept`)
        .set(auth(host.token))
        .expect(404);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.JOIN_REQUEST_NOT_FOUND);
    });

    it('only the host sees and answers the queue', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const other = await newUser();
      const event = await newEvent(host);
      await ask(stranger, event.slug).expect(200);
      const [row] = await queue(host, event.id);

      await http().get(`${V1}/events/${event.id}/join-requests`).set(auth(other.token)).expect(404);
      await http()
        .post(`${V1}/events/${event.id}/join-requests/${row.id}/accept`)
        .set(auth(other.token))
        .expect(404);
      await http()
        .post(`${V1}/events/${event.id}/join-requests/${row.id}/accept`)
        .set(auth(stranger.token))
        .expect(404);
    });

    it("the host's event page counts what is waiting", async () => {
      const host = await newUser();
      const event = await newEvent(host);
      for (let i = 0; i < 2; i++) await ask(await newUser(), event.slug).expect(200);

      const view = (await http().get(`${V1}/events/${event.id}`).set(auth(host.token)).expect(200))
        .body as Envelope<{ pendingJoinRequests: number }>;
      expect(view.data.pendingJoinRequests).toBe(2);
    });
  });

  describe('once the event has started', () => {
    it('the queue is empty and nothing can be answered, before any sweep', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await newEvent(host);
      await ask(stranger, event.slug).expect(200);
      const [row] = await queue(host, event.id);
      await eventModel
        .updateOne({ _id: new Types.ObjectId(event.id) }, { startsAt: new Date(Date.now() - 1) })
        .exec();

      expect(await queue(host, event.id)).toHaveLength(0);
      const view = (await http().get(`${V1}/events/${event.id}`).set(auth(host.token)).expect(200))
        .body as Envelope<{ pendingJoinRequests: number }>;
      expect(view.data.pendingJoinRequests).toBe(0);
      await http()
        .post(`${V1}/events/${event.id}/join-requests/${row.id}/accept`)
        .set(auth(host.token))
        .expect(409);
    });

    it('the sweep deletes every request for it — declined ones too', async () => {
      const host = await newUser();
      const started = await newEvent(host);
      const upcoming = await newEvent(host);
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      await ask(a, started.slug).expect(200);
      await ask(b, started.slug).expect(200);
      const [toDecline] = await queue(host, started.id);
      await http()
        .post(`${V1}/events/${started.id}/join-requests/${toDecline.id}/decline`)
        .set(auth(host.token))
        .expect(204);
      await ask(c, upcoming.slug).expect(200);

      await eventModel
        .updateOne({ _id: new Types.ObjectId(started.id) }, { startsAt: new Date(Date.now() - 1) })
        .exec();
      // At least these two — the database is shared across the file, so
      // other tests' finished events may be swept in the same run.
      expect(await joinRequests.sweepStarted()).toBeGreaterThanOrEqual(2);

      expect(
        await requestModel.countDocuments({ eventId: new Types.ObjectId(started.id) }).exec(),
      ).toBe(0);
      // An event still to come keeps its queue.
      expect(await queue(host, upcoming.id)).toHaveLength(1);
    });

    it('the sweep also clears a cancelled event', async () => {
      const host = await newUser();
      const event = await newEvent(host);
      await ask(await newUser(), event.slug).expect(200);
      await eventModel
        .updateOne({ _id: new Types.ObjectId(event.id) }, { status: 'cancelled' })
        .exec();

      await joinRequests.sweepStarted();

      expect(
        await requestModel.countDocuments({ eventId: new Types.ObjectId(event.id) }).exec(),
      ).toBe(0);
    });
  });
});
