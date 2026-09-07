import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ErrorCode } from 'src/common/errors/error-codes';
import { MemoriesService } from 'src/modules/memories/memories.service';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import {
  MemoryCapsule,
  type MemoryCapsuleDocument,
} from 'src/modules/memories/schemas/memory-capsule.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

/** A 1x1 PNG — the smallest thing the media pipeline will accept as real bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface Actor {
  token: string;
  userId: string;
  email: string;
}

interface MemoryView {
  person: { userId: string; displayName: string | null } | null;
  id: string;
  title: string;
  personName: string;
  occasion: string;
  status: string;
  unlockAt: string;
  wishCount: number;
  contributors: string[];
  isHost: boolean;
  isRecipient: boolean;
  coverUrl: string | null;
  wishes: { id: string; kind: string; text: string | null; mediaUrl: string | null }[];
  share?: { slug: string; url: string };
}

describe('Memories (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let capsuleModel: Model<MemoryCapsuleDocument>;
  let memories: MemoriesService;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (): Promise<Actor> => {
    const email = `mem${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'Aarav Sharma' })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id, email };
  };

  const IN_A_WEEK = (): string => new Date(Date.now() + 7 * 86_400_000).toISOString();

  /** Links two accounts, which a memory's recipient now has to be. */
  const becomeWishmates = async (a: Actor, b: Actor): Promise<void> => {
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

  /** A host with a WishMate to make memories for. */
  const hostAndRecipient = async (): Promise<{ host: Actor; recipient: Actor }> => {
    const host = await newUser();
    const recipient = await newUser();
    await becomeWishmates(host, recipient);
    return { host, recipient };
  };

  const createMemory = async (
    host: Actor,
    over: Record<string, unknown> = {},
    recipient?: Actor,
  ): Promise<MemoryView> => {
    const forWhom = recipient ?? (await hostAndRecipient()).recipient;
    if (!recipient) await becomeWishmates(host, forWhom);
    const res = await request(app.getHttpServer())
      .post(`${V1}/memories`)
      .set(auth(host.token))
      .send({
        title: "Ananya's Birthday",
        recipientUserId: forWhom.userId,
        relation: 'partner_wife',
        occasion: 'birthday',
        unlockAt: IN_A_WEEK(),
        timezone: 'Asia/Kolkata',
        ...over,
      })
      .expect(201);
    return (res.body as Envelope<MemoryView>).data;
  };

  /** Presign → PUT the real bytes → confirm, for one purpose. */
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

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    capsuleModel = app.get<Model<MemoryCapsuleDocument>>(getModelToken(MemoryCapsule.name));
    memories = app.get(MemoriesService);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  // Signup is capped at 5/hour per IP, and every test here mints two or three
  // users. Without this the sixth account in the run is throttled.
  beforeEach(async () => {
    await ctx.reset();
  });

  describe('upload limits', () => {
    it('reports the cap a wish composer has to enforce', async () => {
      const actor = await newUser();
      const res = await request(app.getHttpServer())
        .get(`${V1}/media/limits`)
        .set(auth(actor.token))
        .expect(200);

      const body = res.body as Envelope<Record<string, { maxBytes: number; mimeTypes: string[] }>>;
      const wish = body.data[MediaPurpose.MEMORY_WISH];

      // The effective cap, not the policy file's 50 MB: MEDIA_MAX_BYTES clamps
      // it, and the app has to be told the smaller of the two or it promises an
      // upload this deployment refuses.
      expect(wish.maxBytes).toBe(10 * 1024 * 1024);
      expect(wish.mimeTypes).toContain('video/mp4');
    });

    it('reports the 20-second ceiling a video wish is held to', async () => {
      const actor = await newUser();
      const res = await request(app.getHttpServer())
        .get(`${V1}/media/limits`)
        .set(auth(actor.token))
        .expect(200);

      const body = res.body as Envelope<Record<string, { maxDurationSeconds: number | null }>>;

      // Size and length are independent: a well-compressed five-minute clip
      // slips under 10 MB, so the byte cap alone would not hold this.
      expect(body.data[MediaPurpose.MEMORY_WISH].maxDurationSeconds).toBe(20);
      // A still has nothing to measure.
      expect(body.data[MediaPurpose.WISHLIST_COVER].maxDurationSeconds).toBeNull();
    });

    it('is a route of its own, not a media id', async () => {
      // `@Get('limits')` has to be declared before `@Get(':id')`. The other way
      // round, Nest reads this as a request for the media called "limits" and
      // answers 404 — with no compile error to say so.
      const actor = await newUser();
      const res = await request(app.getHttpServer())
        .get(`${V1}/media/limits`)
        .set(auth(actor.token))
        .expect(200);

      const body = res.body as Envelope<Record<string, unknown>>;
      expect(body.data[MediaPurpose.MEMORY_WISH]).toBeDefined();
    });

    it('agrees with what upload-url actually enforces', async () => {
      const actor = await newUser();
      const limits = (
        await request(app.getHttpServer())
          .get(`${V1}/media/limits`)
          .set(auth(actor.token))
          .expect(200)
      ).body as Envelope<Record<string, { maxBytes: number }>>;
      const cap = limits.data[MediaPurpose.MEMORY_WISH].maxBytes;

      // One byte over is refused...
      const tooBig = await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(actor.token))
        .send({
          purpose: MediaPurpose.MEMORY_WISH,
          contentType: 'video/mp4',
          sizeBytes: cap + 1,
        })
        .expect(413);
      expect((tooBig.body as Envelope<unknown>).error?.code).toBe(ErrorCode.MEDIA_TOO_LARGE);

      // ...and the cap itself is allowed, so a client refusing at `>=` would
      // reject a file the server would have taken.
      await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(actor.token))
        .send({
          purpose: MediaPurpose.MEMORY_WISH,
          contentType: 'video/mp4',
          sizeBytes: cap,
        })
        .expect(201);
    });
  });

  describe('replying to a memory you were given', () => {
    /** A host, a friend who wrote a wish, and an opened capsule for `recipient`. */
    const openedMemoryWithAWish = async (): Promise<{
      host: Actor;
      friend: Actor;
      recipient: Actor;
      memory: MemoryView;
    }> => {
      const { host, recipient } = await hostAndRecipient();
      const friend = await newUser();
      const memory = await createMemory(host, {}, recipient);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'text', text: 'Many happy returns' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(200);
      return { host, friend, recipient, memory };
    };

    const audienceOf = async (actor: Actor): Promise<Record<string, unknown>[]> =>
      (
        (
          await request(app.getHttpServer())
            .get(`${V1}/memories/reply-audience`)
            .set(auth(actor.token))
            .expect(200)
        ).body as Envelope<Record<string, unknown>[]>
      ).data;

    it('offers the host and everyone who wrote a wish', async () => {
      const { host, friend, recipient } = await openedMemoryWithAWish();

      const audience = audienceOf(recipient);
      const ids = (await audience).map((e) => (e.person as { userId: string }).userId);

      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([host.userId, friend.userId]));
      // The host is marked as such, so the picker can say "Made" vs "Wrote in".
      const hostRow = (await audience).find(
        (e) => (e.person as { userId: string }).userId === host.userId,
      );
      expect(hostRow?.isHost).toBe(true);
    });

    it('offers nobody while the capsule is still sealed', async () => {
      const { host, recipient } = await hostAndRecipient();
      const memory = await createMemory(host, {}, recipient);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(host.token))
        .send({ kind: 'text', text: 'Shh' })
        .expect(201);

      // Naming the contributors of a sealed capsule would give away both that
      // it exists and who is behind it — the two things the lock is for.
      expect(await audienceOf(recipient)).toHaveLength(0);
    });

    it('never offers you yourself', async () => {
      const { recipient } = await openedMemoryWithAWish();
      const ids = (await audienceOf(recipient)).map((e) => (e.person as { userId: string }).userId);
      expect(ids).not.toContain(recipient.userId);
    });

    it('sends one reply to several people at once', async () => {
      const { host, friend, recipient, memory } = await openedMemoryWithAWish();

      const sent = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/replies`)
          .set(auth(recipient.token))
          .send({
            kind: 'text',
            text: 'Thank you both so much!',
            recipientIds: [host.userId, friend.userId],
          })
          .expect(201)
      ).body as Envelope<{ recipientCount: number; isMine: boolean }>;

      expect(sent.data.recipientCount).toBe(2);
      expect(sent.data.isMine).toBe(true);

      // Both of them see it on the memory's own screen.
      for (const actor of [host, friend]) {
        const seen = (
          await request(app.getHttpServer())
            .get(`${V1}/memories/${memory.id}/replies`)
            .set(auth(actor.token))
            .expect(200)
        ).body as Envelope<{ text: string; isMine: boolean }[]>;
        expect(seen.data).toHaveLength(1);
        expect(seen.data[0].text).toBe('Thank you both so much!');
        expect(seen.data[0].isMine).toBe(false);
      }
    });

    it('refuses to address somebody who has sent you nothing', async () => {
      const { recipient } = await openedMemoryWithAWish();
      const stranger = await newUser();

      const res = await request(app.getHttpServer())
        .post(`${V1}/memories/replies`)
        .set(auth(recipient.token))
        .send({ kind: 'text', text: 'Hello', recipientIds: [stranger.userId] })
        .expect(403);

      // The whole point of deriving the audience server-side: a reply must not
      // become a way to message an arbitrary account.
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.MEMORY_REPLY_NO_AUDIENCE);
    });

    it('drops a stranger from a list that also names a real sender', async () => {
      const { host, recipient, memory } = await openedMemoryWithAWish();
      const stranger = await newUser();

      const sent = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/replies`)
          .set(auth(recipient.token))
          .send({
            kind: 'text',
            text: 'Thanks!',
            recipientIds: [host.userId, stranger.userId],
          })
          .expect(201)
      ).body as Envelope<{ recipientCount: number }>;

      // A slightly stale client is not worth refusing outright; only an empty
      // result is an error.
      expect(sent.data.recipientCount).toBe(1);

      const strangerSees = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/${memory.id}/replies`)
          .set(auth(stranger.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(strangerSees.data).toHaveLength(0);
    });

    it('is not readable by someone with no part in the memory', async () => {
      const { host, recipient, memory } = await openedMemoryWithAWish();
      const bystander = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/memories/replies`)
        .set(auth(recipient.token))
        .send({ kind: 'text', text: 'Private thanks', recipientIds: [host.userId] })
        .expect(201);

      const seen = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/${memory.id}/replies`)
          .set(auth(bystander.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(seen.data).toHaveLength(0);
    });

    it('lets the author read back and withdraw their own reply', async () => {
      const { host, recipient, memory } = await openedMemoryWithAWish();
      const sent = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/replies`)
          .set(auth(recipient.token))
          .send({ kind: 'text', text: 'Thank you', recipientIds: [host.userId] })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      const own = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/${memory.id}/replies`)
          .set(auth(recipient.token))
          .expect(200)
      ).body as Envelope<{ isMine: boolean }[]>;
      expect(own.data).toHaveLength(1);
      expect(own.data[0].isMine).toBe(true);

      await request(app.getHttpServer())
        .delete(`${V1}/memories/replies/${sent.data.id}`)
        .set(auth(recipient.token))
        .expect(204);

      // Withdrawn for everyone at once, not just for the author.
      const hostSees = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/${memory.id}/replies`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<unknown[]>;
      expect(hostSees.data).toHaveLength(0);
    });

    it('only the recipient of a memory is flagged as such', async () => {
      const { host, recipient, memory } = await openedMemoryWithAWish();

      const seenBy = async (actor: Actor): Promise<MemoryView> =>
        (
          (
            await request(app.getHttpServer())
              .get(`${V1}/memories/${memory.id}`)
              .set(auth(actor.token))
              .expect(200)
          ).body as Envelope<MemoryView>
        ).data;

      // `isRecipient` is what gates the Reply button on the client.
      expect((await seenBy(recipient)).isRecipient).toBe(true);
      expect((await seenBy(host)).isRecipient).toBe(false);
    });
  });

  describe('creating a capsule (4104:1539, 2198:73)', () => {
    it('round-trips the fields the create flow collects', async () => {
      const { host, recipient } = await hostAndRecipient();
      const created = await createMemory(
        host,
        {
          occasionDate: '2026-07-17T00:00:00.000Z',
          includeYear: true,
        },
        recipient,
      );

      expect(created.title).toBe("Ananya's Birthday");
      // Named from the recipient's own account, and carrying their id so the
      // capsule can reach them when it opens.
      expect(created.person?.userId).toBe(recipient.userId);
      expect(created.personName).toBe('Aarav Sharma');
      expect(created.occasion).toBe('birthday');
      expect(created.status).toBe('collecting');
      expect(created.isHost).toBe(true);
      // The contribute link is host-only.
      expect(created.share?.slug).toEqual(expect.any(String));
    });

    it('refuses an unlock instant in the past', async () => {
      const { host } = await hostAndRecipient();
      const res = await request(app.getHttpServer())
        .post(`${V1}/memories`)
        .set(auth(host.token))
        .send({
          title: 'Too late',
          recipientUserId: host.userId,
          occasion: 'birthday',
          unlockAt: new Date(Date.now() - 60_000).toISOString(),
          timezone: 'Asia/Kolkata',
        })
        .expect(400);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('refuses an unlock instant beyond the ceiling', async () => {
      const { host, recipient } = await hostAndRecipient();
      const farOff = new Date();
      farOff.setFullYear(farOff.getFullYear() + 6);
      await request(app.getHttpServer())
        .post(`${V1}/memories`)
        .set(auth(host.token))
        .send({
          title: 'Far future',
          recipientUserId: recipient.userId,
          occasion: 'birthday',
          unlockAt: farOff.toISOString(),
          timezone: 'Asia/Kolkata',
        })
        .expect(400);
    });

    it('attaches a cover, and refuses one uploaded for something else', async () => {
      const { host, recipient } = await hostAndRecipient();
      const coverId = await uploadMedia(host, MediaPurpose.MEMORY_COVER);
      const withCover = await createMemory(host, { coverMediaId: coverId }, recipient);
      expect(withCover.coverUrl).toEqual(expect.any(String));

      const wrongPurpose = await uploadMedia(host, MediaPurpose.WISHLIST_COVER);
      const res = await request(app.getHttpServer())
        .post(`${V1}/memories`)
        .set(auth(host.token))
        .send({
          title: 'Wrong cover',
          recipientUserId: recipient.userId,
          occasion: 'birthday',
          unlockAt: IN_A_WEEK(),
          timezone: 'Asia/Kolkata',
          coverMediaId: wrongPurpose,
        })
        .expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.MEDIA_TYPE_NOT_ALLOWED);
    });

    it('refuses a recipient who is not a WishMate', async () => {
      const host = await newUser();
      const stranger = await newUser();

      const res = await request(app.getHttpServer())
        .post(`${V1}/memories`)
        .set(auth(host.token))
        .send({
          title: 'Uninvited',
          recipientUserId: stranger.userId,
          occasion: 'birthday',
          unlockAt: IN_A_WEEK(),
          timezone: 'Asia/Kolkata',
        })
        .expect(403);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.FORBIDDEN);
    });

    it('refuses a pending request — asking is not being linked', async () => {
      const host = await newUser();
      const other = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/people/${other.userId}/request`)
        .set(auth(host.token))
        .expect(201);

      // Sent, not accepted. A memory assembled about somebody who has not
      // agreed to be connected is exactly what this rule is for.
      await request(app.getHttpServer())
        .post(`${V1}/memories`)
        .set(auth(host.token))
        .send({
          title: 'Presumptuous',
          recipientUserId: other.userId,
          occasion: 'birthday',
          unlockAt: IN_A_WEEK(),
          timezone: 'Asia/Kolkata',
        })
        .expect(403);
    });

    it('refuses a memory addressed to yourself', async () => {
      const host = await newUser();
      await request(app.getHttpServer())
        .post(`${V1}/memories`)
        .set(auth(host.token))
        .send({
          title: 'For me',
          recipientUserId: host.userId,
          occasion: 'birthday',
          unlockAt: IN_A_WEEK(),
          timezone: 'Asia/Kolkata',
        })
        .expect(400);
    });

    it('answers 404 — not 403 — for a stranger editing it', async () => {
      const host = await newUser();
      const stranger = await newUser();
      const memory = await createMemory(host);

      await request(app.getHttpServer())
        .patch(`${V1}/memories/${memory.id}`)
        .set(auth(stranger.token))
        .send({ title: 'Mine now' })
        .expect(404);
    });
  });

  // The whole point of the feature. If any of these leak, the surprise is gone.
  describe('the time-lock', () => {
    it('withholds wish content until the capsule opens, but not the count', async () => {
      const host = await newUser();
      const friend = await newUser();
      const memory = await createMemory(host);

      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'text', text: 'Happy Birthday!', contributorName: 'Priya Shah' })
        .expect(201);

      // The host — who owns it — still cannot read what is inside.
      const sealed = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/${memory.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<MemoryView>;

      expect(sealed.data.status).toBe('collecting');
      expect(sealed.data.wishes).toEqual([]);
      // Metadata IS visible — the frames show "4 Wishes" on a sealed capsule.
      expect(sealed.data.wishCount).toBe(1);
      expect(sealed.data.contributors).toEqual(['Priya']);
    });

    it('refuses the wish list outright while sealed, rather than answering empty', async () => {
      // An empty 200 would read as "nobody wrote anything", which is a lie.
      const host = await newUser();
      const friend = await newUser();
      const memory = await createMemory(host);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'text', text: 'Happy Birthday!' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(host.token))
        .expect(409);

      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.MEMORY_LOCKED);
    });

    it('never carries wish content on the public contribute link, even once open', async () => {
      const host = await newUser();
      const friend = await newUser();
      const memory = await createMemory(host);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'text', text: 'A secret message' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(200);

      const publicView = (
        await request(app.getHttpServer())
          .get(`${V1}/public/memories/${memory.share!.slug}`)
          .expect(200)
      ).body as Envelope<Record<string, unknown>>;

      expect(publicView.data.title).toBe("Ananya's Birthday");
      expect(publicView.data.wishCount).toBe(1);
      expect(JSON.stringify(publicView.data)).not.toContain('A secret message');
      expect(publicView.data.wishes).toBeUndefined();
    });
  });

  describe('unlocking', () => {
    it('reaches the recipient only once it opens', async () => {
      const { host, recipient } = await hostAndRecipient();
      const memory = await createMemory(host, {}, recipient);

      const forMe = () =>
        request(app.getHttpServer())
          .get(`${V1}/memories/for-me`)
          .set(auth(recipient.token))
          .expect(200);

      // Sealed: absent. Listing it early would tell the recipient both that a
      // memory about them exists and who is building it — the two things the
      // time-lock is there to keep.
      expect((await forMe()).body.data).toHaveLength(0);

      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(200);

      const mine = (await forMe()).body as Envelope<MemoryView[]>;
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0].id).toBe(memory.id);
      // Theirs to read, not to run: they did not make it.
      expect(mine.data[0].isHost).toBe(false);
    });

    it('a memory about someone else never appears in your For You', async () => {
      const { host, recipient } = await hostAndRecipient();
      const bystander = await newUser();
      const memory = await createMemory(host, {}, recipient);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(200);

      for (const actor of [bystander, host]) {
        const res = await request(app.getHttpServer())
          .get(`${V1}/memories/for-me`)
          .set(auth(actor.token))
          .expect(200);
        // The host's own capsule belongs in "Created by you", not here.
        expect((res.body as Envelope<MemoryView[]>).data).toHaveLength(0);
      }
    });

    it('opens on the host’s say-so and hands over every wish', async () => {
      const host = await newUser();
      const friend = await newUser();
      const memory = await createMemory(host);

      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'text', text: 'Happy Birthday!' })
        .expect(201);

      const opened = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/${memory.id}/unlock`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<MemoryView>;

      expect(opened.data.status).toBe('unlocked');
      expect(opened.data.wishes).toHaveLength(1);
      expect(opened.data.wishes[0].text).toBe('Happy Birthday!');

      const list = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/${memory.id}/wishes`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<{ text: string | null }[]>;
      expect(list.data).toHaveLength(1);
    });

    it('the scheduled job opens it, and is a no-op once the date has moved', async () => {
      const host = await newUser();
      const memory = await createMemory(host);
      const before = await capsuleModel.findById(memory.id).exec();
      const originalIso = before!.unlockAt.toISOString();

      // The host pushes the date back; the queued job still carries the old one.
      const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await request(app.getHttpServer())
        .patch(`${V1}/memories/${memory.id}`)
        .set(auth(host.token))
        .send({ unlockAt: later })
        .expect(200);

      const stale = await memories.fireUnlock({
        capsuleId: memory.id,
        unlockAtIso: originalIso,
      });
      expect(stale.unlocked).toBe(false);
      expect((await capsuleModel.findById(memory.id).exec())!.status).toBe('collecting');

      // The rescheduled job carries the new instant and does open it.
      const fresh = await memories.fireUnlock({ capsuleId: memory.id, unlockAtIso: later });
      expect(fresh.unlocked).toBe(true);
      expect((await capsuleModel.findById(memory.id).exec())!.status).toBe('unlocked');
    });

    it('refuses to open twice, and refuses edits once open', async () => {
      const host = await newUser();
      const memory = await createMemory(host);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(200);

      const again = await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(409);
      expect((again.body as Envelope<unknown>).error?.code).toBe(
        ErrorCode.INVALID_MEMORY_TRANSITION,
      );

      await request(app.getHttpServer())
        .patch(`${V1}/memories/${memory.id}`)
        .set(auth(host.token))
        .send({ title: 'Renamed' })
        .expect(409);
    });

    it('stops accepting wishes once it is open', async () => {
      const host = await newUser();
      const friend = await newUser();
      const memory = await createMemory(host);
      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'text', text: 'Too late' })
        .expect(409);
      expect((res.body as Envelope<unknown>).error?.code).toBe(
        ErrorCode.MEMORY_NOT_ACCEPTING_WISHES,
      );
    });
  });

  describe('wishes', () => {
    it('requires text for a text wish and a file for a photo wish', async () => {
      const host = await newUser();
      const memory = await createMemory(host);

      const noText = await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(host.token))
        .send({ kind: 'text' })
        .expect(400);
      expect((noText.body as Envelope<unknown>).error?.code).toBe(
        ErrorCode.MEMORY_WISH_TEXT_REQUIRED,
      );

      const noFile = await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(host.token))
        .send({ kind: 'photo', text: 'Look at this' })
        .expect(400);
      expect((noFile.body as Envelope<unknown>).error?.code).toBe(
        ErrorCode.MEMORY_WISH_MEDIA_REQUIRED,
      );
    });

    it('refuses an image passed off as a video wish', async () => {
      // One purpose covers photo, audio and video, so the declared kind is the
      // only thing that says which the contributor meant.
      const host = await newUser();
      const memory = await createMemory(host);
      const imageId = await uploadMedia(host, MediaPurpose.MEMORY_WISH);

      const res = await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(host.token))
        .send({ kind: 'video', mediaId: imageId })
        .expect(400);
      expect((res.body as Envelope<unknown>).error?.code).toBe(ErrorCode.MEDIA_TYPE_NOT_ALLOWED);
    });

    it('carries a photo wish end to end', async () => {
      const host = await newUser();
      const friend = await newUser();
      const memory = await createMemory(host);
      const photoId = await uploadMedia(friend, MediaPurpose.MEMORY_WISH);

      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'photo', mediaId: photoId, text: 'Happy Birthday!' })
        .expect(201);

      const opened = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/${memory.id}/unlock`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<MemoryView>;

      expect(opened.data.wishes[0].kind).toBe('photo');
      expect(opened.data.wishes[0].mediaUrl).toEqual(expect.any(String));
    });

    it('lets a contributor withdraw their own wish but not someone else’s', async () => {
      const host = await newUser();
      const priya = await newUser();
      const ganesh = await newUser();
      const memory = await createMemory(host);

      const mine = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/${memory.id}/wishes`)
          .set(auth(priya.token))
          .send({ kind: 'text', text: 'From Priya' })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      await request(app.getHttpServer())
        .delete(`${V1}/memories/${memory.id}/wishes/${mine.data.id}`)
        .set(auth(ganesh.token))
        .expect(404);

      await request(app.getHttpServer())
        .delete(`${V1}/memories/${memory.id}/wishes/${mine.data.id}`)
        .set(auth(priya.token))
        .expect(204);

      const after = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/${memory.id}`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<MemoryView>;
      expect(after.data.wishCount).toBe(0);
    });

    it('counts a reaction, and refuses one while the capsule is sealed', async () => {
      const host = await newUser();
      const memory = await createMemory(host);
      const wish = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/${memory.id}/wishes`)
          .set(auth(host.token))
          .send({ kind: 'text', text: 'Happy Birthday!' })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes/${wish.data.id}/react`)
        .set(auth(host.token))
        .expect(409);

      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/unlock`)
        .set(auth(host.token))
        .expect(200);

      const reacted = (
        await request(app.getHttpServer())
          .post(`${V1}/memories/${memory.id}/wishes/${wish.data.id}/react`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<{ reactionCount: number }>;
      expect(reacted.data.reactionCount).toBe(1);
    });
  });

  describe('the two lists on the Memories tab (4104:1433)', () => {
    it('separates what you created from what you contributed to', async () => {
      const host = await newUser();
      const friend = await newUser();
      const memory = await createMemory(host);

      await request(app.getHttpServer())
        .post(`${V1}/memories/${memory.id}/wishes`)
        .set(auth(friend.token))
        .send({ kind: 'text', text: 'Happy Birthday!' })
        .expect(201);

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/mine`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<MemoryView[]>;
      expect(mine.data.map((m) => m.id)).toContain(memory.id);

      const contributed = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/contributed`)
          .set(auth(friend.token))
          .expect(200)
      ).body as Envelope<MemoryView[]>;
      expect(contributed.data.map((m) => m.id)).toContain(memory.id);

      // A host who also wrote a wish is not listed twice — "contributed" means
      // someone else's memory.
      const hostContributed = (
        await request(app.getHttpServer())
          .get(`${V1}/memories/contributed`)
          .set(auth(host.token))
          .expect(200)
      ).body as Envelope<MemoryView[]>;
      expect(hostContributed.data.map((m) => m.id)).not.toContain(memory.id);
    });
  });
});
