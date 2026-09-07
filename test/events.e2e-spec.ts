import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { ErrorCode } from 'src/common/errors/error-codes';
import { EVENT_REMINDER_JOB } from 'src/modules/events/event-reminders.service';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';
/** A 1x1 PNG â the smallest thing the media pipeline will accept as real bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const IN_A_MONTH = (): string => new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
/**
 * A syntactically valid user id with no account behind it.
 *
 * Used where a test only needs the invite row to exist — bulk dedupe, the
 * published-state guard — and signing up 50 real accounts would cost more than
 * the assertion is worth. Inviting an id that resolves to nobody is allowed on
 * purpose: the guest list renders the row without a name rather than rejecting
 * a batch of 50 because one WishMate deleted their account mid-request.
 */
const newObjectId = (): string => new Types.ObjectId().toString();

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface EventView {
  id: string;
  status: string;
  share?: { slug: string; url: string };
  rsvpCounts?: { attending: number; invited: number; yes: number; no: number };
}

interface Actor {
  token: string;
  userId: string;
  email: string;
}

describe('Events & invites (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let eventModel: Model<EventDocument>;
  let userModel: Model<UserDocument>;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (name = 'Aarav Sharma'): Promise<Actor> => {
    const email = `ev${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id, email };
  };

  const createEvent = async (
    host: Actor,
    over: Record<string, unknown> = {},
  ): Promise<EventView> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/events`)
      .set(auth(host.token))
      .send({
        title: 'Big Party',
        type: 'birthday',
        startsAt: IN_A_MONTH(),
        timezone: 'Asia/Kolkata',
        ...over,
      })
      .expect(201);
    return (res.body as Envelope<EventView>).data;
  };

  const publish = async (host: Actor, id: string): Promise<EventView> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/events/${id}/publish`)
      .set(auth(host.token))
      .expect(200);
    return (res.body as Envelope<EventView>).data;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    eventModel = app.get<Model<EventDocument>>(getModelToken(Event.name));
    userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Templates ─────────────────────────────────────────────────────────────

  describe('invite templates', () => {
    it('serves 3 designs with 6 variants each, without authentication', async () => {
      const res = await request(app.getHttpServer()).get(`${V1}/invite-templates`).expect(200);
      const { templates } = (res.body as Envelope<{ templates: { variants: unknown[] }[] }>).data;
      expect(templates).toHaveLength(3);
      for (const t of templates) expect(t.variants).toHaveLength(6);
    });

    it('filters templates by event type', async () => {
      const res = await request(app.getHttpServer())
        .get(`${V1}/invite-templates?eventType=anniversary`)
        .expect(200);
      const { templates } = (res.body as Envelope<{ templates: { id: string }[] }>).data;
      expect(templates.some((t) => t.id === 'romantic')).toBe(true);
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  describe('event lifecycle', () => {
    it('creates a draft, publishes it, and schedules three reminders', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      expect(event.status).toBe('draft');
      // A draft schedules nothing.
      expect(ctx.scheduler.jobsNamed(EVENT_REMINDER_JOB)).toHaveLength(0);

      const published = await publish(host, event.id);
      expect(published.status).toBe('published');

      const reminders = ctx.scheduler.jobsNamed(EVENT_REMINDER_JOB);
      expect(reminders).toHaveLength(3);
      // Colon-free ids — BullMQ rejects a colon, and the fake enforces it.
      for (const r of reminders) expect(r.opts.jobId).not.toContain(':');
    });

    it('refuses to publish an event in the past', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      // Backdate it directly — the DTO blocks a past date on create.
      await eventModel.updateOne(
        { _id: event.id },
        { $set: { startsAt: new Date(Date.now() - 1_000) } },
      );
      const res = await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/publish`)
        .set(auth(host.token))
        .expect(400);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.EVENT_DATE_IN_PAST);
    });

    it('answers 404 — not 403 — for a non-host', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await createEvent(host);
      await request(app.getHttpServer())
        .get(`${V1}/events/${event.id}`)
        .set(auth(stranger.token))
        .expect(404);
    });

    it('cancels an event and clears its reminders', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      expect(ctx.scheduler.jobsNamed(EVENT_REMINDER_JOB)).toHaveLength(3);

      const cancelled = (
        await request(app.getHttpServer())
          .delete(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView>;
      expect(cancelled.data.status).toBe('cancelled');
      // Reminding people about a cancelled party is worse than not reminding.
      expect(ctx.scheduler.jobsNamed(EVENT_REMINDER_JOB)).toHaveLength(0);
    });

    it('rejects attaching a wishlist you do not own', async () => {
      const host = await newUser();
      const other = await newUser();
      const theirList = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(other.token))
          .send({ title: 'Not yours' })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      const res = await request(app.getHttpServer())
        .post(`${V1}/events`)
        .set(auth(host.token))
        .send({
          title: 'X',
          type: 'birthday',
          startsAt: IN_A_MONTH(),
          timezone: 'Asia/Kolkata',
          wishlistIds: [theirList.data.id],
        })
        .expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.WISHLIST_NOT_LINKABLE);
    });
  });

  // ── Exit criterion: reminders reschedule on a date change ─────────────────

  describe('reminder rescheduling', () => {
    it('reschedules every reminder when the date moves, orphaning none', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);

      const before = ctx.scheduler.jobsNamed(EVENT_REMINDER_JOB);
      const beforeDelays = before.map((j) => j.opts.delay);

      // Move the event two weeks closer.
      const newDate = new Date(Date.now() + 16 * 24 * 60 * 60 * 1_000).toISOString();
      await request(app.getHttpServer())
        .patch(`${V1}/events/${event.id}`)
        .set(auth(host.token))
        .send({ startsAt: newDate })
        .expect(200);

      const after = ctx.scheduler.jobsNamed(EVENT_REMINDER_JOB);
      // Still exactly three — no orphans left pointing at the old date.
      expect(after).toHaveLength(3);
      expect(ctx.scheduler.removed.length).toBeGreaterThanOrEqual(3);

      // And the delays actually changed — the bug this guards is silently
      // keeping the old schedule.
      const afterDelays = after.map((j) => j.opts.delay);
      expect(afterDelays).not.toEqual(beforeDelays);

      // The queued jobs carry the NEW start time, so a stale one would no-op.
      for (const job of after) {
        expect((job.data as { startsAtIso: string }).startsAtIso).toBe(
          new Date(newDate).toISOString(),
        );
      }
    });
  });

  // ── Exit criterion: bulk dedupe + guest RSVP ──────────────────────────────

  describe('bulk invites', () => {
    it('invites 50 recipients, collapsing duplicates, and reconciles the RSVP count', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);

      // 50 unique WishMates, plus 5 duplicates (the same person tapped twice)
      // and the host themselves, who cannot be a guest at their own party.
      const unique = Array.from({ length: 50 }, () => ({ userId: newObjectId() }));
      const recipients = [...unique, ...unique.slice(0, 5), { userId: host.userId }];

      const res = await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients })
        .expect(200);

      const result = (
        res.body as Envelope<{ created: unknown[]; duplicates: number; skipped: number }>
      ).data;
      expect(result.created).toHaveLength(50);
      expect(result.duplicates).toBe(5);
      expect(result.skipped).toBe(1);

      // The guest list holds exactly 50, not 55 — the database dedupe held.
      const invites = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(invites.data).toHaveLength(50);

      // Nothing was emailed or texted: an invitation reaches a WishMate in the
      // app, and this is the assertion that would catch a delivery channel
      // creeping back in.
      expect(ctx.mailer.sent.filter((m) => m.subject.includes('Big Party'))).toHaveLength(0);
      expect(ctx.sms.sent).toHaveLength(0);

      // A second identical request adds nobody.
      const again = await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: unique })
        .expect(200);
      expect(
        (again.body as Envelope<{ created: unknown[]; duplicates: number }>).data.created,
      ).toHaveLength(0);
      expect((again.body as Envelope<{ duplicates: number }>).data.duplicates).toBe(50);
    }, 30_000);

    it('lets a guest RSVP without an account, and the count reflects plus-ones', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);

      const priya = await newUser('Priya Nair');
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: priya.userId }] })
        .expect(200);

      // The invitee opens their link — no auth header.
      const inviteToken = await InviteTokenHelper.only(app, host.token, event.id);

      const view = await request(app.getHttpServer())
        .get(`${V1}/public/invites/${inviteToken}`)
        .expect(200);
      // The greeting comes from their own account now, not from something the
      // host typed when addressing the invite.
      expect((view.body as Envelope<{ invitee: { name: string } }>).data.invitee.name).toBe(
        'Priya Nair',
      );

      await request(app.getHttpServer())
        .post(`${V1}/public/invites/${inviteToken}/rsvp`)
        .send({ response: 'yes', plusOnes: 2, message: 'Bringing the kids' })
        .expect(200);

      const counts = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView>;
      // 1 yes + 2 plus-ones = 3 attending.
      expect(counts.data.rsvpCounts).toMatchObject({ yes: 1, attending: 3, invited: 1 });
    });

    it('revokes an invite so its token stops working', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      const guest = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);
      const inviteToken = await InviteTokenHelper.only(app, host.token, event.id);

      const invites = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;

      await request(app.getHttpServer())
        .delete(`${V1}/events/${event.id}/invites/${invites.data[0].id}`)
        .set(auth(host.token))
        .expect(204);

      await request(app.getHttpServer()).get(`${V1}/public/invites/${inviteToken}`).expect(404);
    });

    it('refuses to invite before the event is published', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      const res = await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: newObjectId() }] })
        .expect(409);
      expect((res.body as Envelope<never>).error?.code).toBe(ErrorCode.EVENT_NOT_PUBLISHED);
    });
  });

  // ── Exit criterion: event-only wishlist opens exactly to accepted invitees ─

  describe('venue, person and relation (257:733, 257:755)', () => {
    it('round-trips the fields the create flow marks required', async () => {
      const host = await newUser();
      const created = (
        await request(app.getHttpServer())
          .post(`${V1}/events`)
          .set(auth(host.token))
          .send({
            title: "Rahul & Priya's Anniversary",
            type: 'anniversary',
            startsAt: new Date(Date.now() + 86_400_000).toISOString(),
            timezone: 'Asia/Kolkata',
            venue: 'Mysore Socials',
            personName: 'Priya',
            relation: 'partner_wife',
          })
          .expect(201)
      ).body as Envelope<{ id: string; venue: string; personName: string; relation: string }>;

      expect(created.data.venue).toBe('Mysore Socials');
      expect(created.data.personName).toBe('Priya');
      expect(created.data.relation).toBe('partner_wife');

      const moved = (
        await request(app.getHttpServer())
          .patch(`${V1}/events/${created.data.id}`)
          .set(auth(host.token))
          .send({ venue: 'The Grand Ballroom' })
          .expect(200)
      ).body as Envelope<{ venue: string; personName: string }>;

      expect(moved.data.venue).toBe('The Grand Ballroom');
      // Untouched fields survive a partial update.
      expect(moved.data.personName).toBe('Priya');
    });

    it('a host celebrating themself sends no person and no relation', async () => {
      const host = await newUser();
      const created = (
        await request(app.getHttpServer())
          .post(`${V1}/events`)
          .set(auth(host.token))
          .send({
            title: "Siya's 24th",
            type: 'birthday',
            startsAt: new Date(Date.now() + 86_400_000).toISOString(),
            timezone: 'Asia/Kolkata',
            forSelf: true,
          })
          .expect(201)
      ).body as Envelope<{ id: string; forSelf: boolean; personName: string | null; relation: string | null }>;

      // The flag is what tells a self-event from an unfinished draft: both
      // have no person and no relation.
      expect(created.data.forSelf).toBe(true);
      expect(created.data.personName).toBeNull();
      expect(created.data.relation).toBeNull();

      // And it defaults off, so every existing event reads as "for someone".
      const other = (
        await request(app.getHttpServer())
          .post(`${V1}/events`)
          .set(auth(host.token))
          .send({
            title: "Priya's Anniversary",
            type: 'anniversary',
            startsAt: new Date(Date.now() + 86_400_000).toISOString(),
            timezone: 'Asia/Kolkata',
            personName: 'Priya',
            relation: 'partner_wife',
          })
          .expect(201)
      ).body as Envelope<{ forSelf: boolean }>;
      expect(other.data.forSelf).toBe(false);
    });

    it('shows the venue to the invitee — the gap that made an invite all time and no place', async () => {
      const host = await newUser();
      const event = (
        await request(app.getHttpServer())
          .post(`${V1}/events`)
          .set(auth(host.token))
          .send({
            title: 'Housewarming',
            type: 'generic',
            startsAt: new Date(Date.now() + 86_400_000).toISOString(),
            timezone: 'Asia/Kolkata',
            venue: 'Mysore Socials',
          })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await publish(host, event.data.id);

      const invited = (
        await request(app.getHttpServer())
          .post(`${V1}/events/${event.data.id}/invites`)
          .set(auth(host.token))
          .send({ recipients: [{ userId: newObjectId() }] })
          .expect(200)
      ).body as Envelope<{ created: { id: string }[] }>;

      const link = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.data.id}/invites/${invited.data.created[0].id}/link`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ url: string }>;
      const token = link.data.url.split('/').pop()!;

      const publicView = (
        await request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).expect(200)
      ).body as Envelope<{ event: { venue: string | null } }>;

      expect(publicView.data.event.venue).toBe('Mysore Socials');
    });
  });

  describe('guest details (4096:162)', () => {
    it('every guest carries the date they were added', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      const rohan = await newUser('Rohan');
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: rohan.userId }] })
        .expect(200);

      const list = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ person: { displayName: string | null } | null; createdAt: string }[]>;

      // "Added on" has no other source: an invite with no createdAt renders a
      // dash where the design shows a timestamp.
      expect(list.data[0].createdAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(list.data[0].createdAt))).toBe(false);

      // And the row knows whose it is. The invite itself carries only a user
      // id now, so without the identity lookup every guest row is a blank
      // name — a guest list that lists nobody.
      expect(list.data[0].person?.displayName).toBe('Rohan');
    });
  });

  describe('uploaded invitation (2248:70)', () => {
    /** Presign â PUT the real bytes â confirm, for one purpose. */
    const uploadMedia = async (actor: Actor, purpose: string): Promise<string> => {
      const ticket = (
        await request(app.getHttpServer())
          .post(`${V1}/media/upload-url`)
          .set(auth(actor.token))
          .send({ purpose, contentType: 'image/png' })
          .expect(201)
      ).body as Envelope<{ mediaId: string; uploadUrl: string }>;

      const url = new URL(ticket.data.uploadUrl);
      await request(app.getHttpServer())
        .put(url.pathname + url.search)
        .set('Content-Type', 'image/png')
        .send(PNG_BYTES)
        .expect(200);

      await request(app.getHttpServer())
        .post(`${V1}/media/confirm`)
        .set(auth(actor.token))
        .send({ mediaId: ticket.data.mediaId })
        .expect(201);

      return ticket.data.mediaId;
    };

    it("carries the host's own artwork all the way to the invitee", async () => {
      const host = await newUser();
      const event = await createEvent(host);
      const mediaId = await uploadMedia(host, 'event_invite');

      const patched = (
        await request(app.getHttpServer())
          .patch(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .send({ inviteMediaId: mediaId })
          .expect(200)
      ).body as Envelope<{ inviteMediaUrl: string | null }>;

      expect(patched.data.inviteMediaUrl).toEqual(expect.any(String));

      await publish(host, event.id);
      const invited = (
        await request(app.getHttpServer())
          .post(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .send({ recipients: [{ userId: newObjectId() }] })
          .expect(200)
      ).body as Envelope<{ created: { id: string }[] }>;

      const link = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites/${invited.data.created[0].id}/link`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ url: string }>;
      const token = link.data.url.split('/').pop()!;

      const publicView = (
        await request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).expect(200)
      ).body as Envelope<{ event: { inviteMediaUrl: string | null } }>;

      expect(publicView.data.event.inviteMediaUrl).toBe(patched.data.inviteMediaUrl);
    });

    it('attaches artwork uploaded before the event existed', async () => {
      // The app uploads the card first and creates the event only once the
      // host has seen the preview, so create has to take the id — a PATCH
      // afterwards would mean a moment where the event exists with no card.
      const host = await newUser();
      const mediaId = await uploadMedia(host, 'event_invite');

      const event = (await createEvent(host, { inviteMediaId: mediaId })) as EventView & {
        inviteMediaUrl: string | null;
      };
      expect(event.inviteMediaUrl).toEqual(expect.any(String));

      const fetched = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ inviteMediaUrl: string | null }>;
      expect(fetched.data.inviteMediaUrl).toBe(event.inviteMediaUrl);
    });

    it("reaches the guest's own list of invitations, with who is hosting", async () => {
      // The list used to carry only the cover, which an event made in the app
      // never has — so every card on the guest's Invites tab was blank. And
      // the host's name was hard-coded to null.
      const host = await newUser('Aarav Sharma');
      const guest = await newUser('Priya Nair');
      const mediaId = await uploadMedia(host, 'event_invite');
      const event = (await createEvent(host, { inviteMediaId: mediaId })) as EventView & {
        inviteMediaUrl: string | null;
      };
      await publish(host, event.id);
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);

      const list = (
        await request(app.getHttpServer())
          .get(`${V1}/events/invited`)
          .set(auth(guest.token))
          .expect(200)
      ).body as Envelope<{ id: string; inviteMediaUrl: string | null; hostName: string | null }[]>;

      expect(list.data).toHaveLength(1);
      expect(list.data[0].inviteMediaUrl).toBe(event.inviteMediaUrl);
      expect(list.data[0].inviteMediaUrl).toEqual(expect.any(String));
      expect(list.data[0].hostName).toBe('Aarav Sharma');
    });

    it('refuses a cover image passed off as an invitation', async () => {
      // event_invite is the only purpose that admits GIF, MP4 and PDF, so
      // accepting any ready media here would smuggle those types in.
      const host = await newUser();
      const event = await createEvent(host);
      const coverId = await uploadMedia(host, 'event_cover');

      const res = await request(app.getHttpServer())
        .patch(`${V1}/events/${event.id}`)
        .set(auth(host.token))
        .send({ inviteMediaId: coverId })
        .expect(400);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.MEDIA_TYPE_NOT_ALLOWED);
    });

    it('refuses the same at create, and creates nothing on the way', async () => {
      const host = await newUser();
      const coverId = await uploadMedia(host, 'event_cover');

      const res = await request(app.getHttpServer())
        .post(`${V1}/events`)
        .set(auth(host.token))
        .send({
          title: 'Big Party',
          type: 'birthday',
          startsAt: IN_A_MONTH(),
          timezone: 'Asia/Kolkata',
          inviteMediaId: coverId,
        })
        .expect(400);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.MEDIA_TYPE_NOT_ALLOWED);
      // The media is checked before the insert, not after: a refused card
      // must not leave an event behind for the host to find on their list.
      expect(
        await eventModel.countDocuments({ hostId: new Types.ObjectId(host.userId) }).exec(),
      ).toBe(0);
    });

    it("refuses somebody else's upload", async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await createEvent(host);
      const theirs = await uploadMedia(stranger, 'event_invite');

      await request(app.getHttpServer())
        .patch(`${V1}/events/${event.id}`)
        .set(auth(host.token))
        .send({ inviteMediaId: theirs })
        .expect(404);
    });
  });

  describe('guest list export (4096:206)', () => {
    const seedGuests = async (): Promise<{ host: Actor; eventId: string }> => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      const [rohan, sona] = [await newUser('Rohan'), await newUser('Sona')];
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: rohan.userId }, { userId: sona.userId }] })
        .expect(200);
      return { host, eventId: event.id };
    };

    it('produces a CSV with a header and one row per guest', async () => {
      const { host, eventId } = await seedGuests();

      const res = await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites/export?format=csv`)
        .set(auth(host.token))
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment;');
      expect(res.headers['content-disposition']).toContain('guest-list.csv');

      const text = res.text ?? res.body.toString();
      const lines = text.trim().split(String.fromCharCode(13, 10));
      expect(lines[0]).toContain('"Name"');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('"Rohan"');
      // Nobody has replied yet, so nobody is counted as attending.
      expect(lines[1]).toContain('"No reply"');
    });

    it('quotes a formula so a spreadsheet cannot execute a guest’s name', async () => {
      const host = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      // The name is the guest's own, so the injection now arrives through
      // somebody's account rather than through what the host typed — which is
      // if anything the more likely way for one to reach the export.
      const attacker = await newUser('=cmd|calc!A1');
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: attacker.userId }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`${V1}/events/${event.id}/invites/export?format=csv`)
        .set(auth(host.token))
        .expect(200);

      const text = res.text ?? res.body.toString();
      // Prefixed with an apostrophe: Excel then treats it as text, not a
      // formula to run.
      expect(text).toContain(`"'=cmd|calc!A1"`);
      expect(text).not.toContain('"=cmd|calc!A1"');
    });

    it('produces a real xlsx and a real pdf', async () => {
      const { host, eventId } = await seedGuests();

      const xlsx = await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites/export?format=xlsx`)
        .set(auth(host.token))
        .buffer()
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      // A zip container — every xlsx is one, and "PK" is its magic number.
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

      const pdf = await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites/export?format=pdf`)
        .set(auth(host.token))
        .buffer()
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.headers['content-type']).toContain('application/pdf');
    });

    it('defaults to PDF, as the sheet pre-selects', async () => {
      const { host, eventId } = await seedGuests();

      const res = await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites/export`)
        .set(auth(host.token))
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
    });

    it('is host-only — a guest list is not public information', async () => {
      const { eventId } = await seedGuests();
      const stranger = await newUser();

      await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites/export?format=csv`)
        .set(auth(stranger.token))
        .expect(404);
    });

    it('rejects a format it does not produce', async () => {
      const { host, eventId } = await seedGuests();

      await request(app.getHttpServer())
        .get(`${V1}/events/${eventId}/invites/export?format=docx`)
        .set(auth(host.token))
        .expect(400);
    });
  });

  describe('event_only wishlist access', () => {
    it('opens an event-only wishlist to an invitee only after they RSVP yes', async () => {
      const host = await newUser();
      const guest = await newUser();

      // An event_only wishlist with one item.
      const wishlist = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(host.token))
          .send({ title: 'Gift ideas', visibility: WishlistVisibility.EVENT_ONLY })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wishlist.data.id}/items`)
        .set(auth(host.token))
        .send({ title: 'A telescope' })
        .expect(201);

      // Attaching the wishlist to the event sets the wishlist's eventId, which
      // is what AccessPolicyService reads to resolve EVENT_ONLY. No manual
      // surgery — the link is maintained by the service.
      const event = await createEvent(host, { wishlistIds: [wishlist.data.id] });
      await publish(host, event.id);

      // Before any invite: the guest cannot see the list.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.data.id}`)
        .set(auth(guest.token))
        .expect(404);

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);

      // Invited but not replied → still no access. An unanswered invite is not
      // attendance.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.data.id}`)
        .set(auth(guest.token))
        .expect(404);

      const inviteToken = await InviteTokenHelper.only(app, host.token, event.id);
      await request(app.getHttpServer())
        .post(`${V1}/public/invites/${inviteToken}/rsvp`)
        .set(auth(guest.token))
        .send({ response: 'yes' })
        .expect(200);

      // Now the event-only list opens for them.
      const view = await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.data.id}`)
        .set(auth(guest.token))
        .expect(200);
      expect((view.body as Envelope<{ access: { canGift: boolean } }>).data.access.canGift).toBe(
        true,
      );

      // Declining takes it away again.
      await request(app.getHttpServer())
        .post(`${V1}/public/invites/${inviteToken}/rsvp`)
        .set(auth(guest.token))
        .send({ response: 'no' })
        .expect(200);
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.data.id}`)
        .set(auth(guest.token))
        .expect(404);
    }, 30_000);
  });

  // ── Invite linking on signup ──────────────────────────────────────────────

  /**
   * Joining a public event from its share link (`/e/<slug>`).
   *
   * The link names nobody, so identity is the session — which is what lets one
   * URL sit in a group chat. Everything after the join is the existing invite
   * machinery, so these tests care mostly about who is turned away.
   */
  describe('deleting events (multi-select)', () => {
    const bulkDelete = (actor: Actor, ids: string[]) =>
      request(app.getHttpServer())
        .post(`${V1}/events/bulk-delete`)
        .set(auth(actor.token))
        .send({ ids });

    it('removes the events and everything hanging off them', async () => {
      const host = await newUser();
      const guest = await newUser();
      const keep = await createEvent(host);
      const drop = await createEvent(host);
      await publish(host, drop.id);
      await request(app.getHttpServer())
        .post(`${V1}/events/${drop.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);

      const res = await bulkDelete(host, [drop.id]).expect(200);
      expect((res.body as Envelope<{ deleted: number }>).data.deleted).toBe(1);

      // Gone, not cancelled — the host asked for it to be removed.
      await request(app.getHttpServer())
        .get(`${V1}/events/${drop.id}`)
        .set(auth(host.token))
        .expect(404);

      // The invite went with it. A row pointing at an event that no longer
      // exists would sit in the guest's list forever with nothing to open.
      const invited = await request(app.getHttpServer())
        .get(`${V1}/events/invited`)
        .set(auth(guest.token))
        .expect(200);
      expect((invited.body as Envelope<{ id: string }[]>).data).toHaveLength(0);

      // And the one that was not selected is untouched.
      await request(app.getHttpServer())
        .get(`${V1}/events/${keep.id}`)
        .set(auth(host.token))
        .expect(200);
    });

    it('deletes several at once', async () => {
      const host = await newUser();
      const ids = [
        (await createEvent(host)).id,
        (await createEvent(host)).id,
        (await createEvent(host)).id,
      ];

      const res = await bulkDelete(host, ids).expect(200);
      expect((res.body as Envelope<{ deleted: number }>).data.deleted).toBe(3);

      const mine = await request(app.getHttpServer())
        .get(`${V1}/events/mine`)
        .set(auth(host.token))
        .expect(200);
      expect((mine.body as Envelope<unknown[]>).data).toHaveLength(0);
    });

    it('skips what the caller does not host rather than failing the batch', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const mine = await createEvent(host);
      const theirs = await createEvent(stranger);

      const res = await bulkDelete(host, [mine.id, theirs.id]).expect(200);

      // One deleted, one silently skipped. Refusing the whole request over a
      // row that went stale would leave the host unable to clear anything.
      expect((res.body as Envelope<{ deleted: number }>).data.deleted).toBe(1);
      await request(app.getHttpServer())
        .get(`${V1}/events/${theirs.id}`)
        .set(auth(stranger.token))
        .expect(200);
    });

    it('frees a wishlist the event was holding rather than orphaning it', async () => {
      const host = await newUser();
      const wishlist = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(host.token))
          .send({ title: 'Gift ideas', visibility: WishlistVisibility.EVENT_ONLY })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const event = await createEvent(host, {
        wishlistIds: [wishlist.data.id],
      });

      await bulkDelete(host, [event.id]).expect(200);

      const after = await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlist.data.id}`)
        .set(auth(host.token))
        .expect(200);

      // Still the host's, and no longer pointing at anything. A dangling
      // eventId leaves the list stuck in a visibility that can never resolve —
      // EVENT_ONLY admits accepted invitees of an event that is gone, so it is
      // permanently invisible to everyone but its owner while still claiming
      // to belong to a party.
      expect((after.body as Envelope<{ eventId: string | null }>).data.eventId).toBeNull();
    });

    it('refuses more ids than a multi-select could produce', async () => {
      const host = await newUser();
      await bulkDelete(
        host,
        Array.from({ length: 51 }, () => newObjectId()),
      ).expect(400);
    });
  });

  describe('group gifts on an invitation (291:1008)', () => {
    /// A wishlist with one priced item, attached to the event.
    const wishlistOn = async (
      host: Actor,
      eventId: string,
    ): Promise<{ wishlistId: string; itemId: string }> => {
      const wishlist = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(host.token))
          .send({ title: 'Gift ideas', visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlist.data.id}/items`)
          .set(auth(host.token))
          .send({ title: 'A telescope', price: { amountMinor: 500000 } })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await request(app.getHttpServer())
        .patch(`${V1}/events/${eventId}`)
        .set(auth(host.token))
        .send({ wishlistIds: [wishlist.data.id] })
        .expect(200);
      return { wishlistId: wishlist.data.id, itemId: item.data.id };
    };

    const startGroupGift = (gifter: Actor, itemId: string, title: string) =>
      request(app.getHttpServer())
        .post(`${V1}/items/${itemId}/group-gift`)
        .set(auth(gifter.token))
        .set({ 'Idempotency-Key': randomUUID() })
        .send({ title, targetAmountMinor: 500000 });

    it('a gift started on the event’s wishlist shows on the invitation', async () => {
      const host = await newUser();
      const gifter = await newUser();
      const guest = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      const { itemId } = await wishlistOn(host, event.id);

      await startGroupGift(gifter, itemId, 'Telescope fund').expect(201);

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);
      const token = await InviteTokenHelper.only(app, host.token, event.id);

      const view = (
        await request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).expect(200)
      ).body as Envelope<{ groupGifts: { id: string; title: string }[] }>;

      // The row `291:1008` draws. Title and id only — the amounts and who has
      // paid stay behind the group's own endpoint.
      expect(view.data.groupGifts).toHaveLength(1);
      expect(view.data.groupGifts[0].title).toBe('Telescope fund');
      expect(Object.keys(view.data.groupGifts[0]).sort()).toEqual(['id', 'title']);
    });

    it('an event with no group gift lists none rather than omitting the field', async () => {
      const host = await newUser();
      const guest = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);
      const token = await InviteTokenHelper.only(app, host.token, event.id);

      const view = (
        await request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).expect(200)
      ).body as Envelope<{ groupGifts: unknown[] }>;

      expect(view.data.groupGifts).toEqual([]);
    });

    it('a gift on a list attached to no event belongs to no event', async () => {
      const host = await newUser();
      const gifter = await newUser();
      const guest = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);

      // A wishlist that is never attached — the item is giftable, the group is
      // real, but it is not for this party.
      const wishlist = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(host.token))
          .send({ title: 'Unrelated', visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const item = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists/${wishlist.data.id}/items`)
          .set(auth(host.token))
          .send({ title: 'A kettle', price: { amountMinor: 500000 } })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await startGroupGift(gifter, item.data.id, 'Kettle fund').expect(201);

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);
      const token = await InviteTokenHelper.only(app, host.token, event.id);

      const view = (
        await request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).expect(200)
      ).body as Envelope<{ groupGifts: unknown[] }>;

      expect(view.data.groupGifts).toEqual([]);
    });

    it('a cancelled group drops off the invitation', async () => {
      const host = await newUser();
      const gifter = await newUser();
      const guest = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      const { itemId } = await wishlistOn(host, event.id);
      const gift = (await startGroupGift(gifter, itemId, 'Telescope fund').expect(201))
        .body as Envelope<{ id: string }>;

      await request(app.getHttpServer())
        .post(`${V1}/group-gifts/${gift.data.id}/cancel`)
        .set(auth(gifter.token))
        .expect(200);

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);
      const token = await InviteTokenHelper.only(app, host.token, event.id);

      const view = (
        await request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).expect(200)
      ).body as Envelope<{ groupGifts: unknown[] }>;

      // Still linked to the event, but not something an invitee can join —
      // and a row inviting them to would be worse than no row.
      expect(view.data.groupGifts).toEqual([]);
    });

    it('detaching the wishlist afterwards leaves the gift where it was', async () => {
      const host = await newUser();
      const gifter = await newUser();
      const guest = await newUser();
      const event = await createEvent(host);
      await publish(host, event.id);
      const { itemId } = await wishlistOn(host, event.id);
      await startGroupGift(gifter, itemId, 'Telescope fund').expect(201);

      // The list moves off the event. The group people have already committed
      // to belongs to the party it was started for — deriving the link on read
      // would silently take it away.
      await request(app.getHttpServer())
        .patch(`${V1}/events/${event.id}`)
        .set(auth(host.token))
        .send({ wishlistIds: [] })
        .expect(200);

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/invites`)
        .set(auth(host.token))
        .send({ recipients: [{ userId: guest.userId }] })
        .expect(200);
      const token = await InviteTokenHelper.only(app, host.token, event.id);

      const view = (
        await request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).expect(200)
      ).body as Envelope<{ groupGifts: { title: string }[] }>;

      expect(view.data.groupGifts).toHaveLength(1);
      expect(view.data.groupGifts[0].title).toBe('Telescope fund');
    });
  });

  describe('join by share link', () => {
    const publicEvent = async (host: Actor, over: Record<string, unknown> = {}) => {
      const event = await createEvent(host, { visibility: 'public', ...over });
      if (over.status !== 'draft') await publish(host, event.id);
      const full = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView & { share?: { slug: string } }>;
      return { id: event.id, slug: full.data.share!.slug };
    };

    const join = (guest: Actor, slug: string) =>
      request(app.getHttpServer()).post(`${V1}/events/by-slug/${slug}/join`).set(auth(guest.token));

    it('mints an invite whose token the existing RSVP flow accepts', async () => {
      const host = await newUser();
      const guest = await newUser();
      const event = await publicEvent(host);

      const joined = (await join(guest, event.slug).expect(201)).body as Envelope<{
        token: string;
      }>;
      const token = joined.data.token;

      // The whole point of returning a token: nothing new is needed to answer.
      const view = await request(app.getHttpServer())
        .get(`${V1}/public/invites/${token}`)
        .expect(200);
      expect(view.body.data.event.title).toBe('Big Party');

      await request(app.getHttpServer())
        .post(`${V1}/public/invites/${token}/rsvp`)
        .send({ response: 'yes' })
        .expect(200);

      const counts = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView>;
      expect(counts.data.rsvpCounts).toMatchObject({ yes: 1, invited: 1 });
    });

    it('is idempotent — a link tapped twice is one guest, not two', async () => {
      const host = await newUser();
      const guest = await newUser();
      const event = await publicEvent(host);

      const first = (await join(guest, event.slug).expect(201)).body as Envelope<{ token: string }>;
      const second = (await join(guest, event.slug).expect(201)).body as Envelope<{
        token: string;
      }>;

      // A second row would split the RSVP: answer on one, the host sees the
      // other still pending.
      expect(second.data.token).toBe(first.data.token);

      const invites = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(invites.data).toHaveLength(1);
    });

    it('keeps an answer already given when the link is reopened', async () => {
      const host = await newUser();
      const guest = await newUser();
      const event = await publicEvent(host);

      const token = (
        (await join(guest, event.slug).expect(201)).body as Envelope<{ token: string }>
      ).data.token;
      await request(app.getHttpServer())
        .post(`${V1}/public/invites/${token}/rsvp`)
        .send({ response: 'yes' })
        .expect(200);

      // Reopened after an install, say. Re-minting would silently drop the yes.
      await join(guest, event.slug).expect(201);

      const view = await request(app.getHttpServer())
        .get(`${V1}/public/invites/${token}`)
        .expect(200);
      expect(view.body.data.invitee.rsvp).toBe('yes');
    });

    it('refuses a private event, naming the reason — the host decides who comes', async () => {
      // This used to 404 like everything else, so a stranger could not learn
      // the event existed. It says why now: a host sends this same link to
      // phone numbers from their contacts, and somebody who was sent it has
      // to be told they are not on the list rather than shown a dead page.
      // The slug is still unguessable, so what leaks is only that the link
      // they were handed is a real one.
      const host = await newUser();
      const guest = await newUser();
      const event = await publicEvent(host, { visibility: 'private' });

      const res = await join(guest, event.slug).expect(403);
      expect(res.body.error.code).toBe(ErrorCode.EVENT_INVITE_REQUIRED);
    });

    it('lets an invite_only event in — it is defined as reachable by link', async () => {
      const host = await newUser();
      const guest = await newUser();
      const event = await publicEvent(host, { visibility: 'invite_only' });

      await join(guest, event.slug).expect(201);
    });

    it('refuses a draft, so an unsent party cannot be gate-crashed', async () => {
      const host = await newUser();
      const guest = await newUser();
      const draft = await createEvent(host, { visibility: 'public' });
      const full = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${draft.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView & { share?: { slug: string } }>;

      const res = await join(guest, full.data.share!.slug).expect(404);
      expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
    });

    it('refuses the host their own link', async () => {
      const host = await newUser();
      const event = await publicEvent(host);

      const res = await join(host, event.slug).expect(400);
      expect(res.body.error.code).toBe('CANNOT_INVITE_HOST');
    });

    it('will not undo a revoke — the host took that access away on purpose', async () => {
      const host = await newUser();
      const guest = await newUser();
      const event = await publicEvent(host);
      await join(guest, event.slug).expect(201);

      const invites = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ id: string }[]>;
      await request(app.getHttpServer())
        .delete(`${V1}/events/${event.id}/invites/${invites.data[0].id}`)
        .set(auth(host.token))
        .expect(204);

      const res = await join(guest, event.slug).expect(404);
      expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
    });

    it('answers 404 for a slug that never existed', async () => {
      const guest = await newUser();
      const res = await join(guest, 'nosuchslug123456').expect(404);
      expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
    });
  });

  // -- Inviting from the host's contacts ------------------------------------

  describe('invites by phone number', () => {
    let phoneSeq = 0;
    const uniquePhone = (): string => `+9199${String(1000000 + ++phoneSeq).slice(-7)}`;

    /** A private event, which is the case phone invites exist for. */
    const privateEvent = async (host: Actor): Promise<{ id: string; slug: string }> => {
      const event = await createEvent(host, { visibility: 'private' });
      await publish(host, event.id);
      const full = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView & { share?: { slug: string } }>;
      return { id: event.id, slug: full.data.share!.slug };
    };

    const inviteByPhone = (host: Actor, eventId: string, phones: string[]) =>
      request(app.getHttpServer())
        .post(`${V1}/events/${eventId}/invites/by-phone`)
        .set(auth(host.token))
        .send({ phones });

    /**
     * An account whose number is verified — what a passwordless sign-in leaves
     * behind, which is the state a claim requires.
     *
     * Set on the document rather than driven through `/auth/otp/*`: that route
     * allows three requests per five minutes per caller, and a block that
     * needs half a dozen accounts would exhaust the budget and start 429ing
     * every later test in the file. What the OTP flow itself does is
     * otp-login's own suite to prove; this one is about invitations.
     */
    const signInByPhone = async (phone: string): Promise<Actor> => {
      const actor = await newUser();
      await userModel
        .updateOne(
          { _id: new Types.ObjectId(actor.userId) },
          { $set: { phone, phoneVerifiedAt: new Date() } },
        )
        .exec();
      return actor;
    };

    const join = (actor: Actor, slug: string) =>
      request(app.getHttpServer())
        .post(`${V1}/events/by-slug/${slug}/join`)
        .set(auth(actor.token));

    it('lets somebody with no account yet be invited, and claim it after signing up', async () => {
      // The whole point: on the day a host starts, none of their friends are
      // on Wishtick, so there is no account to address an invite to.
      const host = await newUser();
      const event = await privateEvent(host);
      const phone = uniquePhone();

      const invited = (await inviteByPhone(host, event.id, [phone]).expect(200))
        .body as Envelope<{ created: unknown[]; duplicates: number }>;
      expect(invited.data.created).toHaveLength(1);

      // They install, sign in with that number, and open the link.
      const guest = await signInByPhone(phone);
      const joined = (await join(guest, event.slug).expect(201)).body as Envelope<{
        token: string;
      }>;
      expect(joined.data.token).toEqual(expect.any(String));

      // Claimed, not duplicated: the host's one row now names them.
      const list = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ invitedUserId: string | null; invitedPhone: string | null }[]>;
      expect(list.data).toHaveLength(1);
      expect(list.data[0].invitedUserId).toBe(guest.userId);
      expect(list.data[0].invitedPhone).toBe(phone);
    });

    it('opening the link twice lands on the same invite', async () => {
      const host = await newUser();
      const event = await privateEvent(host);
      const phone = uniquePhone();
      await inviteByPhone(host, event.id, [phone]).expect(200);
      const guest = await signInByPhone(phone);

      const first = (await join(guest, event.slug).expect(201)).body as Envelope<{ token: string }>;
      const second = (await join(guest, event.slug).expect(201)).body as Envelope<{ token: string }>;

      expect(second.data.token).toBe(first.data.token);
    });

    it('tells an uninvited caller they are not on the list, rather than 404', async () => {
      // A private event's link used to 404 for everyone. Now a host sends that
      // link to numbers, so the people who get it must be told why it will not
      // open. The slug is still unguessable.
      const host = await newUser();
      const event = await privateEvent(host);
      const stranger = await signInByPhone(uniquePhone());

      const res = await join(stranger, event.slug).expect(403);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.EVENT_INVITE_REQUIRED);
    });

    it('refuses an unverified number, however it got onto the account', async () => {
      // Otherwise typing a friend's number onto your own profile would be a
      // way into their private event.
      const host = await newUser();
      const event = await privateEvent(host);
      const phone = uniquePhone();
      await inviteByPhone(host, event.id, [phone]).expect(200);

      // An account carrying the number with nothing verifying it.
      const impostor = await newUser();
      await userModel
        .updateOne(
          { _id: new Types.ObjectId(impostor.userId) },
          { $set: { phone, phoneVerifiedAt: null } },
        )
        .exec();

      const res = await join(impostor, event.slug).expect(403);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.EVENT_INVITE_REQUIRED);
    });

    it('binds a number that already has an account straight away', async () => {
      // So the guest list names them from the start rather than showing a bare
      // number until they happen to open the link.
      const host = await newUser();
      const event = await privateEvent(host);
      const phone = uniquePhone();
      const friend = await signInByPhone(phone);

      await inviteByPhone(host, event.id, [phone]).expect(200);

      const list = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/invites`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ invitedUserId: string | null }[]>;
      expect(list.data[0].invitedUserId).toBe(friend.userId);
    });

    it('collapses the same number written two ways, and skips the host', async () => {
      // A contacts list routinely holds one person twice, spaced differently.
      const host = await newUser();
      const event = await privateEvent(host);
      const phone = uniquePhone();
      const spaced = `${phone.slice(0, 3)} ${phone.slice(3, 8)} ${phone.slice(8)}`;

      const res = (
        await inviteByPhone(host, event.id, [phone, spaced, phone]).expect(200)
      ).body as Envelope<{ created: unknown[]; duplicates: number }>;

      expect(res.data.created).toHaveLength(1);
      expect(res.data.duplicates).toBe(2);
    });

    it('refuses to invite anyone to an unpublished event', async () => {
      const host = await newUser();
      const draft = await createEvent(host, { visibility: 'private' });

      const res = await inviteByPhone(host, draft.id, [uniquePhone()]).expect(409);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.EVENT_NOT_PUBLISHED);
    });

    it('is the host’s alone to send', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await privateEvent(host);

      await inviteByPhone(stranger, event.id, [uniquePhone()]).expect(404);
    });
  });

  // -- Guests offering their own wishlists ----------------------------------

  describe('guest wishlists on an event', () => {
    const publicEvent = async (host: Actor) => {
      const event = await createEvent(host, { visibility: 'public' });
      await publish(host, event.id);
      const full = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView & { share?: { slug: string } }>;
      return { id: event.id, slug: full.data.share!.slug };
    };

    /** Joins, then says yes - the RSVP is what the access grant is built on. */
    const attend = async (guest: Actor, slug: string): Promise<string> => {
      const joined = (
        await request(app.getHttpServer())
          .post(`${V1}/events/by-slug/${slug}/join`)
          .set(auth(guest.token))
          .expect(201)
      ).body as Envelope<{ token: string }>;
      await request(app.getHttpServer())
        .post(`${V1}/public/invites/${joined.data.token}/rsvp`)
        .send({ response: 'yes' })
        .expect(200);
      return joined.data.token;
    };

    const privateList = async (owner: Actor, title = 'My birthday list') => {
      const wl = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title, visibility: 'private' })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      return wl.data.id;
    };

    const offer = (guest: Actor, eventId: string, wishlistId: string) =>
      request(app.getHttpServer())
        .post(`${V1}/events/${eventId}/wishlist-requests`)
        .set(auth(guest.token))
        .send({ wishlistId });

    /**
     * The invite view, signed in.
     *
     * The token says which invitation; the bearer says who is holding it. An
     * EVENT_ONLY list resolves only for the signed-in invited user, so an
     * anonymous read would show nothing and prove nothing.
     */
    const inviteView = (token: string, viewer: Actor) =>
      request(app.getHttpServer()).get(`${V1}/public/invites/${token}`).set(auth(viewer.token));

    /** Let the fire-and-forget listener enqueue, then run the queued jobs. */
    const settle = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 150));
      await ctx.drainNotifications();
    };

    const inAppFor = async (actor: Actor): Promise<{ type: string }[]> => {
      const res = await request(app.getHttpServer())
        .get(`${V1}/notifications`)
        .set(auth(actor.token))
        .expect(200);
      return (res.body as Envelope<{ type: string }[]>).data;
    };

    it("badges the host's event list with how many offers are waiting", async () => {
      // The queue lives at the foot of one event's page. Without a count on
      // the event itself, "My Events" had nothing to badge and a host had no
      // reason to scroll there.
      const host = await newUser('Rohan');
      const guest = await newUser('Priya');
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const listId = await privateList(guest, 'For Rohan');
      const offered = (await offer(guest, event.id, listId).expect(200))
        .body as Envelope<{ id: string }>;

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/events/mine`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ id: string; pendingWishlistCount?: number }[]>;
      expect(mine.data.find((e) => e.id === event.id)?.pendingWishlistCount).toBe(1);

      const one = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ pendingWishlistCount?: number }>;
      expect(one.data.pendingWishlistCount).toBe(1);

      // Answering it clears the badge, whichever way the host decides.
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/approve`)
        .set(auth(host.token))
        .expect(200);

      const after = (
        await request(app.getHttpServer())
          .get(`${V1}/events/mine`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ id: string; pendingWishlistCount?: number }[]>;
      expect(after.data.find((e) => e.id === event.id)?.pendingWishlistCount).toBe(0);
    });

    it('tells the host an offer arrived, and the guest how it was answered', async () => {
      // Both halves used to be silent: the host was never told an offer was
      // waiting, and the guest was never told it had been answered.
      const host = await newUser('Rohan');
      const guest = await newUser('Priya');
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const listId = await privateList(guest, 'For Rohan');
      await settle(); // flush the signup notifications first

      const offered = (await offer(guest, event.id, listId).expect(200))
        .body as Envelope<{ id: string }>;
      await settle();

      expect(
        (await inAppFor(host)).filter((n) => n.type === 'event_wishlist_offered'),
      ).toHaveLength(1);
      // And not to the guest, who is the one who sent it.
      expect(
        (await inAppFor(guest)).filter((n) => n.type === 'event_wishlist_offered'),
      ).toHaveLength(0);

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/approve`)
        .set(auth(host.token))
        .expect(200);
      await settle();

      expect(
        (await inAppFor(guest)).filter((n) => n.type === 'event_wishlist_answered'),
      ).toHaveLength(1);
    });

    it('tells the guest when the host declines, too', async () => {
      const host = await newUser('Rohan');
      const guest = await newUser('Priya');
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const listId = await privateList(guest, 'For Rohan');
      await settle();

      const offered = (await offer(guest, event.id, listId).expect(200))
        .body as Envelope<{ id: string }>;
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/reject`)
        .set(auth(host.token))
        .expect(200);
      await settle();

      // Silence on a decline is the worse half: the guest waits forever for a
      // list that is never going to appear.
      expect(
        (await inAppFor(guest)).filter((n) => n.type === 'event_wishlist_answered'),
      ).toHaveLength(1);
    });

    it('stays off the invitation until the host approves it', async () => {
      const host = await newUser('Rohan');
      const guest = await newUser('Siya');
      const other = await newUser('Ananya');
      const event = await publicEvent(host);
      const guestToken = await attend(guest, event.slug);
      const otherToken = await attend(other, event.slug);
      const wishlistId = await privateList(guest);

      const offered = (await offer(guest, event.id, wishlistId).expect(200)).body as Envelope<{
        id: string;
        status: string;
        requestedByName: string;
      }>;
      expect(offered.data.status).toBe('pending');
      // Who offered it - the host is deciding, and an id names nobody.
      expect(offered.data.requestedByName).toBe('Siya');

      // Pending shows to nobody.
      const before = (await inviteView(otherToken, other).expect(200)).body as Envelope<{
        wishlists: { title: string }[];
      }>;
      expect(before.data.wishlists.map((w) => w.title)).not.toContain('My birthday list');

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/approve`)
        .set(auth(host.token))
        .expect(200);

      // Now the other guests know it exists - and only that. The owner kept it
      // private, and the host approving it is not the owner publishing it.
      const after = (await inviteView(otherToken, other).expect(200)).body as Envelope<{
        wishlists: { slug: string | null; title: string; locked: boolean }[];
      }>;
      const row = after.data.wishlists.find((w) => w.title === 'My birthday list');
      expect(row).toBeDefined();
      expect(row!.locked).toBe(true);
      expect(row!.slug).toBeNull();
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}`)
        .set(auth(other.token))
        .expect(404);

      // Nor the host: the usual offer is a surprise list a guest made *for*
      // them, and approving it must not be how they get to read it.
      await request(app.getHttpServer())
        .get(`${V1}/wishlists/${wishlistId}`)
        .set(auth(host.token))
        .expect(404);

      // Still private, in the owner's own view.
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}`)
          .set(auth(guest.token))
          .expect(200)
      ).body as Envelope<{ visibility: string }>;
      expect(mine.data.visibility).toBe('private');

      await inviteView(guestToken, guest).expect(200);
    });

    it('a public list, once approved, opens from the invitation', async () => {
      const host = await newUser();
      const guest = await newUser();
      const other = await newUser();
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const otherToken = await attend(other, event.slug);
      const wl = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(guest.token))
          .send({ title: 'Open list', visibility: 'public' })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const offered = (await offer(guest, event.id, wl.data.id).expect(200)).body as Envelope<{
        id: string;
      }>;
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/approve`)
        .set(auth(host.token))
        .expect(200);

      const view = (await inviteView(otherToken, other).expect(200)).body as Envelope<{
        wishlists: { slug: string | null; title: string; locked: boolean }[];
      }>;
      const row = view.data.wishlists.find((w) => w.title === 'Open list');
      expect(row).toBeDefined();
      expect(row!.locked).toBe(false);
      expect(row!.slug).not.toBeNull();
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${row!.slug}`)
        .set(auth(other.token))
        .expect(200);
    });

    // The host's own private list keeps its old behaviour: it stays off the
    // invitation entirely. Attaching it was not a decision to publish it, and
    // nobody approved anything.
    it('the host s own private list is still not listed at all', async () => {
      const host = await newUser();
      const other = await newUser();
      const wishlistId = await privateList(host, 'Host private');
      const event = await createEvent(host, {
        visibility: 'public',
        wishlistIds: [wishlistId],
      });
      await publish(host, event.id);
      const full = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView & { share?: { slug: string } }>;
      const otherToken = await attend(other, full.data.share!.slug);

      const view = (await inviteView(otherToken, other).expect(200)).body as Envelope<{
        wishlists: { title: string }[];
      }>;
      expect(view.data.wishlists.map((w) => w.title)).not.toContain('Host private');
    });

    // Knowing who is asking may only ever *widen* what the link allows. These
    // pin the other side of that: the slug still opens for nobody else.
    it('an event-only list opens by slug for the event and nobody else', async () => {
      const host = await newUser();
      const guest = await newUser();
      const outsider = await newUser();
      const wishlistId = await privateList(host, 'For my guests');
      const event = await createEvent(host, {
        visibility: 'public',
        wishlistIds: [wishlistId],
      });
      await publish(host, event.id);
      // Linking set eventId, which is what EVENT_ONLY needs to mean anything.
      await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlistId}`)
        .set(auth(host.token))
        .send({ visibility: 'event_only' })
        .expect(200);
      const full = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<EventView & { share?: { slug: string } }>;
      const guestToken = await attend(guest, full.data.share!.slug);

      const view = (await inviteView(guestToken, guest).expect(200)).body as Envelope<{
        wishlists: { slug: string | null; title: string; locked: boolean }[];
      }>;
      const row = view.data.wishlists.find((w) => w.title === 'For my guests');
      expect(row).toBeDefined();
      expect(row!.locked).toBe(false);
      const slug = row!.slug!;

      // An accepted guest opens it by the slug the invitation handed them. The
      // route resolves on the link *and* the caller, which is the fix: on the
      // link alone it refused EVENT_ONLY for everybody.
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${slug}`)
        .set(auth(guest.token))
        .expect(200);

      // Signed in, holding the slug, but not going: still nothing.
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${slug}`)
        .set(auth(outsider.token))
        .expect(404);

      // And a plain link-holder with no account at all.
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/${slug}`).expect(404);
    });

    // The other half of the same decision. Knowing the caller must not have
    // replaced the link: an unlisted list is openable by whoever holds the
    // slug, account or no account, and nothing else in the suite pinned that
    // -- the public slug route had no HTTP test at all.
    it('an unlisted list still opens for whoever holds the link', async () => {
      const owner = await newUser();
      const holder = await newUser();
      const wl = (
        await request(app.getHttpServer())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: 'Unlisted', visibility: 'invite_only' })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wl.data.id}`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ share?: { slug: string } }>;
      const slug = mine.data.share!.slug;

      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${slug}`)
        .set(auth(holder.token))
        .expect(200);
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/${slug}`).expect(200);
    });

    it('a private list is still never openable by link', async () => {
      const owner = await newUser();
      const viewer = await newUser();
      const wishlistId = await privateList(owner, 'Just mine');
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}`)
          .set(auth(owner.token))
          .expect(200)
      ).body as Envelope<{ share?: { slug: string } }>;
      const slug = mine.data.share!.slug;

      // The owner's own link still opens for the owner - resolving on the
      // caller must not have broken that either.
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${slug}`)
        .set(auth(owner.token))
        .expect(200);

      // Everyone else, signed in or not.
      await request(app.getHttpServer())
        .get(`${V1}/public/wishlists/${slug}`)
        .set(auth(viewer.token))
        .expect(404);
      await request(app.getHttpServer()).get(`${V1}/public/wishlists/${slug}`).expect(404);
    });

    it('only accepted guests may offer a list', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const event = await publicEvent(host);
      const wishlistId = await privateList(stranger);

      // Not invited at all: a 404, not a 403 - someone not going has no
      // business learning the event exists.
      await offer(stranger, event.id, wishlistId).expect(404);

      // Joined but still undecided is not enough either.
      await request(app.getHttpServer())
        .post(`${V1}/events/by-slug/${event.slug}/join`)
        .set(auth(stranger.token))
        .expect(201);
      await offer(stranger, event.id, wishlistId).expect(404);
    });

    it('refuses a wishlist the offerer does not own', async () => {
      const host = await newUser();
      const guest = await newUser();
      const owner = await newUser();
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const notMine = await privateList(owner);

      await offer(guest, event.id, notMine).expect(404);
    });

    it('a wishlist belongs to one event at a time', async () => {
      const host = await newUser();
      const guest = await newUser();
      const first = await publicEvent(host);
      const second = await publicEvent(host);
      await attend(guest, first.slug);
      await attend(guest, second.slug);
      const wishlistId = await privateList(guest);

      await offer(guest, first.id, wishlistId).expect(200);
      // Only offered, not yet approved - but it is already spoken for.
      await offer(guest, second.id, wishlistId).expect(409);
    });

    it('turning it down leaves the list alone', async () => {
      const host = await newUser();
      const guest = await newUser();
      const other = await newUser();
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const otherToken = await attend(other, event.slug);
      const wishlistId = await privateList(guest);
      const offered = (await offer(guest, event.id, wishlistId).expect(200)).body as Envelope<{
        id: string;
      }>;

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/reject`)
        .set(auth(host.token))
        .expect(200);

      const view = (await inviteView(otherToken, other).expect(200)).body as Envelope<{
        wishlists: { title: string }[];
      }>;
      expect(view.data.wishlists).toHaveLength(0);

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${wishlistId}`)
          .set(auth(guest.token))
          .expect(200)
      ).body as Envelope<{ visibility: string }>;
      expect(mine.data.visibility).toBe('private');
    });

    /**
     * Approves a fresh offer and hands back what is needed to undo it.
     *
     * A helper rather than a loop inside one test: six signups in a single
     * case trips the 5/hr signup throttle, and the failure looks like a
     * broken join rather than the rate limit it is.
     */
    const approved = async () => {
      const host = await newUser();
      const guest = await newUser();
      const other = await newUser();
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const otherToken = await attend(other, event.slug);
      const wishlistId = await privateList(guest);
      const offered = (await offer(guest, event.id, wishlistId).expect(200)).body as Envelope<{
        id: string;
      }>;
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/approve`)
        .set(auth(host.token))
        .expect(200);
      return { host, guest, other, event, otherToken, wishlistId, requestId: offered.data.id };
    };

    /** Gone from the invitation, and private again. */
    const expectTakenDown = async (ctxt: Awaited<ReturnType<typeof approved>>) => {
      const view = (await inviteView(ctxt.otherToken, ctxt.other).expect(200)).body as Envelope<{
        wishlists: { title: string }[];
      }>;
      expect(view.data.wishlists).toHaveLength(0);

      // Approval never touched the visibility, and neither did removal.
      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/wishlists/${ctxt.wishlistId}`)
          .set(auth(ctxt.guest.token))
          .expect(200)
      ).body as Envelope<{ visibility: string }>;
      expect(mine.data.visibility).toBe('private');
    };

    it('the host can take it back down, and the list goes back to private', async () => {
      const ctxt = await approved();
      await request(app.getHttpServer())
        .delete(`${V1}/events/${ctxt.event.id}/wishlist-requests/${ctxt.requestId}`)
        .set(auth(ctxt.host.token))
        .expect(200);
      await expectTakenDown(ctxt);
    });

    it('the owner can withdraw it, and the list goes back to private', async () => {
      const ctxt = await approved();
      await request(app.getHttpServer())
        .delete(`${V1}/events/${ctxt.event.id}/wishlist-requests/${ctxt.requestId}`)
        .set(auth(ctxt.guest.token))
        .expect(200);
      await expectTakenDown(ctxt);
    });

    // Taking it down has to *unlink* it, not just hide it. A list left pointing
    // at the event is invisible either way, so nothing above can tell the
    // difference -- but it stays spoken for and can never be offered again.
    it('a withdrawn list is free to be offered somewhere else', async () => {
      const ctxt = await approved();
      await request(app.getHttpServer())
        .delete(`${V1}/events/${ctxt.event.id}/wishlist-requests/${ctxt.requestId}`)
        .set(auth(ctxt.guest.token))
        .expect(200);

      const second = await publicEvent(ctxt.host);
      await attend(ctxt.guest, second.slug);
      await offer(ctxt.guest, second.id, ctxt.wishlistId).expect(200);
    });

    it('answering the same request twice is refused', async () => {
      const host = await newUser();
      const guest = await newUser();
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const wishlistId = await privateList(guest);
      const offered = (await offer(guest, event.id, wishlistId).expect(200)).body as Envelope<{
        id: string;
      }>;

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/reject`)
        .set(auth(host.token))
        .expect(200);
      // Approving a list already turned down would relink it behind the host.
      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/approve`)
        .set(auth(host.token))
        .expect(409);
    });

    it('an outsider cannot answer or remove', async () => {
      const host = await newUser();
      const guest = await newUser();
      const nosy = await newUser();
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const wishlistId = await privateList(guest);
      const offered = (await offer(guest, event.id, wishlistId).expect(200)).body as Envelope<{
        id: string;
      }>;

      await request(app.getHttpServer())
        .post(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}/approve`)
        .set(auth(nosy.token))
        .expect(404);
      await request(app.getHttpServer())
        .delete(`${V1}/events/${event.id}/wishlist-requests/${offered.data.id}`)
        .set(auth(nosy.token))
        .expect(404);
      await request(app.getHttpServer())
        .get(`${V1}/events/${event.id}/wishlist-requests`)
        .set(auth(nosy.token))
        .expect(404);
    });

    it('the host sees the queue and the guest sees their own offers', async () => {
      const host = await newUser('Rohan');
      const guest = await newUser('Siya');
      const event = await publicEvent(host);
      await attend(guest, event.slug);
      const wishlistId = await privateList(guest);
      await offer(guest, event.id, wishlistId).expect(200);

      const queue = (
        await request(app.getHttpServer())
          .get(`${V1}/events/${event.id}/wishlist-requests`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ wishlistTitle: string; requestedByName: string }[]>;
      expect(queue.data).toHaveLength(1);
      expect(queue.data[0].wishlistTitle).toBe('My birthday list');
      expect(queue.data[0].requestedByName).toBe('Siya');

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/event-wishlist-requests/mine`)
          .set(auth(guest.token))
          .expect(200)
      ).body as Envelope<{ status: string }[]>;
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0].status).toBe('pending');
    });
  });
});

/**
 * Pulls an invite token out of the host's own copyable link.
 *
 * Invitations are not emailed any more — they are addressed to a WishMate, who
 * finds theirs in the app — so there is no mailbox to read one out of. The
 * host-only link endpoint is the remaining way to get at a specific invitee's
 * token, and using it here means the tests exercise the same path the share
 * sheet does.
 */
class InviteTokenHelper {
  static async forInvite(
    app: INestApplication,
    hostToken: string,
    eventId: string,
    inviteId: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(`${V1}/events/${eventId}/invites/${inviteId}/link`)
      .set({ Authorization: `Bearer ${hostToken}` })
      .expect(200);
    return (res.body as Envelope<{ url: string }>).data.url.split('/').pop()!;
  }

  /** The token for the event's only invite — the common single-guest case. */
  static async only(app: INestApplication, hostToken: string, eventId: string): Promise<string> {
    const list = await request(app.getHttpServer())
      .get(`${V1}/events/${eventId}/invites`)
      .set({ Authorization: `Bearer ${hostToken}` })
      .expect(200);
    const invites = (list.body as Envelope<{ id: string }[]>).data;
    if (invites.length !== 1) throw new Error(`Expected one invite, found ${invites.length}`);
    return InviteTokenHelper.forInvite(app, hostToken, eventId, invites[0].id);
  }
}
