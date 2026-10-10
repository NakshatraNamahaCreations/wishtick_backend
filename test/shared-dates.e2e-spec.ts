import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { CelebrationRemindersService } from 'src/modules/profile/celebration-reminders.service';
import {
  WishLink,
  WishLinkStatus,
  type WishLinkDocument,
} from 'src/modules/wishmates/schemas/wish-link.schema';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  data: T;
  error?: { code: string };
}
interface Actor {
  token: string;
  userId: string;
}
interface SharedDate {
  id: string;
  personName: string;
  relation: string;
  occasionLabel: string;
  daysAway: number;
  reminding: boolean;
}
interface NotificationRow {
  type: string;
  title: string;
  body: string;
  refId: string;
}

const PASSWORD = 'correct-horse-battery-staple';

/**
 * Sharing a saved date with your WishMates, and their "Remind me" — a week
 * before, three days before and on the day, every year.
 */
describe('Shared important dates (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let reminders: CelebrationRemindersService;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const newUser = async (name: string): Promise<Actor> => {
    const email = `share${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    const actor = { token: body.data.tokens.accessToken, userId: body.data.user.id };
    await request(app.getHttpServer())
      .patch(`${V1}/me`)
      .set(auth(actor.token))
      .send({ timezone: 'Asia/Kolkata', displayName: name })
      .expect(200);
    return actor;
  };

  /** Accepted in the database: asking is not what these tests are about. */
  const makeWishmates = async (a: Actor, b: Actor): Promise<void> => {
    await app.get<Model<WishLinkDocument>>(getModelToken(WishLink.name)).create({
      requesterId: new Types.ObjectId(a.userId),
      addresseeId: new Types.ObjectId(b.userId),
      status: WishLinkStatus.ACCEPTED,
      respondedAt: new Date(),
    });
  };

  const saveDate = async (owner: Actor, over: Record<string, unknown> = {}): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`${V1}/me/important-dates`)
      .set(auth(owner.token))
      .send({
        personName: 'Ananya',
        relation: 'Mother',
        occasionKey: 'birthday',
        date: '1970-07-17',
        ...over,
      })
      .expect(201);
    return (res.body as Envelope<{ id: string }>).data.id;
  };

  const sharedOf = (viewer: Actor, owner: Actor) =>
    request(app.getHttpServer())
      .get(`${V1}/people/${owner.userId}/important-dates`)
      .set(auth(viewer.token));

  const remind = (viewer: Actor, owner: Actor, dateId: string) =>
    request(app.getHttpServer())
      .put(`${V1}/people/${owner.userId}/important-dates/${dateId}/remind`)
      .set(auth(viewer.token));

  const stop = (viewer: Actor, owner: Actor, dateId: string) =>
    request(app.getHttpServer())
      .delete(`${V1}/people/${owner.userId}/important-dates/${dateId}/remind`)
      .set(auth(viewer.token));

  const inbox = async (actor: Actor): Promise<NotificationRow[]> => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/notifications`)
      .set(auth(actor.token))
      .expect(200);
    return (res.body as Envelope<NotificationRow[]>).data.filter(
      (row) => row.type === 'celebration_reminder',
    );
  };

  /** 09:30 in Kolkata on [iso], and everything the scan set off. */
  const tick = async (iso: string): Promise<void> => {
    await reminders.scan(new Date(`${iso}T04:00:00.000Z`));
    await delay(150);
    await ctx.drainNotifications();
  };

  /** Suma with a shared date, and Ravi her WishMate. */
  const sumaAndRavi = async (visibility = 'wishmates') => {
    const suma = await newUser('Suma');
    const ravi = await newUser('Ravi');
    await makeWishmates(suma, ravi);
    const dateId = await saveDate(suma, { visibility });
    return { suma, ravi, dateId };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    reminders = app.get(CelebrationRemindersService);
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  describe('sharing', () => {
    it('is off unless asked for, and the owner can turn it on and off', async () => {
      const suma = await newUser('Suma');
      const id = await saveDate(suma);

      const mine = (
        await request(app.getHttpServer())
          .get(`${V1}/me/important-dates`)
          .set(auth(suma.token))
          .expect(200)
      ).body as Envelope<{ id: string; visibility: string }[]>;
      expect(mine.data.find((d) => d.id === id)?.visibility).toBe('private');

      const patched = (
        await request(app.getHttpServer())
          .patch(`${V1}/me/important-dates/${id}`)
          .set(auth(suma.token))
          .send({ visibility: 'wishmates' })
          .expect(200)
      ).body as Envelope<{ visibility: string }>;
      expect(patched.data.visibility).toBe('wishmates');
    });

    it('refuses anything but the two settings', async () => {
      const suma = await newUser('Suma');
      await request(app.getHttpServer())
        .post(`${V1}/me/important-dates`)
        .set(auth(suma.token))
        .send({
          personName: 'Ananya',
          occasionKey: 'birthday',
          date: '1970-07-17',
          visibility: 'everyone',
        })
        .expect(400);
    });
  });

  describe("a WishMate's view", () => {
    it('lists shared dates, and not private ones', async () => {
      const { suma, ravi } = await sumaAndRavi();
      await saveDate(suma, { personName: 'Kept to herself' });

      const res = (await sharedOf(ravi, suma).expect(200)).body as Envelope<SharedDate[]>;

      expect(res.data.map((d) => d.personName)).toEqual(['Ananya']);
      expect(res.data[0]).toMatchObject({
        relation: 'Mother',
        occasionLabel: 'Birthday',
        reminding: false,
      });
    });

    it('is refused to someone who is not a WishMate', async () => {
      const { suma } = await sumaAndRavi();
      const stranger = await newUser('Stranger');

      const res = await sharedOf(stranger, suma).expect(403);
      expect((res.body as Envelope<never>).error?.code).toBe('NOT_WISHMATES');
    });
  });

  describe('Remind me', () => {
    it('is remembered, shows as on, and can be turned off again', async () => {
      const { suma, ravi, dateId } = await sumaAndRavi();

      await remind(ravi, suma, dateId).expect(204);
      // Twice is still one.
      await remind(ravi, suma, dateId).expect(204);
      let res = (await sharedOf(ravi, suma).expect(200)).body as Envelope<SharedDate[]>;
      expect(res.data[0].reminding).toBe(true);

      await stop(ravi, suma, dateId).expect(204);
      res = (await sharedOf(ravi, suma).expect(200)).body as Envelope<SharedDate[]>;
      expect(res.data[0].reminding).toBe(false);
    });

    it('cannot be set on a date that is not shared', async () => {
      const { suma, ravi, dateId } = await sumaAndRavi('private');

      await remind(ravi, suma, dateId).expect(404);
    });

    it('reminds a week before, three days before and on the day — naming whose it is', async () => {
      const { suma, ravi, dateId } = await sumaAndRavi();
      await remind(ravi, suma, dateId).expect(204);

      await tick('2026-07-10');
      await tick('2026-07-14');
      await tick('2026-07-16'); // the day before: the owner's, not the follower's
      await tick('2026-07-17');

      const rows = await inbox(ravi);
      // Born 1970, so the age is the headline — as on the owner's own.
      expect(rows.map((r) => r.title).sort()).toEqual([
        'Ananya turns 56 in 3 days',
        'Ananya turns 56 in a week',
        'Ananya turns 56 today',
      ]);
      expect(rows[0].body).toContain("Suma's Mother");
    });

    it('comes round again the next year', async () => {
      const { suma, ravi, dateId } = await sumaAndRavi();
      await remind(ravi, suma, dateId).expect(204);

      await tick('2026-07-14');
      await tick('2027-07-14');

      expect(await inbox(ravi)).toHaveLength(2);
    });

    it('stops when the owner takes the date back', async () => {
      const { suma, ravi, dateId } = await sumaAndRavi();
      await remind(ravi, suma, dateId).expect(204);

      await request(app.getHttpServer())
        .patch(`${V1}/me/important-dates/${dateId}`)
        .set(auth(suma.token))
        .send({ visibility: 'private' })
        .expect(200);
      await tick('2026-07-14');

      expect(await inbox(ravi)).toHaveLength(0);
      // And it is gone, not merely silent: sharing it again does not restore it.
      await request(app.getHttpServer())
        .patch(`${V1}/me/important-dates/${dateId}`)
        .set(auth(suma.token))
        .send({ visibility: 'wishmates' })
        .expect(200);
      const res = (await sharedOf(ravi, suma).expect(200)).body as Envelope<SharedDate[]>;
      expect(res.data[0].reminding).toBe(false);
    });

    it('stops when the date is deleted', async () => {
      const { suma, ravi, dateId } = await sumaAndRavi();
      await remind(ravi, suma, dateId).expect(204);

      await request(app.getHttpServer())
        .delete(`${V1}/me/important-dates/${dateId}`)
        .set(auth(suma.token))
        .expect(204);
      await tick('2026-07-14');

      expect(await inbox(ravi)).toHaveLength(0);
    });

    it('stops when they are no longer WishMates', async () => {
      const { suma, ravi, dateId } = await sumaAndRavi();
      await remind(ravi, suma, dateId).expect(204);

      await request(app.getHttpServer())
        .delete(`${V1}/wishmates/${suma.userId}`)
        .set(auth(ravi.token))
        .expect(204);
      await tick('2026-07-14');

      expect(await inbox(ravi)).toHaveLength(0);
    });
  });
});
