import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { DeviceTokenService } from 'src/modules/notifications/device-token.service';
import {
  DeviceToken,
  type DeviceTokenDocument,
} from 'src/modules/notifications/schemas/device-token.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface Actor {
  token: string;
  userId: string;
}

describe('Device tokens (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let tokenModel: Model<DeviceTokenDocument>;
  let devices: DeviceTokenService;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const newUser = async (): Promise<Actor> => {
    const email = `dev${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'Rohan Iyer' })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    return { token: body.data.tokens.accessToken, userId: body.data.user.id };
  };

  // Registering answers 200, not 201: it upserts on the token, so a repeat
  // registration creates nothing.
  const register = (actor: Actor, pushToken: string, over: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(`${V1}/me/devices`)
      .set(auth(actor.token))
      .send({ token: pushToken, platform: 'android', deviceName: 'Pixel 8', ...over });

  /** A gifter reserves, buys and fulfils an item on the owner's wishlist. */
  const fulfilGiftFor = async (owner: Actor, gifter: Actor): Promise<void> => {
    const wl = (
      await request(app.getHttpServer())
        .post(`${V1}/wishlists`)
        .set(auth(owner.token))
        .send({ title: 'Gift me', visibility: 'public' })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const item = (
      await request(app.getHttpServer())
        .post(`${V1}/wishlists/${wl.data.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Headphones', price: { amountMinor: 249900 } })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const gift = (
      await request(app.getHttpServer())
        .post(`${V1}/items/${item.data.id}/reserve`)
        .set(auth(gifter.token))
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(201)
    ).body as Envelope<{ id: string }>;

    for (const step of ['purchase', 'fulfill']) {
      await request(app.getHttpServer())
        .post(`${V1}/gifts/${gift.data.id}/${step}`)
        .set(auth(gifter.token))
        .send({})
        .expect(200);
    }
  };

  /** Let the fire-and-forget listener enqueue, then run the queued jobs. */
  const settle = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 150));
    await ctx.drainNotifications();
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    tokenModel = app.get<Model<DeviceTokenDocument>>(getModelToken(DeviceToken.name));
    devices = app.get(DeviceTokenService);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.push.reset();
  });

  it('registers a device and lists it as a live target', async () => {
    const user = await newUser();
    const res = await register(user, 'fcm-token-a').expect(200);

    expect((res.body as Envelope<{ id: string }>).data.id).toBeTruthy();
    expect(await devices.liveTokensFor(user.userId)).toEqual(['fcm-token-a']);
  });

  it('re-registering the same token updates the row rather than adding one', async () => {
    const user = await newUser();
    await register(user, 'fcm-token-a').expect(200);
    await register(user, 'fcm-token-a', { deviceName: 'Pixel 9' }).expect(200);

    expect(await tokenModel.countDocuments({ token: 'fcm-token-a' })).toBe(1);
    const row = await tokenModel.findOne({ token: 'fcm-token-a' }).exec();
    expect(row?.deviceName).toBe('Pixel 9');
  });

  /**
   * The reason the unique index is on `token` alone. A handset handed to a
   * second account keeps the same FCM token; a second row for it would deliver
   * the first person's notifications to the second person's lock screen.
   */
  it('re-points a handset to its new owner instead of keeping two rows', async () => {
    const first = await newUser();
    const second = await newUser();
    await register(first, 'shared-handset').expect(200);
    await register(second, 'shared-handset').expect(200);

    expect(await tokenModel.countDocuments({ token: 'shared-handset' })).toBe(1);
    expect(await devices.liveTokensFor(first.userId)).toEqual([]);
    expect(await devices.liveTokensFor(second.userId)).toEqual(['shared-handset']);
  });

  it('unregisters only the caller’s own token', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    await register(owner, 'fcm-token-a').expect(200);

    // A stranger naming someone else's token must not be able to silence them.
    await request(app.getHttpServer())
      .delete(`${V1}/me/devices/fcm-token-a`)
      .set(auth(stranger.token))
      .expect(204);
    expect(await devices.liveTokensFor(owner.userId)).toEqual(['fcm-token-a']);

    await request(app.getHttpServer())
      .delete(`${V1}/me/devices/fcm-token-a`)
      .set(auth(owner.token))
      .expect(204);
    expect(await devices.liveTokensFor(owner.userId)).toEqual([]);
  });

  it('revives a token that comes back after a revoke', async () => {
    const user = await newUser();
    await register(user, 'fcm-token-a').expect(200);
    await devices.revoke(['fcm-token-a']);
    expect(await devices.liveTokensFor(user.userId)).toEqual([]);

    await register(user, 'fcm-token-a').expect(200);
    expect(await devices.liveTokensFor(user.userId)).toEqual(['fcm-token-a']);
  });

  it('drops the oldest device beyond the per-user cap', async () => {
    const user = await newUser();
    for (let i = 0; i < 12; i++) {
      await register(user, `fcm-token-${i}`).expect(200);
    }
    expect(await tokenModel.countDocuments({ userId: user.userId })).toBe(10);
    // The two oldest went; the newest survived.
    const live = await devices.liveTokensFor(user.userId);
    expect(live).toContain('fcm-token-11');
    expect(live).not.toContain('fcm-token-0');
  });

  it('rejects an unknown platform and requires a token', async () => {
    const user = await newUser();
    await register(user, 'fcm-token-a', { platform: 'blackberry' }).expect(400);
    await request(app.getHttpServer())
      .post(`${V1}/me/devices`)
      .set(auth(user.token))
      .send({ platform: 'android' })
      .expect(400);
    await request(app.getHttpServer()).post(`${V1}/me/devices`).send({}).expect(401);
  });

  /**
   * The whole point of the registry: a fulfilled gift must reach every live
   * device, and only live ones.
   */
  it('pushes a fulfilled gift to the recipient’s registered devices', async () => {
    const owner = await newUser();
    const gifter = await newUser();
    await register(owner, 'phone-a').expect(200);
    await register(owner, 'phone-b').expect(200);

    await fulfilGiftFor(owner, gifter);
    await settle();

    expect(ctx.push.tokens.sort()).toEqual(['phone-a', 'phone-b']);
    expect(ctx.push.last?.title).toBeTruthy();
  });

  /**
   * A token the provider rejects is dead for good. Revoking it is what stops
   * us paying for the same failed delivery on every future notification.
   */
  it('revokes a token the provider reports as unregistered', async () => {
    const owner = await newUser();
    const gifter = await newUser();
    await register(owner, 'live-token').expect(200);
    await register(owner, 'dead-token').expect(200);
    ctx.push.unregistered.add('dead-token');

    await fulfilGiftFor(owner, gifter);
    await settle();

    expect(await devices.liveTokensFor(owner.userId)).toEqual(['live-token']);
    // Revoked, not deleted — a client that has not noticed would re-create it.
    expect(await tokenModel.countDocuments({ token: 'dead-token' })).toBe(1);
  });

  it('sends no push to someone who has turned the category off', async () => {
    const owner = await newUser();
    const gifter = await newUser();
    await register(owner, 'phone-a').expect(200);
    await request(app.getHttpServer())
      .patch(`${V1}/notifications/preferences`)
      .set(auth(owner.token))
      .send({ disabled: ['gifts:push'] })
      .expect(200);

    await fulfilGiftFor(owner, gifter);
    await settle();

    expect(ctx.push.tokens).toEqual([]);
  });

  it('sends no push to someone with no device registered', async () => {
    const owner = await newUser();
    const gifter = await newUser();

    await fulfilGiftFor(owner, gifter);
    await settle();

    expect(ctx.push.sent).toEqual([]);
  });

  /**
   * The console adapter is the default because this project has no Firebase
   * credentials. It must be a working no-op, not a throw: a missing push
   * driver may not break the notification pipeline for every other channel.
   */
  it('accepts "push" as a disable-able channel in the preference pairs', async () => {
    const user = await newUser();
    const res = await request(app.getHttpServer())
      .patch(`${V1}/notifications/preferences`)
      .set(auth(user.token))
      .send({ disabled: ['gifts:push'] })
      .expect(200);

    expect((res.body as Envelope<{ disabled: string[] }>).data.disabled).toContain('gifts:push');
  });
});
