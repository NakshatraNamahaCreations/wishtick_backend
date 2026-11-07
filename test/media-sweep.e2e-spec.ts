import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Media, MediaStatus, type MediaDocument } from 'src/modules/media/schemas/media.schema';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { MediaService } from 'src/modules/media/media.service';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface UploadTicket {
  mediaId: string;
  uploadUrl: string;
  storageKey: string;
}

/** A tiny but genuinely valid PNG, so content-type checks see real bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('Media sweep (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let mediaModel: Model<MediaDocument>;
  let mediaService: MediaService;
  let seq = 0;

  const uniqueEmail = (): string => `sweep${++seq}.${Date.now()}@example.com`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const pathOf = (url: string): string => new URL(url).pathname + new URL(url).search;

  const newUser = async (): Promise<{ token: string }> => {
    const email = uniqueEmail();
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD })
      .expect(201);
    const body = res.body as Envelope<{ tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken };
  };

  /** Presigns, PUTs real bytes, and confirms — a real READY profile photo. */
  const uploadReady = async (
    token: string,
    purpose: MediaPurpose = MediaPurpose.PROFILE_PHOTO,
  ): Promise<UploadTicket> => {
    const ticket = (
      await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(token))
        .send({ purpose, contentType: 'image/png' })
        .expect(201)
    ).body as Envelope<UploadTicket>;

    await request(app.getHttpServer())
      .put(pathOf(ticket.data.uploadUrl))
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES)
      .expect(200);

    await request(app.getHttpServer())
      .post(`${V1}/media/confirm`)
      .set(auth(token))
      .send({ mediaId: ticket.data.mediaId })
      .expect(201);

    return ticket.data;
  };

  /** Attaches a READY photo as the avatar, orphaning whatever was there before. */
  const attach = async (token: string, mediaId: string): Promise<void> => {
    await request(app.getHttpServer())
      .patch(`${V1}/me`)
      .set(auth(token))
      .send({ photoMediaId: mediaId })
      .expect(200);
  };

  const backdate = async (
    mediaId: string,
    field: 'createdAt' | 'updatedAt',
    hoursAgo: number,
  ): Promise<void> => {
    await mediaModel
      .updateOne(
        { _id: mediaId },
        { $set: { [field]: new Date(Date.now() - hoursAgo * 60 * 60 * 1_000) } },
        // createdAt/updatedAt are immutable by default under `timestamps: true` —
        // without this a $set on either is silently dropped.
        { overwriteImmutable: true, timestamps: false },
      )
      .exec();
  };

  const storageExists = async (storageKey: string): Promise<boolean> => {
    const res = await request(app.getHttpServer()).get(`${V1}/media/local/${storageKey}`);
    return res.status === 200;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    mediaModel = app.get<Model<MediaDocument>>(getModelToken(Media.name));
    mediaService = app.get(MediaService);
  }, 90_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it('reclaims an orphaned media past its grace period, object and all', async () => {
    const { token } = await newUser();
    const first = await uploadReady(token);
    await attach(token, first.mediaId);
    const second = await uploadReady(token);
    await attach(token, second.mediaId); // orphans `first`

    expect((await mediaModel.findById(first.mediaId).exec())!.status).toBe(MediaStatus.ORPHANED);
    // Default grace is 24h — push it well past that.
    await backdate(first.mediaId, 'updatedAt', 25);

    const result = await mediaService.sweep();
    expect(result.orphanedSwept).toBe(1);

    expect(await mediaModel.findById(first.mediaId).exec()).toBeNull();
    expect(await storageExists(first.storageKey)).toBe(false);
    // The replacement must survive its own sweeper run.
    expect(await mediaModel.findById(second.mediaId).exec()).not.toBeNull();
  });

  it('leaves an orphaned media alone while its grace period is still running', async () => {
    const { token } = await newUser();
    const first = await uploadReady(token);
    await attach(token, first.mediaId);
    const second = await uploadReady(token);
    await attach(token, second.mediaId); // orphans `first`

    // Well inside the 24h default — a screen may still be rendering the old URL.
    await backdate(first.mediaId, 'updatedAt', 1);

    const result = await mediaService.sweep();
    expect(result.orphanedSwept).toBe(0);

    const stillThere = await mediaModel.findById(first.mediaId).exec();
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe(MediaStatus.ORPHANED);
    expect(await storageExists(first.storageKey)).toBe(true);
  });

  it('reclaims a pending upload that was never confirmed, past its grace period', async () => {
    const { token } = await newUser();
    const ticket = (
      await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(token))
        .send({ purpose: MediaPurpose.PROFILE_PHOTO, contentType: 'image/png' })
        .expect(201)
    ).body as Envelope<UploadTicket>;
    // Bytes never arrive and confirm is never called.

    // Default grace is 48h — push it well past that.
    await backdate(ticket.data.mediaId, 'createdAt', 49);

    const result = await mediaService.sweep();
    expect(result.pendingSwept).toBe(1);
    expect(await mediaModel.findById(ticket.data.mediaId).exec()).toBeNull();
  });

  it('leaves a pending upload alone while a legitimate slow upload could still land', async () => {
    const { token } = await newUser();
    const ticket = (
      await request(app.getHttpServer())
        .post(`${V1}/media/upload-url`)
        .set(auth(token))
        .send({ purpose: MediaPurpose.PROFILE_PHOTO, contentType: 'image/png' })
        .expect(201)
    ).body as Envelope<UploadTicket>;

    const result = await mediaService.sweep();
    expect(result.pendingSwept).toBe(0);

    const stillThere = await mediaModel.findById(ticket.data.mediaId).exec();
    expect(stillThere).not.toBeNull();
    expect(stillThere!.status).toBe(MediaStatus.PENDING);
  });

  it('never touches a READY, attached media even when it is old', async () => {
    const { token } = await newUser();
    const photo = await uploadReady(token);
    await attach(token, photo.mediaId);
    await backdate(photo.mediaId, 'createdAt', 24 * 365);
    await backdate(photo.mediaId, 'updatedAt', 24 * 365);

    const result = await mediaService.sweep();
    expect(result).toEqual({ orphanedSwept: 0, pendingSwept: 0 });
    expect(await mediaModel.findById(photo.mediaId).exec()).not.toBeNull();
    expect(await storageExists(photo.storageKey)).toBe(true);
  });

  const statusOf = async (mediaId: string): Promise<MediaStatus | undefined> =>
    (await mediaModel.findById(mediaId).lean().exec())?.status;

  describe('what is deleted or replaced is handed to the sweep', () => {
    const newWishlist = async (token: string): Promise<string> =>
      (
        (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists`)
            .set(auth(token))
            .send({ title: 'Birthday' })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;

    const newItem = async (
      token: string,
      wishlistId: string,
      mediaIds: string[],
    ): Promise<string> =>
      (
        (
          await request(app.getHttpServer())
            .post(`${V1}/wishlists/${wishlistId}/items`)
            .set(auth(token))
            .send({ title: 'Frame', mediaIds })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;

    const setPhotos = async (
      token: string,
      wishlistId: string,
      itemId: string,
      mediaIds: string[],
    ): Promise<void> => {
      await request(app.getHttpServer())
        .patch(`${V1}/wishlists/${wishlistId}/items/${itemId}`)
        .set(auth(token))
        .send({ mediaIds })
        .expect(200);
    };

    it('deleting an event hands over its cover', async () => {
      const { token } = await newUser();
      const cover = await uploadReady(token, MediaPurpose.EVENT_COVER);
      const event = (
        (
          await request(app.getHttpServer())
            .post(`${V1}/events`)
            .set(auth(token))
            .send({
              title: 'Party',
              type: 'birthday',
              startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
              timezone: 'Asia/Kolkata',
              coverMediaId: cover.mediaId,
            })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data;

      await request(app.getHttpServer())
        .post(`${V1}/events/bulk-delete`)
        .set(auth(token))
        .send({ ids: [event.id] })
        .expect(200);

      expect(await statusOf(cover.mediaId)).toBe(MediaStatus.ORPHANED);
    });

    it('a photo taken off an item is handed over; the new one is not', async () => {
      const { token } = await newUser();
      const before = await uploadReady(token, MediaPurpose.WISHLIST_ITEM);
      const after = await uploadReady(token, MediaPurpose.WISHLIST_ITEM);
      const list = await newWishlist(token);
      const item = await newItem(token, list, [before.mediaId]);

      await setPhotos(token, list, item, [after.mediaId]);

      expect(await statusOf(before.mediaId)).toBe(MediaStatus.ORPHANED);
      expect(await statusOf(after.mediaId)).toBe(MediaStatus.READY);
    });

    it('a photo another item still shows is kept', async () => {
      const { token } = await newUser();
      const shared = await uploadReady(token, MediaPurpose.WISHLIST_ITEM);
      const list = await newWishlist(token);
      const first = await newItem(token, list, [shared.mediaId]);
      await newItem(token, list, [shared.mediaId]);

      await setPhotos(token, list, first, []);

      expect(await statusOf(shared.mediaId)).toBe(MediaStatus.READY);
    });
  });
});
