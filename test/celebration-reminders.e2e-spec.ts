import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { CelebrationRemindersService } from 'src/modules/profile/celebration-reminders.service';
import { createTestApp, V1, type TestApp } from './utils/test-app';

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  refId: string;
  payload: Record<string, unknown>;
}

interface Actor {
  token: string;
  userId: string;
}

const PASSWORD = 'correct-horse-battery-staple';

/**
 * "Never Miss a Celebration" — the onboarding step's promise, kept.
 *
 * The dates were stored from the first sprint and nothing ever read them for a
 * reminder; these are the tests that say one arrives, once, in the morning, and
 * only for the person whose date it is.
 */
describe('Celebration reminders (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let reminders: CelebrationRemindersService;
  let seq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  /** Let the fire-and-forget listener enqueue, then run the queued jobs. */
  const settle = async (): Promise<void> => {
    await delay(150);
    await ctx.drainNotifications();
  };

  /** Somebody who lives in a known timezone — the scan starts from the clock. */
  const newUser = async (timezone = 'Asia/Kolkata'): Promise<Actor> => {
    const email = `cel${++seq}.${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post(`${V1}/auth/signup`)
      .send({ email, password: PASSWORD, name: 'Rohan Iyer' })
      .expect(201);
    const body = res.body as Envelope<{ user: { id: string }; tokens: { accessToken: string } }>;
    const actor = { token: body.data.tokens.accessToken, userId: body.data.user.id };

    await request(app.getHttpServer())
      .patch(`${V1}/me`)
      .set(auth(actor.token))
      .send({ timezone })
      .expect(200);
    return actor;
  };

  const saveDate = (actor: Actor, over: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(`${V1}/me/important-dates`)
      .set(auth(actor.token))
      .send({
        personName: 'Siya',
        relation: 'Best Friend',
        occasionKey: 'birthday',
        date: '1999-07-17',
        ...over,
      });

  const registerDevice = (actor: Actor, token: string) =>
    request(app.getHttpServer())
      .post(`${V1}/me/devices`)
      .set(auth(actor.token))
      .send({ token, platform: 'android', deviceName: 'Pixel 8' });

  /**
   * The celebration reminders in somebody's notification centre.
   *
   * Filtered by type: signing up posts a welcome notification, and every
   * assertion here is about how many reminders arrived, not how many rows.
   */
  const inbox = async (actor: Actor): Promise<NotificationRow[]> => {
    const res = await request(app.getHttpServer())
      .get(`${V1}/notifications`)
      .set(auth(actor.token))
      .expect(200);
    return (res.body as Envelope<NotificationRow[]>).data.filter(
      (row) => row.type === 'celebration_reminder',
    );
  };

  /** 09:30 in Kolkata on the given day. */
  const kolkataMorning = (iso: string): Date => new Date(`${iso}T04:00:00.000Z`);

  /** One tick of the scan, and everything it set off. */
  const tick = async (at: Date): Promise<void> => {
    await reminders.scan(at);
    await settle();
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
    // `reset` does not touch the push fake — it records across tests unless
    // told otherwise, and every assertion here is about what reached a phone.
    ctx.push.reset();
  });

  it('tells you a week before, in your own morning', async () => {
    const user = await newUser();
    await saveDate(user).expect(201);
    await registerDevice(user, 'phone-a').expect(200);

    await tick(kolkataMorning('2026-07-10'));

    const rows = await inbox(user);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('celebration_reminder');
    expect(rows[0].title).toBe('Siya turns 27 in a week');
    expect(ctx.push.tokens).toEqual(['phone-a']);
  });

  it('tells you again the day before, and on the morning itself', async () => {
    const user = await newUser();
    await saveDate(user).expect(201);

    await tick(kolkataMorning('2026-07-16'));
    await tick(kolkataMorning('2026-07-17'));

    const titles = (await inbox(user)).map((r) => r.title);
    expect(titles).toContain('Siya turns 27 tomorrow');
    expect(titles).toContain('Siya turns 27 today');
  });

  // The scan runs every hour and covers two of them, so the same reminder is
  // reached more than once by design. Permanent dedupe is what makes that safe.
  it('says it once however many times the scan runs', async () => {
    const user = await newUser();
    await saveDate(user).expect(201);
    await registerDevice(user, 'phone-a').expect(200);

    await tick(kolkataMorning('2026-07-10'));
    await tick(new Date('2026-07-10T05:00:00.000Z'));

    expect(await inbox(user)).toHaveLength(1);
    expect(ctx.push.tokens).toEqual(['phone-a']);
  });

  // The whole point of storing the year: the same date has to come round.
  it('says it again next year', async () => {
    const user = await newUser();
    await saveDate(user).expect(201);

    await tick(kolkataMorning('2026-07-17'));
    await tick(kolkataMorning('2027-07-17'));

    const titles = (await inbox(user)).map((r) => r.title);
    expect(titles).toContain('Siya turns 27 today');
    expect(titles).toContain('Siya turns 28 today');
  });

  // Correcting a date must not be swallowed as a repeat of the reminder
  // already sent for the day it used to be.
  it('follows a date that is corrected after the first reminder', async () => {
    const user = await newUser();
    const saved = (await saveDate(user).expect(201)).body as Envelope<{ id: string }>;

    await tick(kolkataMorning('2026-07-10'));
    await request(app.getHttpServer())
      .patch(`${V1}/me/important-dates/${saved.data.id}`)
      .set(auth(user.token))
      .send({ date: '1999-07-20' })
      .expect(200);
    await tick(kolkataMorning('2026-07-13'));

    expect(await inbox(user)).toHaveLength(2);
  });

  it('says nothing about a date that has been deleted', async () => {
    const user = await newUser();
    const saved = (await saveDate(user).expect(201)).body as Envelope<{ id: string }>;
    await request(app.getHttpServer())
      .delete(`${V1}/me/important-dates/${saved.data.id}`)
      .set(auth(user.token))
      .expect(204);

    await tick(kolkataMorning('2026-07-10'));

    expect(await inbox(user)).toEqual([]);
  });

  // 04:00 UTC is the middle of the night in London. Nobody is woken up.
  it('waits for the morning where the person actually is', async () => {
    const user = await newUser('Europe/London');
    await saveDate(user).expect(201);

    await tick(kolkataMorning('2026-07-10'));
    expect(await inbox(user)).toEqual([]);

    // 09:30 London.
    await tick(new Date('2026-07-10T08:30:00.000Z'));
    expect(await inbox(user)).toHaveLength(1);
  });

  /**
   * The in-app row lands whatever the preferences say — it is a list you chose
   * to open, not an interruption — so switching Events off silences the phone
   * and nothing else.
   */
  it('silences the phone, not the list, when Events are switched off', async () => {
    const user = await newUser();
    await saveDate(user).expect(201);
    await registerDevice(user, 'phone-a').expect(200);
    await request(app.getHttpServer())
      .patch(`${V1}/notifications/preferences`)
      .set(auth(user.token))
      .send({ disabled: ['events:push'] })
      .expect(200);

    await tick(kolkataMorning('2026-07-10'));

    expect(ctx.push.tokens).toEqual([]);
    expect(await inbox(user)).toHaveLength(1);
  });

  /**
   * In-app and push, and nothing else.
   *
   * A yearly "it's her birthday next week" by email reads as marketing however
   * carefully it is worded, and by SMS it costs money to say something the
   * phone says for nothing.
   */
  it('does not email or text a birthday reminder', async () => {
    const user = await newUser();
    await saveDate(user).expect(201);

    await tick(kolkataMorning('2026-07-10'));

    expect(ctx.mailer.sent.filter((m) => m.subject.includes('Siya'))).toEqual([]);
    expect(ctx.sms.sent.filter((m) => m.body.includes('Siya'))).toEqual([]);
  });

  it('tells nobody else about your dates', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    await saveDate(owner).expect(201);

    await tick(kolkataMorning('2026-07-10'));

    expect(await inbox(stranger)).toEqual([]);
  });

  // It carries what the app needs to show and where to go, and the date's own
  // id — the refId is an occurrence, not something to navigate by.
  it('carries the date it is about', async () => {
    const user = await newUser();
    const saved = (await saveDate(user).expect(201)).body as Envelope<{ id: string }>;

    await tick(kolkataMorning('2026-07-10'));

    const [row] = await inbox(user);
    expect(row.payload).toMatchObject({
      importantDateId: saved.data.id,
      personName: 'Siya',
      relation: 'Best Friend',
      occasionLabel: 'Birthday',
      whenText: 'in a week',
      daysAway: 7,
      turningAge: 27,
    });
    expect(row.refId).toBe(`${saved.data.id}:2026:717:d-7`);
  });
});
