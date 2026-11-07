import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { io, type Socket } from 'socket.io-client';
import { AuthService } from 'src/modules/auth/auth.service';
import { AnalyticsService } from 'src/modules/analytics/analytics.service';
import {
  AnalyticsEvent,
  type AnalyticsEventDocument,
} from 'src/modules/analytics/schemas/analytics-event.schema';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { GroupGiftReconcileService } from 'src/modules/group-gifts/group-gift-reconcile.service';
import { NotificationRenderer } from 'src/modules/notifications/notification.renderer';
import { NotificationService } from 'src/modules/notifications/notification.service';
import {
  NotificationChannel,
  NotificationType,
} from 'src/modules/notifications/notification.types';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { BlogService } from 'src/modules/blog/blog.service';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';
const ADMIN_EMAIL = 'root@wishtick.test';
const ADMIN_PASSWORD = 'RootAdminPassw0rd!';
const DAY_MS = 24 * 60 * 60 * 1000;
const DUMMY_ID = '0'.repeat(24);

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

interface Actor {
  token: string;
  userId: string;
}

/** A route as discovered from the live Express router. */
interface DiscoveredRoute {
  method: string;
  /** Normalized to the `/admin...` suffix, so the api/v1 prefix is irrelevant. */
  suffix: string;
}

/** Walks the router stack and returns every mounted route. */
function discoverAdminRoutes(app: INestApplication): DiscoveredRoute[] {
  const instance = app.getHttpAdapter().getInstance() as {
    _router?: { stack: unknown[] };
    router?: { stack: unknown[] };
  };
  const router = instance._router ?? instance.router;
  const out: DiscoveredRoute[] = [];
  const walk = (stack: unknown[]): void => {
    for (const layer of stack as Array<{
      route?: { path: string; methods: Record<string, boolean> };
      name?: string;
      handle?: { stack?: unknown[] };
    }>) {
      if (layer.route && typeof layer.route.path === 'string') {
        const path = layer.route.path;
        const idx = path.indexOf('/admin');
        if (idx === -1) continue;
        // slice, NOT split('/admin') — "admins" also contains "admin", so a
        // split would collapse /admin/admins to a phantom /admin.
        const suffix = path.slice(idx);
        for (const [method, on] of Object.entries(layer.route.methods)) {
          const upper = method.toUpperCase();
          // Skip HEAD (auto-paired with GET) and OPTIONS — the real verbs suffice.
          if (on && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper)) {
            out.push({ method: upper, suffix });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  if (router) walk(router.stack);
  return out;
}

/** :param → a syntactically-valid ObjectId, so routing reaches the guard. */
const fillParams = (suffix: string): string => suffix.replace(/:[^/]+/g, DUMMY_ID);

describe('Admin panel, moderation & analytics (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let authService: AuthService;
  let analytics: AnalyticsService;
  let eventModel: Model<AnalyticsEventDocument>;
  let base: string;
  let seq = 0;
  const openSockets: Socket[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const server = (): Server => app.getHttpServer() as Server;

  const newUser = async (extra?: { source?: string; ref?: string }): Promise<Actor> => {
    const email = `admin-e2e-${++seq}.${Date.now()}@example.com`;
    const { user, tokens } = await authService.signup(
      { email, password: PASSWORD, name: `User ${seq}`, ...extra },
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );
    return { token: tokens.accessToken, userId: user.id };
  };

  const adminLogin = async (
    email = ADMIN_EMAIL,
    password = ADMIN_PASSWORD,
  ): Promise<Envelope<{ accessToken: string }>['data']> => {
    const res = await request(server())
      .post(`${V1}/admin/auth/login`)
      .send({ email, password })
      .expect(200);
    return (res.body as Envelope<{ accessToken: string }>).data;
  };

  /** A token that can use the panel: email and password are all it takes. */
  const signIn = async (email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> =>
    (await adminLogin(email, password)).accessToken;

  const adminToken = (): Promise<string> => signIn();

  const connect = (token: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(`${base}/chat`, {
        auth: { token },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      openSockets.push(socket);
      const timer = setTimeout(() => reject(new Error('connect timeout')), 4000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    authService = app.get(AuthService);
    analytics = app.get(AnalyticsService);
    eventModel = app.get<Model<AnalyticsEventDocument>>(getModelToken(AnalyticsEvent.name));
    await app.listen(0);
    const address = server().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterEach(() => {
    for (const s of openSockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // ── Exit criterion: a user JWT is rejected on EVERY /admin route ─────────────

  describe('admin route protection', () => {
    it('bootstraps a super-admin that can log in', async () => {
      const data = await adminLogin();
      expect(data.accessToken).toBeTruthy();
    });

    it('discovers a non-trivial set of guarded admin routes', () => {
      const routes = discoverAdminRoutes(app).filter(
        (r) => !(r.method === 'POST' && r.suffix === '/admin/auth/login'),
      );
      // If this ever drops to zero the generated test below would be vacuous.
      expect(routes.length).toBeGreaterThanOrEqual(10);
    });

    it('rejects a user JWT on every guarded admin route', async () => {
      const user = await newUser();
      const routes = discoverAdminRoutes(app).filter(
        (r) => !(r.method === 'POST' && r.suffix === '/admin/auth/login'),
      );

      const offenders: string[] = [];
      for (const route of routes) {
        const path = `${V1}${fillParams(route.suffix)}`;
        const req = request(server());
        const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
        const res = await req[method](path).set(auth(user.token)).send({});
        // The admin strategy rejects a user-audience token before any handler
        // runs — 401. Never a 2xx, and never a validation 400 (guard precedes pipes).
        if (res.status !== 401) offenders.push(`${route.method} ${route.suffix} → ${res.status}`);
      }
      expect(offenders).toEqual([]);
    });

    it('rejects a completely unauthenticated request too', async () => {
      await request(server()).get(`${V1}/admin/users`).expect(401);
    });

    // Authenticator sign-in was removed: a new admin's email and password are
    // the whole of it, with nothing to set up first.
    it('lets a new admin in with their password alone, as far as their role goes', async () => {
      const email = `pw-only-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: 'Support', roles: ['support'] })
        .expect(201);

      const token = await signIn(email, password);
      await request(server()).get(`${V1}/admin/users`).set(auth(token)).expect(200);
      // …and no further than the role allows.
      await request(server()).get(`${V1}/admin/admins`).set(auth(token)).expect(403);

      const me = (await request(server()).get(`${V1}/admin/auth/me`).set(auth(token)).expect(200))
        .body as Envelope<{ name: string; totpEnabled?: boolean }>;
      expect(me.data.name).toBe('Support');
      expect(me.data.totpEnabled).toBeUndefined();
    });

    it('has no authenticator setup routes any more', async () => {
      const token = await adminToken();
      await request(server()).post(`${V1}/admin/auth/totp/setup`).set(auth(token)).expect(404);
    });
  });

  // ── Webhooks that matched no gift ────────────────────────────────────────────

  describe('dashboard', () => {
    interface Dashboard {
      generatedAt: string;
      users?: { total: number; newToday: number };
      content?: { wishlists: number };
      money?: { giftsReserved: number };
      attention: { key: string; count: number }[];
      series: { signups?: { day: string; signups: number }[]; gifts?: unknown[] };
    }

    const dashboardAs = async (token: string): Promise<Dashboard> =>
      (
        (await request(server()).get(`${V1}/admin/dashboard`).set(auth(token)).expect(200))
          .body as Envelope<Dashboard>
      ).data;

    it('counts the platform live, and calls out an open report', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const reporter = await newUser();
      const wl = (
        await request(server())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: 'Dashboard list', visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await request(server())
        .post(`${V1}/reports`)
        .set(auth(reporter.token))
        .send({ targetType: 'wishlist', targetId: wl.data.id, reason: 'spam' })
        .expect(201);

      const data = await dashboardAs(token);

      // Today's signups are counted from the accounts, not the nightly rollup.
      expect(data.users!.newToday).toBeGreaterThanOrEqual(2);
      expect(data.content!.wishlists).toBeGreaterThanOrEqual(1);
      expect(data.money).toBeDefined();
      expect(data.attention.find((a) => a.key === 'reports-open')?.count).toBeGreaterThanOrEqual(1);

      // Thirty days, today last, zero-filled.
      expect(data.series.signups).toHaveLength(30);
      const today = new Date().toISOString().slice(0, 10);
      const last = data.series.signups!.at(-1)!;
      expect(last.day).toBe(today);
      expect(last.signups).toBeGreaterThanOrEqual(2);
    });

    // Sections an analyst may not see are left out, not sent and hidden.
    it('gives each admin only the sections their role covers', async () => {
      const owner = await newUser();
      const reporter = await newUser();
      const wl = (
        await request(server())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: 'Reported', visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      await request(server())
        .post(`${V1}/reports`)
        .set(auth(reporter.token))
        .send({ targetType: 'wishlist', targetId: wl.data.id, reason: 'spam' })
        .expect(201);

      const email = `dash-analyst-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: 'Analyst', roles: ['analyst'] })
        .expect(201);

      const data = await dashboardAs(await signIn(email, password));
      expect(data.users).toBeDefined();
      expect(data.money).toBeDefined();
      expect(data.content).toBeUndefined();
      // Moderation is not theirs.
      expect(data.attention.some((a) => a.key.startsWith('reports'))).toBe(false);
    });
  });

  describe('users 360', () => {
    interface Page<T> {
      items: T[];
      total: number;
      names?: Record<string, string>;
    }

    /** A user whose email the test knows, with a profile and a username. */
    const person = async (name: string): Promise<Actor & { email: string; username: string }> => {
      const email = `p360-${++seq}.${Date.now()}@example.com`;
      const { user, tokens } = await authService.signup(
        { email, password: PASSWORD, name },
        { ip: '127.0.0.1', userAgent: 'e2e-phone' },
      );
      const username = `u360${seq}${Date.now().toString(36)}`;
      await request(server())
        .post(`${V1}/me/username`)
        .set(auth(tokens.accessToken))
        .send({ username })
        .expect(201);
      return { token: tokens.accessToken, userId: user.id, email, username };
    };

    const adminAs = async (role: string): Promise<string> => {
      const email = `${role}-${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };

    it('lists users with contact details masked, found by username too', async () => {
      const token = await adminToken();
      const priya = await person('Priya Sharma');

      const list = (
        await request(server())
          .get(`${V1}/admin/users`)
          .query({ search: `@${priya.username}` })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Page<{ id: string; email: string | null }>>;

      expect(list.data.items.map((u) => u.id)).toEqual([priya.userId]);
      expect(list.data.items[0].email).not.toBe(priya.email);
      expect(list.data.items[0].email).toMatch(/^p3\*\*\*@example\.com$/);
    });

    it('filters by verification and sorts by name', async () => {
      const token = await adminToken();
      await person('Zed Unverified');
      const list = (
        await request(server())
          .get(`${V1}/admin/users`)
          .query({ verified: 'none', sort: 'name', order: 'asc', limit: 100 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Page<{ name: string | null; emailVerified: boolean }>>;
      expect(list.data.items.every((u) => !u.emailVerified)).toBe(true);
      const names = list.data.items.map((u) => u.name ?? '');
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it('opens the whole profile, and each section in pages', async () => {
      const token = await adminToken();
      const priya = await person('Priya Sharma');
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(priya.token))
        .send({ title: 'Diwali list', visibility: WishlistVisibility.PUBLIC })
        .expect(201);

      const profile = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/profile`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        email: string;
        profile: { username: string } | null;
        counts: Record<string, number>;
      }>;
      expect(profile.data.profile?.username).toBe(priya.username);
      expect(profile.data.email).not.toBe(priya.email);
      expect(profile.data.counts.wishlists).toBe(1);
      // Signing up opened a session.
      expect(profile.data.counts.activeSessions).toBeGreaterThanOrEqual(1);

      const wishlists = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/sections/wishlists`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Page<{ title: string }>>;
      expect(wishlists.data.items.map((w) => w.title)).toEqual(['Diwali list']);

      await request(server())
        .get(`${V1}/admin/users/${priya.userId}/sections/nonsense`)
        .set(auth(token))
        .expect(404);
    });

    // A moderator works on content and reports, not on people's money.
    it('keeps each section to the permission it belongs to', async () => {
      const priya = await person('Priya Sharma');
      const moderator = await adminAs('moderator');
      await request(server())
        .get(`${V1}/admin/users/${priya.userId}/sections/wishlists`)
        .set(auth(moderator))
        .expect(200);
      await request(server())
        .get(`${V1}/admin/users/${priya.userId}/sections/gifts-given`)
        .set(auth(moderator))
        .expect(403);

      const profile = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/profile`)
          .set(auth(moderator))
          .expect(200)
      ).body as Envelope<{ counts: Record<string, number> }>;
      expect(profile.data.counts.giftsGiven).toBeUndefined();
    });

    it('reveals a private value only with the permission, and audits why', async () => {
      const priya = await person('Priya Sharma');

      const analyst = await adminAs('analyst');
      await request(server())
        .post(`${V1}/admin/users/${priya.userId}/reveal`)
        .set(auth(analyst))
        .send({ field: 'email', reason: 'Checking a support ticket' })
        .expect(403);

      const token = await adminToken();
      const revealed = (
        await request(server())
          .post(`${V1}/admin/users/${priya.userId}/reveal`)
          .set(auth(token))
          .send({ field: 'email', reason: 'Support ticket #123' })
          .expect(200)
      ).body as Envelope<{ value: string }>;
      expect(revealed.data.value).toBe(priya.email);

      const audit = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/sections/audit`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Page<{ action: string; meta: { field: string; reason: string } }>>;
      const entry = audit.data.items.find((a) => a.action === 'user.reveal');
      expect(entry?.meta).toEqual({ field: 'email', reason: 'Support ticket #123' });
    });

    it('ends one sign-in, not all of them', async () => {
      const token = await adminToken();
      const priya = await person('Priya Sharma');
      const sessions = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/sections/sessions`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Page<{ id: string; revokedAt: string | null; userAgent: string }>>;
      const live = sessions.data.items.find((x) => x.revokedAt === null)!;
      expect(live.userAgent).toBe('e2e-phone');

      await request(server())
        .post(`${V1}/admin/users/${priya.userId}/sessions/${live.id}/revoke`)
        .set(auth(token))
        .expect(200);

      const after = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/sections/sessions`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Page<{ id: string; revokedAt: string | null }>>;
      expect(after.data.items.find((x) => x.id === live.id)?.revokedAt).not.toBeNull();
    });

    it('marks an email verified, with a reason on record', async () => {
      const token = await adminToken();
      const priya = await person('Priya Sharma');
      await request(server())
        .post(`${V1}/admin/users/${priya.userId}/verify`)
        .set(auth(token))
        .send({ field: 'email', reason: 'Confirmed over the phone' })
        .expect(200);
      const profile = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/profile`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ emailVerified: boolean }>;
      expect(profile.data.emailVerified).toBe(true);
    });

    it('redacts a profile, and will not hand out a taken username', async () => {
      const token = await adminToken();
      const priya = await person('Priya Sharma');
      const other = await person('Other Person');

      await request(server())
        .patch(`${V1}/admin/users/${priya.userId}/profile`)
        .set(auth(token))
        .send({ displayName: 'Priya', bio: '', reason: 'Phone number in bio' })
        .expect(200);
      const profile = (
        await request(server())
          .get(`${V1}/admin/users/${priya.userId}/profile`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ profile: { displayName: string; bio: string | null } }>;
      expect(profile.data.profile.displayName).toBe('Priya');
      expect(profile.data.profile.bio).toBeNull();

      await request(server())
        .patch(`${V1}/admin/users/${priya.userId}/profile`)
        .set(auth(token))
        .send({ username: other.username, reason: 'Impersonation' })
        .expect(409);
    });

    it('exports the list as CSV for those allowed to, with contacts masked', async () => {
      const priya = await person('Priya Sharma');
      const analyst = await adminAs('analyst');
      const res = await request(server())
        .get(`${V1}/admin/users/export`)
        .query({ search: priya.username })
        .set(auth(analyst))
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.trim().split('\n');
      expect(lines[0]).toBe(
        'id,name,email,phone,status,emailVerified,phoneVerified,source,joined,lastLogin',
      );
      expect(lines).toHaveLength(2);
      expect(res.text).not.toContain(priya.email);

      const support = await adminAs('support');
      await request(server()).get(`${V1}/admin/users/export`).set(auth(support)).expect(403);
    });
  });

  describe('content explorer', () => {
    interface ListPage {
      items: { id: string; title?: string | null; private?: boolean }[];
      total: number;
      names: Record<string, string>;
    }
    interface Detail {
      row: Record<string, unknown>;
      fields: Record<string, unknown>;
      sections: {
        key: string;
        items: Record<string, unknown>[];
        total: number;
        locked?: boolean;
      }[];
      locked: boolean;
      revealed: boolean;
      removal: { id: string } | null;
      names: Record<string, string>;
    }

    const roleToken = async (role: string): Promise<string> => {
      const email = `${role}-c${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };

    const db = () => app.get<Connection>(getConnectionToken()).db!;

    const wishlist = async (owner: Actor, title: string, visibility: string) =>
      (
        (
          await request(server())
            .post(`${V1}/wishlists`)
            .set(auth(owner.token))
            .send({ title, visibility })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;

    const item = async (owner: Actor, wishlistId: string, title: string) =>
      (
        (
          await request(server())
            .post(`${V1}/wishlists/${wishlistId}/items`)
            .set(auth(owner.token))
            .send({ title })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;

    it('lists wishlists with filters, and opens one with its items', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const listId = await wishlist(owner, `Explorer list ${seq}`, WishlistVisibility.PUBLIC);
      await item(owner, listId, 'Kindle Paperwhite');

      const page = (
        await request(server())
          .get(`${V1}/admin/content/wishlists`)
          .query({ q: 'Explorer list', owner: owner.userId, archived: 'no' })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<ListPage>;
      expect(page.data.items.map((w) => w.id)).toEqual([listId]);
      expect(Object.keys(page.data.names)).toContain(owner.userId);

      const detail = (
        await request(server())
          .get(`${V1}/admin/content/wishlists/${listId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Detail>;
      expect(detail.data.locked).toBe(false);
      const items = detail.data.sections.find((s) => s.key === 'items')!;
      expect(items.items[0].title).toBe('Kindle Paperwhite');

      await request(server()).get(`${V1}/admin/content/nonsense`).set(auth(token)).expect(404);
    });

    it('holds a private list back until it is revealed with a reason, and audits the look', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const listId = await wishlist(owner, `Secret list ${seq}`, WishlistVisibility.PRIVATE);
      const itemId = await item(owner, listId, 'Very private thing');

      // The items list does not carry its title either.
      const items = (
        await request(server())
          .get(`${V1}/admin/content/items`)
          .query({ owner: owner.userId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<ListPage>;
      const row = items.data.items.find((i) => i.id === itemId)!;
      expect(row.private).toBe(true);
      expect(row.title).toBeNull();

      const held = (
        await request(server())
          .get(`${V1}/admin/content/wishlists/${listId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Detail>;
      expect(held.data.locked).toBe(true);
      expect(held.data.sections.find((s) => s.key === 'items')!.items[0].title).toBeNull();

      // An analyst cannot reveal; a moderator can, and it is on the record.
      await request(server())
        .post(`${V1}/admin/content/wishlists/${listId}/reveal`)
        .set(auth(await roleToken('analyst')))
        .send({ reason: 'curious' })
        .expect(403);
      const shown = (
        await request(server())
          .post(`${V1}/admin/content/wishlists/${listId}/reveal`)
          .set(auth(token))
          .send({ reason: 'Report #42 about this list' })
          .expect(200)
      ).body as Envelope<Detail>;
      expect(shown.data.revealed).toBe(true);
      expect(shown.data.sections.find((s) => s.key === 'items')!.items[0].title).toBe(
        'Very private thing',
      );

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetType: 'wishlists', targetId: listId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string; meta: { reason?: string } }[] }>;
      const reveal = audit.data.items.find((a) => a.action === 'content.reveal');
      expect(reveal?.meta.reason).toBe('Report #42 about this list');
    });

    it('hides an item and puts it back, keeping the list counts right', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const listId = await wishlist(owner, `Count list ${seq}`, WishlistVisibility.PUBLIC);
      const itemId = await item(owner, listId, 'Spam item');
      await item(owner, listId, 'Real item');

      const count = async () =>
        (
          (await db()
            .collection('wishlists')
            .findOne({ _id: new Types.ObjectId(listId) }))!.stats as { itemCount: number }
        ).itemCount;
      expect(await count()).toBe(2);

      const hidden = (
        await request(server())
          .post(`${V1}/admin/content/items/${itemId}/actions/hide`)
          .set(auth(token))
          .send({ reason: 'Spam link' })
          .expect(200)
      ).body as Envelope<{ removal: { id: string } }>;
      expect(await count()).toBe(1);

      // Hiding twice is refused rather than stacking removals.
      await request(server())
        .post(`${V1}/admin/content/items/${itemId}/actions/hide`)
        .set(auth(token))
        .send({ reason: 'Again' })
        .expect(409);

      await request(server())
        .post(`${V1}/admin/content/removals/${hidden.data.removal.id}/restore`)
        .set(auth(token))
        .send({ reason: 'Owner appealed' })
        .expect(200);
      expect(await count()).toBe(2);
      await request(server())
        .post(`${V1}/admin/content/removals/${hidden.data.removal.id}/restore`)
        .set(auth(token))
        .send({ reason: 'Twice' })
        .expect(409);

      // A support role can look but not act.
      await request(server())
        .post(`${V1}/admin/content/items/${itemId}/actions/hide`)
        .set(auth(await roleToken('support')))
        .send({ reason: 'Nope' })
        .expect(403);
      // And an action the area does not have is a clear 400.
      await request(server())
        .post(`${V1}/admin/content/items/${itemId}/actions/explode`)
        .set(auth(token))
        .send({ reason: 'No' })
        .expect(400);
    });

    it('archives a list on the record, and leaves its share link to the owner', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const listId = await wishlist(owner, `Share list ${seq}`, WishlistVisibility.PUBLIC);
      const slugOf = async () =>
        (
          (await db()
            .collection('wishlists')
            .findOne({ _id: new Types.ObjectId(listId) }))!.share as { slug: string }
        ).slug;
      const before = await slugOf();

      // The panel no longer replaces a share link: the action is gone.
      await request(server())
        .post(`${V1}/admin/content/wishlists/${listId}/actions/rotate-share`)
        .set(auth(token))
        .send({ reason: 'Link leaked publicly' })
        .expect(400);
      expect(await slugOf()).toBe(before);

      await request(server())
        .post(`${V1}/admin/content/wishlists/${listId}/actions/archive`)
        .set(auth(token))
        .send({ reason: 'Spam' })
        .expect(200);
      const archived = (
        await request(server())
          .get(`${V1}/admin/content/wishlists/${listId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Detail>;
      expect(archived.data.row.archivedAt).toBeTruthy();
      expect(archived.data.removal).not.toBeNull();

      await request(server())
        .post(`${V1}/admin/content/wishlists/${listId}/actions/unarchive`)
        .set(auth(token))
        .send({ reason: 'Appeal upheld' })
        .expect(200);
      const back = await db()
        .collection('wishlists')
        .findOne({ _id: new Types.ObjectId(listId) });
      expect(back!.archivedAt).toBeNull();

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetId: listId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(audit.data.items.map((a) => a.action)).toEqual(
        expect.arrayContaining(['content.remove', 'content.restore']),
      );
    });

    it('cancels an event through the events module, and unpublishes another', async () => {
      const token = await adminToken();
      const host = await newUser();
      const create = async (title: string) =>
        (
          (
            await request(server())
              .post(`${V1}/events`)
              .set(auth(host.token))
              .send({
                title,
                type: 'birthday',
                startsAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
                timezone: 'Asia/Kolkata',
              })
              .expect(201)
          ).body as Envelope<{ id: string }>
        ).data.id;
      const publish = (id: string) =>
        request(server()).post(`${V1}/events/${id}/publish`).set(auth(host.token)).expect(200);

      const a = await create('Party A');
      const b = await create('Party B');
      await publish(a);
      await publish(b);

      await request(server())
        .post(`${V1}/admin/content/events/${a}/actions/cancel`)
        .set(auth(token))
        .send({ reason: 'Fraudulent event' })
        .expect(200);
      await request(server())
        .post(`${V1}/admin/content/events/${b}/actions/unpublish`)
        .set(auth(token))
        .send({ reason: 'Hold for review' })
        .expect(200);

      const list = (
        await request(server())
          .get(`${V1}/admin/content/events`)
          .query({ owner: host.userId, status: 'cancelled' })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<ListPage>;
      expect(list.data.items.map((e) => e.id)).toEqual([a]);
      const draft = await db()
        .collection('events')
        .findOne({ _id: new Types.ObjectId(b) });
      expect(draft!.status).toBe('draft');

      const detail = (
        await request(server()).get(`${V1}/admin/content/events/${a}`).set(auth(token)).expect(200)
      ).body as Envelope<Detail>;
      expect(detail.data.sections.map((s) => s.key)).toEqual(
        expect.arrayContaining(['invites', 'join-requests', 'wishlists', 'memories']),
      );
    });

    it('keeps memory wishes sealed, and removes and restores one exactly', async () => {
      const token = await adminToken();
      const host = await newUser();
      const contributor = await newUser();
      const capsuleId = new Types.ObjectId();
      const wishId = new Types.ObjectId();
      await db()
        .collection('memory_capsules')
        .insertOne({
          _id: capsuleId,
          hostId: new Types.ObjectId(host.userId),
          title: 'For Asha',
          personName: 'Asha',
          occasion: 'birthday',
          status: 'collecting',
          unlockAt: new Date(Date.now() + 10 * DAY_MS),
          timezone: 'Asia/Kolkata',
          share: { slug: `mem${Date.now()}${seq}`, expiresAt: null, rotatedAt: new Date() },
          wishCount: 1,
          sharedWith: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await db()
        .collection('memory_wishes')
        .insertOne({
          _id: wishId,
          capsuleId,
          contributorId: new Types.ObjectId(contributor.userId),
          contributorName: 'Ravi',
          kind: 'text',
          text: 'Happy birthday, from the bottom of my heart',
          mediaId: null,
          mediaUrl: null,
          durationMs: 0,
          order: 0,
          reactionCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const sealed = (
        await request(server())
          .get(`${V1}/admin/content/memories/${capsuleId.toString()}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Detail>;
      const wishes = sealed.data.sections.find((s) => s.key === 'wishes')!;
      expect(wishes.locked).toBe(true);
      expect(wishes.items[0].text).toBeNull();
      expect(wishes.items[0].contributorName).toBe('Ravi');

      const removed = (
        await request(server())
          .post(`${V1}/admin/content/memories/${capsuleId.toString()}/actions/remove-wish`)
          .set(auth(token))
          .send({ reason: 'Abusive', wishId: wishId.toString() })
          .expect(200)
      ).body as Envelope<{ removal: { id: string } }>;
      expect(await db().collection('memory_wishes').findOne({ _id: wishId })).toBeNull();
      const capsule = () => db().collection('memory_capsules').findOne({ _id: capsuleId });
      expect((await capsule())!.wishCount).toBe(0);

      await request(server())
        .post(`${V1}/admin/content/removals/${removed.data.removal.id}/restore`)
        .set(auth(token))
        .send({ reason: 'Misread it' })
        .expect(200);
      const back = await db().collection('memory_wishes').findOne({ _id: wishId });
      expect(back!.text).toBe('Happy birthday, from the bottom of my heart');
      expect((await capsule())!.wishCount).toBe(1);

      // Relocking needs a date in the future.
      await request(server())
        .post(`${V1}/admin/content/memories/${capsuleId.toString()}/actions/relock`)
        .set(auth(token))
        .send({ reason: 'Hold', unlockAt: new Date(Date.now() - DAY_MS).toISOString() })
        .expect(400);
    });

    it('reads a chat only on reveal, and deletes and restores a message', async () => {
      const token = await adminToken();
      const a = await newUser();
      const b = await newUser();
      const chatId = new Types.ObjectId();
      const messageId = new Types.ObjectId();
      await db()
        .collection('chats')
        .insertOne({
          _id: chatId,
          type: 'direct',
          refId: new Types.ObjectId(),
          participantIds: [new Types.ObjectId(a.userId), new Types.ObjectId(b.userId)],
          lastMessageAt: new Date(),
          settings: { whoCanPost: 'participants' },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await db()
        .collection('messages')
        .insertOne({
          _id: messageId,
          chatId,
          senderId: new Types.ObjectId(a.userId),
          kind: 'text',
          body: 'meet me at 7',
          attachments: [],
          reactions: [],
          replyToId: null,
          editedAt: null,
          deletedAt: null,
          systemType: null,
          hideFromUserIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const listed = (
        await request(server())
          .get(`${V1}/admin/content/chats`)
          .query({ participant: a.userId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<ListPage>;
      expect(listed.data.items.map((c) => c.id)).toEqual([chatId.toString()]);
      // The list says how much is in each chat (and, for a list or a group
      // gift, its title — a direct chat has none).
      expect(listed.data.items[0]).toMatchObject({ messages: 1, refTitle: null });

      // Searching chats looks in the titles of what they belong to.
      const listId = new Types.ObjectId();
      const listChatId = new Types.ObjectId();
      await db()
        .collection('wishlists')
        .insertOne({
          _id: listId,
          title: 'Zorblat turns 30',
          ownerId: new Types.ObjectId(a.userId),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await db()
        .collection('chats')
        .insertOne({
          _id: listChatId,
          type: 'wishlist',
          refId: listId,
          participantIds: [new Types.ObjectId(a.userId)],
          lastMessageAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      const found = (
        await request(server())
          .get(`${V1}/admin/content/chats`)
          .query({ q: 'zorblat' })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<ListPage>;
      expect(found.data.items.map((c) => c.id)).toEqual([listChatId.toString()]);
      expect(found.data.items[0]).toMatchObject({ refTitle: 'Zorblat turns 30', messages: 0 });

      const sealed = (
        await request(server())
          .get(`${V1}/admin/content/chats/${chatId.toString()}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Detail>;
      expect(sealed.data.sections[0].items[0].body).toBeNull();
      const open = (
        await request(server())
          .post(`${V1}/admin/content/chats/${chatId.toString()}/reveal`)
          .set(auth(token))
          .send({ reason: 'Harassment report' })
          .expect(200)
      ).body as Envelope<Detail>;
      expect(open.data.sections[0].items[0].body).toBe('meet me at 7');

      await request(server())
        .post(`${V1}/admin/content/chats/${chatId.toString()}/actions/delete-message`)
        .set(auth(token))
        .send({ reason: 'Threat', messageId: messageId.toString() })
        .expect(200);
      expect(
        (await db().collection('messages').findOne({ _id: messageId }))!.deletedAt,
      ).toBeTruthy();
      await request(server())
        .post(`${V1}/admin/content/chats/${chatId.toString()}/actions/restore-message`)
        .set(auth(token))
        .send({ reason: 'Context: a joke', messageId: messageId.toString() })
        .expect(200);
      expect((await db().collection('messages').findOne({ _id: messageId }))!.deletedAt).toBeNull();
    });

    it('pages a long section, and reveals a later page with a reason', async () => {
      const token = await adminToken();
      const a = await newUser();
      const chatId = new Types.ObjectId();
      await db()
        .collection('chats')
        .insertOne({
          _id: chatId,
          type: 'direct',
          refId: new Types.ObjectId(),
          participantIds: [new Types.ObjectId(a.userId)],
          lastMessageAt: new Date(),
          settings: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await db()
        .collection('messages')
        .insertMany(
          Array.from({ length: 60 }, (_, i) => ({
            _id: new Types.ObjectId(),
            chatId,
            senderId: new Types.ObjectId(a.userId),
            kind: 'text',
            body: `message ${i}`,
            attachments: [],
            deletedAt: null,
            createdAt: new Date(Date.now() + i),
            updatedAt: new Date(),
          })),
        );

      const detail = (
        await request(server())
          .get(`${V1}/admin/content/chats/${chatId.toString()}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Detail>;
      const first = detail.data.sections[0];
      expect(first.items).toHaveLength(50);
      expect(first.total).toBe(60);

      const sealed = (
        await request(server())
          .get(`${V1}/admin/content/chats/${chatId.toString()}/sections/messages`)
          .query({ page: 2 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { body: string | null }[]; locked: boolean; page: number }>;
      expect(sealed.data.items).toHaveLength(10);
      expect(sealed.data.locked).toBe(true);
      expect(sealed.data.items[0].body).toBeNull();

      const open = (
        await request(server())
          .post(`${V1}/admin/content/chats/${chatId.toString()}/sections/messages/reveal`)
          .set(auth(token))
          .send({ reason: 'Older context for a report', page: 2 })
          .expect(200)
      ).body as Envelope<{ items: { body: string | null }[] }>;
      // Newest first, so the second page holds the oldest ten.
      expect(open.data.items.map((m) => m.body)).toContain('message 0');

      await request(server())
        .get(`${V1}/admin/content/chats/${chatId.toString()}/sections/nope`)
        .set(auth(token))
        .expect(404);
    });

    it('offers item categories from the data, and shows a price drop on the item', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const listId = await wishlist(owner, `Alert list ${seq}`, WishlistVisibility.PUBLIC);
      const itemId = await item(owner, listId, 'Headphones');
      await db()
        .collection('wishlist_items')
        .updateOne(
          { _id: new Types.ObjectId(itemId) },
          {
            $set: {
              category: 'zz-test-audio',
              'price.amountMinor': 500000,
              sourceAlert: {
                priceChangedAt: new Date(),
                currentAmountMinor: 420000,
                outOfStock: false,
                checkedAt: new Date(),
              },
            },
          },
        );

      const facets = (
        await request(server())
          .get(`${V1}/admin/content/items/facets/category`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<string[]>;
      expect(facets.data).toContain('zz-test-audio');
      await request(server())
        .get(`${V1}/admin/content/items/facets/title`)
        .set(auth(token))
        .expect(404);

      const list = (
        await request(server())
          .get(`${V1}/admin/content/items`)
          .query({ category: 'zz-test-audio', minPrice: 400000, maxPrice: 600000 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { id: string; alert: { currentAmountMinor: number } | null }[] }>;
      expect(list.data.items.map((i) => i.id)).toEqual([itemId]);
      expect(list.data.items[0].alert?.currentAmountMinor).toBe(420000);
    });

    it('shows the invitation card as guests get it', async () => {
      const token = await adminToken();
      const host = await newUser();
      const eventId = (
        (
          await request(server())
            .post(`${V1}/events`)
            .set(auth(host.token))
            .send({
              title: 'Card party',
              type: 'birthday',
              startsAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
              timezone: 'Asia/Kolkata',
            })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      await db()
        .collection('events')
        .updateOne(
          { _id: new Types.ObjectId(eventId) },
          {
            $set: {
              inviteTemplate: { templateId: 'celebration', colorVariant: 'blush', fields: {} },
            },
          },
        );

      const detail = (
        await request(server())
          .get(`${V1}/admin/content/events/${eventId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<Detail>;
      const invitation = detail.data.fields.invitation as {
        templateId: string;
        colorVariant: string;
        text: { headline: string } | null;
      };
      expect(invitation.templateId).toBe('celebration');
      expect(invitation.colorVariant).toBe('blush');
      expect(invitation.text?.headline).toBeTruthy();
    });

    it('deletes a file for good, and re-processes only a failed video', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const photo = new Types.ObjectId();
      await db()
        .collection('media')
        .insertOne({
          _id: photo,
          ownerId: new Types.ObjectId(owner.userId),
          purpose: 'wishlist_cover',
          storageKey: `test/${photo.toString()}.jpg`,
          status: 'ready',
          declaredContentType: 'image/jpeg',
          contentType: 'image/jpeg',
          sizeBytes: 3 * 1024 * 1024,
          url: 'https://cdn.example.test/x.jpg',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const bySize = (
        await request(server())
          .get(`${V1}/admin/content/media`)
          .query({ owner: owner.userId, minSize: 2 * 1024 * 1024, maxSize: 4 * 1024 * 1024 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { id: string }[] }>;
      expect(bySize.data.items.map((m) => m.id)).toEqual([photo.toString()]);

      // A photo is never processed, so there is nothing to retry.
      await request(server())
        .post(`${V1}/admin/content/media/${photo.toString()}/actions/retry-processing`)
        .set(auth(token))
        .send({ reason: 'Try again' })
        .expect(409);

      await request(server())
        .post(`${V1}/admin/content/media/${photo.toString()}/actions/delete-now`)
        .set(auth(token))
        .send({ reason: 'Illegal image' })
        .expect(200);
      expect(await db().collection('media').findOne({ _id: photo })).toBeNull();
    });

    it('exports a content list as CSV for those allowed to', async () => {
      const token = await adminToken();
      const owner = await newUser();
      await wishlist(owner, `Csv list ${seq}`, WishlistVisibility.PUBLIC);
      const res = await request(server())
        .get(`${V1}/admin/content/wishlists/export`)
        .query({ owner: owner.userId })
        .set(auth(token))
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\n')).toHaveLength(2);
      // An analyst may export, but not content they cannot see.
      await request(server())
        .get(`${V1}/admin/content/wishlists/export`)
        .set(auth(await roleToken('analyst')))
        .expect(403);
    });
  });

  describe('money explorer', () => {
    const idem = () => ({ 'Idempotency-Key': `idem-${randomUUID()}` });
    const db = () => app.get<Connection>(getConnectionToken()).db!;

    const roleToken = async (role: string): Promise<string> => {
      const email = `${role}-m${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };

    const itemFor = async (owner: Actor, price = 249900): Promise<string> => {
      const wl = (
        await request(server())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: `Money list ${++seq}`, visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      return (
        (
          await request(server())
            .post(`${V1}/wishlists/${wl.data.id}/items`)
            .set(auth(owner.token))
            .send({ title: 'Headphones', price: { amountMinor: price } })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
    };

    const reserve = async (gifter: Actor, itemId: string): Promise<string> =>
      (
        (
          await request(server())
            .post(`${V1}/items/${itemId}/reserve`)
            .set(auth(gifter.token))
            .set(idem())
            .send({})
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;

    const act = (token: string, kind: string, rowId: string, action: string, body: object) =>
      request(server())
        .post(`${V1}/admin/money/${kind}/${rowId}/actions/${action}`)
        .set(auth(token))
        .send(body);

    it('lists gifts, finds a stuck reservation, and opens one with its history', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const gifter = await newUser();
      const giftId = await reserve(gifter, await itemFor(owner));
      await db()
        .collection('gifts')
        .updateOne(
          { _id: new Types.ObjectId(giftId) },
          { $set: { expiresAt: new Date(Date.now() - 60_000) } },
        );

      const stuck = (
        await request(server())
          .get(`${V1}/admin/money/gifts`)
          .query({ stuck: 'yes', owner: gifter.userId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { id: string; stuck: boolean; itemTitle: string }[] }>;
      expect(stuck.data.items.map((g) => g.id)).toEqual([giftId]);
      expect(stuck.data.items[0].stuck).toBe(true);
      expect(stuck.data.items[0].itemTitle).toBe('Headphones');

      const detail = (
        await request(server())
          .get(`${V1}/admin/money/gifts/${giftId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ sections: { key: string; items: { status: string }[] }[] }>;
      const history = detail.data.sections.find((s) => s.key === 'history')!;
      expect(history.items[0].status).toBe('reserved');

      // A role without money:view cannot look.
      await request(server())
        .get(`${V1}/admin/money/gifts`)
        .set(auth(await roleToken('moderator')))
        .expect(403);
    });

    it('extends a hold, then cancels the gift — freeing the item, on the record', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const gifter = await newUser();
      const itemId = await itemFor(owner);
      const giftId = await reserve(gifter, itemId);

      const until = new Date(Date.now() + 10 * DAY_MS).toISOString();
      await act(token, 'gifts', giftId, 'extend', {
        reason: 'Asked support for time',
        until,
      }).expect(200);
      const extended = await db()
        .collection('gifts')
        .findOne({ _id: new Types.ObjectId(giftId) });
      expect((extended!.expiresAt as Date).toISOString()).toBe(until);

      // Support can see money but not change it.
      await act(await roleToken('support'), 'gifts', giftId, 'cancel', { reason: 'No' }).expect(
        403,
      );

      await act(token, 'gifts', giftId, 'cancel', { reason: 'Duplicate reservation' }).expect(200);
      const gift = await db()
        .collection('gifts')
        .findOne({ _id: new Types.ObjectId(giftId) });
      expect(gift!.status).toBe('cancelled');
      const history = gift!.history as { by: string; note: string }[];
      expect(history.at(-1)!.by).toBe(`admin:${ADMIN_EMAIL}`);
      const item = await db()
        .collection('wishlist_items')
        .findOne({ _id: new Types.ObjectId(itemId) });
      expect(item!.status).toBe('available');

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetId: giftId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(audit.data.items.map((a) => a.action)).toEqual(
        expect.arrayContaining(['money.extend', 'money.cancel']),
      );

      // A cancelled gift cannot be bought: the gift rules still apply.
      await act(token, 'gifts', giftId, 'mark-purchased', { reason: 'Oops' }).expect(409);
    });

    it('marks a gift bought, which opens its order; then corrects the order', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const gifter = await newUser();
      const giftId = await reserve(gifter, await itemFor(owner));
      await act(token, 'gifts', giftId, 'mark-purchased', { reason: 'Receipt by email' }).expect(
        200,
      );

      // The order is created by the gift lifecycle listener.
      let order: Record<string, unknown> | null = null;
      for (let i = 0; i < 20 && !order; i++) {
        order = await db()
          .collection('orders')
          .findOne({ giftId: new Types.ObjectId(giftId) });
        if (!order) await delay(50);
      }
      expect(order).not.toBeNull();
      const orderId = String(order!._id);

      await act(token, 'orders', orderId, 'set-stage', {
        reason: 'Courier confirmed',
        stage: 'shipped',
      }).expect(200);
      await act(token, 'orders', orderId, 'set-tracking', {
        reason: 'Courier sent it',
        courier: 'Delhivery',
        trackingNumber: 'DL123',
      }).expect(200);
      // Back a step is allowed for an admin, on the record as manual.
      await act(token, 'orders', orderId, 'set-stage', {
        reason: 'Mis-scan',
        stage: 'processing',
      }).expect(200);

      const detail = (
        await request(server())
          .get(`${V1}/admin/money/orders/${orderId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        row: { stage: string; courier: string };
        sections: { key: string; items: { stage: string; source: string }[] }[];
      }>;
      expect(detail.data.row.stage).toBe('processing');
      expect(detail.data.row.courier).toBe('Delhivery');
      const timeline = detail.data.sections.find((s) => s.key === 'timeline')!;
      expect(timeline.items[0]).toEqual(
        expect.objectContaining({ stage: 'processing', source: 'manual' }),
      );
      await act(token, 'orders', orderId, 'set-stage', { reason: 'x', stage: 'teleported' }).expect(
        400,
      );
    });

    it('replays a dead-lettered webhook once its gift exists', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const gifter = await newUser();
      const giftId = await reserve(gifter, await itemFor(owner));
      const orderRef = `ord-${randomUUID()}`;
      await db()
        .collection('gifts')
        .updateOne({ _id: new Types.ObjectId(giftId) }, { $set: { orderRef } });
      const eventId = new Types.ObjectId();
      await db()
        .collection('webhook_events')
        .insertOne({
          _id: eventId,
          provider: 'fixture',
          providerEventId: `evt-${randomUUID()}`,
          eventType: 'order',
          orderRef,
          status: 'unmatched',
          matchedGiftId: null,
          payload: { providerEventId: 'x', eventType: 'order', orderRef, timestamp: Date.now() },
          note: 'no active online gift matched this orderRef',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const res = (
        await act(token, 'webhooks', eventId.toString(), 'replay', {
          reason: 'Gift exists now',
        }).expect(200)
      ).body as Envelope<{ result: { status: string; giftId: string } }>;
      expect(res.data.result).toEqual({ status: 'processed', giftId });
      const gift = await db()
        .collection('gifts')
        .findOne({ _id: new Types.ObjectId(giftId) });
      expect(gift!.status).toBe('purchased');
      // Processed now, so there is nothing left to replay.
      await act(token, 'webhooks', eventId.toString(), 'replay', { reason: 'Again' }).expect(409);
    });

    it('shows each group gift payment as the host sees it, and queues the ones that need a look', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const host = await newUser();
      const [waits, short, missing, paid] = [
        await newUser(),
        await newUser(),
        await newUser(),
        await newUser(),
      ];
      const itemId = await itemFor(owner, 500000);
      const gg = (
        (
          await request(server())
            .post(`${V1}/items/${itemId}/group-gift`)
            .set(auth(host.token))
            .set(idem())
            .send({ title: 'Payments check', contributionMode: 'custom', hostUpiId: 'host@okaxis' })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      // Each member says they sent ₹500; the host has not answered yet.
      const claimOf = async (member: Actor, paymentRef?: string) => {
        await request(server())
          .post(`${V1}/group-gifts/${gg}/contribute`)
          .set(auth(member.token))
          .set(idem())
          .send({ amountMinor: 50000, ...(paymentRef ? { paymentRef } : {}) })
          .expect(201);
        const row = await db()
          .collection('contributions')
          .findOne({
            groupGiftId: new Types.ObjectId(gg),
            userId: new Types.ObjectId(member.userId),
          });
        return String(row!._id);
      };
      await claimOf(waits, '111111111111');
      const shortId = await claimOf(short);
      const missingId = await claimOf(missing);
      const paidId = await claimOf(paid);
      const review = (cid: string, receivedMinor: number) =>
        request(server())
          .post(`${V1}/group-gifts/${gg}/contributions/${cid}/review`)
          .set(auth(host.token))
          .send({ receivedMinor })
          .expect(200);
      await review(shortId, 30000);
      await review(missingId, 0);
      await review(paidId, 50000);
      // "I did pay" — after the host said nothing arrived.
      await request(server())
        .post(`${V1}/group-gifts/${gg}/contributions/${missingId}/dispute`)
        .set(auth(missing.token))
        .send({ paymentRef: '222222222222', note: 'Sent on Monday' })
        .expect(200);

      type Payment = {
        id: string;
        userId: string;
        payment: string;
        claimedMinor: number | null;
        receivedMinor: number | null;
        paymentRef: string | null;
        giftTitle: string | null;
      };
      const payments = async (query: Record<string, string>) =>
        (
          (
            await request(server())
              .get(`${V1}/admin/money/payments`)
              .query({ groupGift: gg, ...query })
              .set(auth(token))
              .expect(200)
          ).body as Envelope<{ items: Payment[]; total: number }>
        ).data;
      const all = await payments({});
      expect(all.total).toBe(4);
      const stateOf = (who: Actor) => all.items.find((p) => p.userId === who.userId)?.payment;
      expect(stateOf(waits)).toBe('awaiting');
      expect(stateOf(short)).toBe('partial');
      expect(stateOf(missing)).toBe('disputed');
      expect(stateOf(paid)).toBe('received');
      expect(all.items.find((p) => p.userId === short.userId)).toMatchObject({
        claimedMinor: 50000,
        receivedMinor: 30000,
        giftTitle: 'Payments check',
      });
      for (const [state, who] of [
        ['awaiting', waits],
        ['partial', short],
        ['disputed', missing],
        ['received', paid],
      ] as const) {
        const page = await payments({ payment: state });
        expect(page.items.map((p) => p.userId)).toEqual([who.userId]);
      }

      // The gift: money still waiting, and the open dispute, beside the stored total.
      const disputedGifts = (
        await request(server())
          .get(`${V1}/admin/money/group-gifts`)
          .query({ payments: 'disputed', owner: host.userId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { id: string; awaitingMinor: number; openDisputes: number }[] }>;
      expect(disputedGifts.data.items.find((g) => g.id === gg)).toMatchObject({
        awaitingMinor: 50000,
        openDisputes: 1,
      });
      const detail = (
        await request(server())
          .get(`${V1}/admin/money/group-gifts/${gg}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        fields: { awaitingMinor: number; awaitingPayments: number; openDisputes: number };
        sections: { key: string; items: Payment[] }[];
      }>;
      expect(detail.data.fields).toMatchObject({
        awaitingMinor: 50000,
        awaitingPayments: 1,
        openDisputes: 1,
      });
      const rows = detail.data.sections.find((s) => s.key === 'contributions')!.items;
      expect(rows.find((r) => r.id === missingId)).toMatchObject({
        payment: 'disputed',
        paymentRef: '222222222222',
      });

      // Refund only gives back money that arrived.
      for (const [cid, why] of [
        [rows.find((r) => r.userId === waits.userId)!.id, 'not confirmed'],
        [missingId, 'Nothing arrived'],
      ]) {
        const res = await act(token, 'group-gifts', gg, 'refund-contribution', {
          reason: 'Asked by support',
          contributionId: cid,
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain(why);
      }

      // The dashboard flags the dispute.
      await request(server())
        .post(`${V1}/admin/ops/caches/dashboard/clear`)
        .set(auth(token))
        .send({ reason: 'fresh numbers for the test' })
        .expect(200);
      const dash = (
        await request(server()).get(`${V1}/admin/dashboard`).set(auth(token)).expect(200)
      ).body as Envelope<{ attention: { key: string; count: number }[] }>;
      expect(
        dash.data.attention.find((a) => a.key === 'payments-disputed')?.count,
      ).toBeGreaterThanOrEqual(1);

      // A claim waiting three days is flagged while its gift is open; once the gift is
      // cancelled it is frozen — nobody can answer it — so it drops out of both numbers.
      const waiting = async () => {
        await request(server())
          .post(`${V1}/admin/ops/caches/dashboard/clear`)
          .set(auth(token))
          .send({ reason: 'fresh numbers for the test' })
          .expect(200);
        const body = (
          await request(server()).get(`${V1}/admin/dashboard`).set(auth(token)).expect(200)
        ).body as Envelope<{
          attention: { key: string; count: number }[];
          money: { groupGiftAwaitingMinor: number };
        }>;
        return {
          old: body.data.attention.find((a) => a.key === 'payments-waiting')?.count ?? 0,
          minor: body.data.money.groupGiftAwaitingMinor,
        };
      };
      const before = await waiting();
      const late = (
        (
          await request(server())
            .post(`${V1}/items/${await itemFor(owner, 300000)}/group-gift`)
            .set(auth(host.token))
            .set(idem())
            .send({
              title: 'Cancelled with a claim',
              contributionMode: 'custom',
              hostUpiId: 'host@okaxis',
            })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      const lateMember = await newUser();
      await request(server())
        .post(`${V1}/group-gifts/${late}/contribute`)
        .set(auth(lateMember.token))
        .set(idem())
        .send({ amountMinor: 50000 })
        .expect(201);
      await db()
        .collection('contributions')
        .updateOne(
          { groupGiftId: new Types.ObjectId(late) },
          { $set: { createdAt: new Date(Date.now() - 3 * 86_400_000) } },
        );
      expect(await waiting()).toEqual({ old: before.old + 1, minor: before.minor + 50000 });
      await request(server())
        .post(`${V1}/group-gifts/${late}/cancel`)
        .set(auth(host.token))
        .send({})
        .expect(200);
      expect(await waiting()).toEqual(before);

      // One payment opens on its own, with the gift it belongs to.
      const one = (
        await request(server())
          .get(`${V1}/admin/money/payments/${missingId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ row: Payment; fields: { groupGiftId: string; leftWaiting: boolean } }>;
      expect(one.data.row.giftTitle).toBe('Payments check');
      expect(one.data.fields).toMatchObject({ groupGiftId: gg, leftWaiting: false });
      // Support looks; the host decides.
      await act(token, 'payments', missingId, 'review', { reason: 'Nope' }).expect(400);
    });

    it('refunds a contribution, cancels a group gift, and logs drift', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const host = await newUser();
      const itemId = await itemFor(owner, 500000);
      const gg = (
        (
          await request(server())
            .post(`${V1}/items/${itemId}/group-gift`)
            .set(auth(host.token))
            .set(idem())
            .send({ title: 'Team gift', contributionMode: 'custom' })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      await request(server())
        .post(`${V1}/group-gifts/${gg}/contribute`)
        .set(auth(host.token))
        .set(idem())
        .send({ amountMinor: 100000 })
        .expect(201);

      const detail = (
        await request(server())
          .get(`${V1}/admin/money/group-gifts/${gg}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        fields: { balance: { collectedMinor: number } };
        sections: { key: string; items: { id: string; status: string }[] }[];
      }>;
      expect(detail.data.fields.balance.collectedMinor).toBe(100000);
      const contribution = detail.data.sections.find((s) => s.key === 'contributions')!.items[0];

      await act(token, 'group-gifts', gg, 'refund-contribution', {
        reason: 'Paid back by bank transfer',
        contributionId: contribution.id,
      }).expect(200);
      const after = await db()
        .collection('group_gifts')
        .findOne({ _id: new Types.ObjectId(gg) });
      expect(after!.collectedAmountMinor).toBe(0);

      // Drift: the cached total disagrees with the contributions.
      await db()
        .collection('group_gifts')
        .updateOne({ _id: new Types.ObjectId(gg) }, { $set: { collectedAmountMinor: 777 } });
      await app.get(GroupGiftReconcileService).reconcile();
      let logged = false;
      for (let i = 0; i < 20 && !logged; i++) {
        logged =
          (await db()
            .collection('ops_events')
            .countDocuments({ refId: new Types.ObjectId(gg) })) > 0;
        if (!logged) await delay(50);
      }
      expect(logged).toBe(true);
      const drift = (
        await request(server()).get(`${V1}/admin/money/drift`).set(auth(token)).expect(200)
      ).body as Envelope<{ items: { groupGiftId: string; driftMinor: number }[] }>;
      expect(drift.data.items.find((d) => d.groupGiftId === gg)?.driftMinor).toBe(777);
      const drifted = (
        await request(server())
          .get(`${V1}/admin/money/group-gifts`)
          .query({ drift: 'yes', owner: host.userId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { id: string }[] }>;
      expect(drifted.data.items.map((g) => g.id)).toEqual([gg]);

      await act(token, 'group-gifts', gg, 'cancel', {
        reason: 'Recipient asked us to stop it',
      }).expect(200);
      const cancelled = await db()
        .collection('group_gifts')
        .findOne({ _id: new Types.ObjectId(gg) });
      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.cancelReason).toBe('Recipient asked us to stop it');
    });

    it('sums money by month, and exports it for those allowed to', async () => {
      const token = await adminToken();
      await db()
        .collection('conversions')
        .insertOne({
          network: 'cuelinks',
          externalId: `cx-${randomUUID()}`,
          campaignName: 'Zz Test Store',
          saleAmountMinor: 100000,
          commissionMinor: 5000,
          currency: 'INR',
          status: 'pending',
          transactionAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      const finance = (
        await request(server()).get(`${V1}/admin/money/finance`).set(auth(token)).expect(200)
      ).body as Envelope<{
        months: { month: string; commissionByStatus: Record<string, number> }[];
      }>;
      const thisMonth = new Date().toISOString().slice(0, 7);
      const row = finance.data.months.find((m) => m.month === thisMonth)!;
      expect(row.commissionByStatus.pending).toBeGreaterThanOrEqual(5000);

      const affiliate = (
        await request(server()).get(`${V1}/admin/money/affiliate`).set(auth(token)).expect(200)
      ).body as Envelope<{ byMerchant: { merchant: string; commissionMinor: number }[] }>;
      expect(
        affiliate.data.byMerchant.find((m) => m.merchant === 'Zz Test Store')?.commissionMinor,
      ).toBe(5000);

      const csvRes = await request(server())
        .get(`${V1}/admin/money/finance/export`)
        .set(auth(await roleToken('analyst')))
        .expect(200);
      expect(csvRes.text).toContain('month,gmvMinor');
      await request(server())
        .post(`${V1}/admin/money/affiliate/sync`)
        .set(auth(await roleToken('analyst')))
        .expect(403);
      await request(server()).post(`${V1}/admin/money/affiliate/sync`).set(auth(token)).expect(200);
    });
  });

  describe('notifications centre', () => {
    const db = () => app.get<Connection>(getConnectionToken()).db!;

    const roleToken = async (role: string): Promise<string> => {
      const email = `${role}-n${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };

    /** Polls until [check] passes or two seconds go by. */
    const eventually = async (check: () => Promise<boolean>): Promise<boolean> => {
      for (let i = 0; i < 40; i++) {
        if (await check()) return true;
        await delay(50);
      }
      return false;
    };

    it('lists deliveries with addresses masked, and sums outcomes by channel', async () => {
      const token = await adminToken();
      const user = await newUser();
      const uid = new Types.ObjectId(user.userId);
      await db()
        .collection('delivery_logs')
        .insertMany([
          {
            userId: uid,
            type: 'gift_purchased',
            channel: 'push',
            refId: `r-${seq}`,
            dedupeKey: `k-${seq}-1-${Date.now()}`,
            status: 'failed',
            destination: null,
            providerRef: null,
            error: 'device unregistered',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            userId: uid,
            type: 'gift_purchased',
            channel: 'sms',
            refId: `r-${seq}`,
            dedupeKey: `k-${seq}-3-${Date.now()}`,
            // Nor any SMS notification.
            status: 'failed',
            destination: '+919876543210',
            providerRef: null,
            error: 'carrier rejected',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            userId: uid,
            type: 'gift_purchased',
            channel: 'email',
            refId: `r-${seq}`,
            dedupeKey: `k-${seq}-2-${Date.now()}`,
            // Wishtick sends no email: a log of one is never shown.
            status: 'failed',
            destination: 'asha.rao@example.com',
            providerRef: null,
            error: 'mailbox full',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);

      const failed = (
        await request(server())
          .get(`${V1}/admin/notifications/deliveries`)
          .query({ owner: user.userId, status: 'failed' })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { destination: string; error: string }[] }>;
      expect(failed.data.items).toHaveLength(1);
      expect(failed.data.items[0].error).toBe('device unregistered');
      // Asking for email or SMS by name does not bring them back.
      for (const channel of ['email', 'sms']) {
        const asked = (
          await request(server())
            .get(`${V1}/admin/notifications/deliveries`)
            .query({ owner: user.userId, channel })
            .set(auth(token))
            .expect(200)
        ).body as Envelope<{ items: { error: string }[] }>;
        expect(asked.data.items.map((d) => d.error)).toEqual(['device unregistered']);
      }

      const overview = (
        await request(server())
          .get(`${V1}/admin/notifications/overview`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ byChannel: { channel: string; counts: Record<string, number> }[] }>;
      const push = overview.data.byChannel.find((c) => c.channel === 'push')!;
      expect(push.counts.failed).toBeGreaterThanOrEqual(1);
      expect(overview.data.byChannel.map((c) => c.channel)).not.toContain('email');
      expect(overview.data.byChannel.map((c) => c.channel)).not.toContain('sms');

      // An analyst has no business with notifications.
      await request(server())
        .get(`${V1}/admin/notifications/overview`)
        .set(auth(await roleToken('analyst')))
        .expect(403);
    });

    it('previews any notification, including an announcement', async () => {
      const token = await adminToken();
      const list = (
        await request(server())
          .get(`${V1}/admin/notifications/templates`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ type: string; channels: string[] }[]>;
      expect(list.data.find((t) => t.type === 'admin_announcement')?.channels).toEqual([
        'in_app',
        'push',
      ]);
      expect(list.data.flatMap((t) => t.channels)).not.toContain('email');
      expect(list.data.flatMap((t) => t.channels)).not.toContain('sms');

      const preview = (
        await request(server())
          .post(`${V1}/admin/notifications/templates/admin_announcement/preview`)
          .set(auth(token))
          .send({ payload: { title: 'Diwali gifting is open', body: 'Lists for everyone.' } })
          .expect(200)
      ).body as Envelope<{ title: string; text: string; html: string }>;
      expect(preview.data.title).toBe('Diwali gifting is open');
      expect(preview.data.html).toContain('Lists for everyone.');

      await request(server())
        .post(`${V1}/admin/notifications/templates/nonsense/preview`)
        .set(auth(token))
        .send({})
        .expect(404);
    });

    it('edits what a notification says, and the app and pushes say it from then on', async () => {
      const token = await adminToken();
      const path = `${V1}/admin/notifications/templates/memory_reply/wording`;
      type Wording = {
        builtIn: { title: string; body: string };
        saved: { title: string; body: string; updatedBy: string | null } | null;
        fillIns: string[];
        editable: boolean;
      };
      const read = async () =>
        ((await request(server()).get(path).set(auth(token)).expect(200)).body as Envelope<Wording>)
          .data;
      const built = await read();
      expect(built.saved).toBeNull();
      expect(built.builtIn.title).toBe('{authorName|Someone} wrote back');
      expect(built.fillIns).toEqual(expect.arrayContaining(['authorName', 'capsuleTitle']));

      // A fill-in this notification has no detail for is refused.
      const bad = await request(server())
        .put(path)
        .set(auth(token))
        .send({ title: '{guestName} wrote', body: 'Hi', reason: 'Warmer words' })
        .expect(400);
      expect(JSON.stringify(bad.body)).toContain('{guestName}');
      // Support can read the wording but not change it.
      await request(server())
        .put(path)
        .set(auth(await roleToken('support')))
        .send({ title: '{authorName} wrote back', body: 'Hi', reason: 'Warmer words' })
        .expect(403);

      await request(server())
        .put(path)
        .set(auth(token))
        .send({
          title: '{authorName} replied to your wishes 💌',
          body: 'Open the app to read what they said about {capsuleTitle}.',
          reason: 'Warmer words',
        })
        .expect(200);
      expect((await read()).saved).toMatchObject({
        title: '{authorName} replied to your wishes 💌',
      });

      // What the in-app notification and the push are built from.
      const renderer = app.get(NotificationRenderer);
      expect(
        renderer.content(NotificationType.MEMORY_REPLY, {
          authorName: 'Asha',
          capsuleTitle: 'Ravi’s birthday',
        }),
      ).toMatchObject({
        title: 'Asha replied to your wishes 💌',
        text: expect.stringContaining('Open the app to read what they said about Ravi’s birthday.'),
      });
      // A missing detail falls back the way the built-in wording did.
      expect(renderer.content(NotificationType.MEMORY_REPLY, {}).title).toBe(
        'Someone replied to your wishes 💌',
      );
      const list = (
        await request(server()).get(`${V1}/admin/notifications/templates`).set(auth(token))
      ).body as Envelope<{ type: string; edited: boolean; editable: boolean }[]>;
      expect(list.data.find((t) => t.type === 'memory_reply')).toMatchObject({ edited: true });
      expect(list.data.find((t) => t.type === 'admin_announcement')?.editable).toBe(false);

      // Back to the built-in wording.
      await request(server())
        .post(`${path}/reset`)
        .set(auth(token))
        .send({ reason: 'Trying the old words' })
        .expect(200);
      expect((await read()).saved).toBeNull();
      expect(renderer.content(NotificationType.MEMORY_REPLY, { authorName: 'Asha' }).title).toBe(
        'Asha wrote back',
      );
      await request(server())
        .post(`${path}/reset`)
        .set(auth(token))
        .send({ reason: 'Again' })
        .expect(404);

      // An announcement says what is written when it is sent.
      await request(server())
        .put(`${V1}/admin/notifications/templates/admin_announcement/wording`)
        .set(auth(token))
        .send({ title: 'News', body: 'Hi', reason: 'Trying' })
        .expect(400);

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ action: 'notifications.wording_edit' })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string; meta: { reason: string } }[] }>;
      expect(audit.data.items[0]).toMatchObject({
        action: 'notifications.wording_edit',
        meta: { reason: 'Warmer words' },
      });
    });

    it('lets an address receive again, on the record', async () => {
      const token = await adminToken();
      const address = `+9198${String(Date.now()).slice(-8)}`;
      await app.get(NotificationService).suppress(NotificationChannel.SMS, address);

      const listed = (
        await request(server())
          .get(`${V1}/admin/notifications/suppressions`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        revealed: boolean;
        channels: { channel: string; addresses: string[] }[];
      }>;
      expect(listed.data.revealed).toBe(true);
      expect(listed.data.channels.map((c) => c.channel)).toEqual(['sms']);
      expect(listed.data.channels[0].addresses).toContain(address);

      // Support can look, but not change who receives texts.
      await request(server())
        .post(`${V1}/admin/notifications/suppressions/remove`)
        .set(auth(await roleToken('support')))
        .send({ channel: 'sms', address, reason: 'Number works again' })
        .expect(403);

      await request(server())
        .post(`${V1}/admin/notifications/suppressions/remove`)
        .set(auth(token))
        .send({ channel: 'sms', address, reason: 'Number works again' })
        .expect(200);
      expect(
        await app.get(NotificationService).isSuppressedAddress(NotificationChannel.SMS, address),
      ).toBe(false);
      await request(server())
        .post(`${V1}/admin/notifications/suppressions/remove`)
        .set(auth(token))
        .send({ channel: 'sms', address, reason: 'Again' })
        .expect(404);
    });

    it('test-sends one notification to one person', async () => {
      const token = await adminToken();
      const user = await newUser();
      await request(server())
        .post(`${V1}/admin/notifications/test`)
        .set(auth(token))
        .send({
          type: 'admin_announcement',
          userId: user.userId,
          payload: { title: 'Test from ops' },
        })
        .expect(200);
      await ctx.drainNotifications();
      const arrived = await eventually(
        async () =>
          (await db()
            .collection('notifications')
            .countDocuments({
              userId: new Types.ObjectId(user.userId),
              type: 'admin_announcement',
            })) > 0,
      );
      expect(arrived).toBe(true);
      await request(server())
        .post(`${V1}/admin/notifications/test`)
        .set(auth(token))
        .send({ type: 'admin_announcement', userId: DUMMY_ID })
        .expect(404);
    });

    it('offers four plain audiences, counts one, and announces to exactly it', async () => {
      const token = await adminToken();
      const fresh = await newUser();
      const dormant = await newUser();
      // Joined two months ago and not seen since.
      const longAgo = new Date(Date.now() - 60 * 86_400_000);
      await db()
        .collection('users')
        .updateOne(
          { _id: new Types.ObjectId(dormant.userId) },
          { $set: { createdAt: longAgo, lastLoginAt: null } },
        );
      await db()
        .collection('analytics_events')
        .deleteMany({ userId: new Types.ObjectId(dormant.userId) });

      const count = async (audience: string) =>
        (
          (
            await request(server())
              .post(`${V1}/admin/notifications/broadcasts/dry-run`)
              .set(auth(token))
              .send({ audience })
              .expect(200)
          ).body as Envelope<{ count: number }>
        ).data.count;
      const everyone = await count('everyone');
      expect(await count('new')).toBeGreaterThanOrEqual(1);
      expect(await count('inactive')).toBeGreaterThanOrEqual(1);
      expect(await count('new')).toBeLessThanOrEqual(everyone);
      await request(server())
        .post(`${V1}/admin/notifications/broadcasts/dry-run`)
        .set(auth(token))
        .send({ segment: { city: 'Pune' } })
        .expect(400);

      const send = async (audience: string, title: string) => {
        const sent = (
          await request(server())
            .post(`${V1}/admin/notifications/broadcasts`)
            .set(auth(token))
            .send({ title, body: 'Something for you.', audience })
            .expect(201)
        ).body as Envelope<{ id: string; audience: number }>;
        // The fan-out is a scheduler job: queued, then run here as the worker would.
        const job = ctx.scheduler.added.find(
          (j) =>
            j.name === 'admin-broadcast' &&
            (j.data as { broadcastId: string }).broadcastId === sent.data.id,
        );
        expect(job).toBeDefined();
        await app.get(SchedulerRegistry).get('admin-broadcast')!(job!.data);
        await ctx.drainNotifications();
        return sent.data;
      };
      const got = (id: string, title: string) =>
        db()
          .collection('notifications')
          .countDocuments({ userId: new Types.ObjectId(id), type: 'admin_announcement', title });

      await send('inactive', 'We miss you');
      expect(await eventually(async () => (await got(dormant.userId, 'We miss you')) === 1)).toBe(
        true,
      );
      expect(await got(fresh.userId, 'We miss you')).toBe(0);

      await send('new', 'Welcome aboard');
      expect(await eventually(async () => (await got(fresh.userId, 'Welcome aboard')) === 1)).toBe(
        true,
      );
      expect(await got(dormant.userId, 'Welcome aboard')).toBe(0);
    });

    it('carries an uploaded picture to the app, and refuses anything that is not one', async () => {
      const token = await adminToken();
      const user = await newUser();
      // A real 1×1 PNG.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const upload = (body: Buffer, type = 'image/png') =>
        request(server())
          .post(`${V1}/admin/notifications/broadcasts/image`)
          .set(auth(token))
          .set('Content-Type', type)
          .send(body);

      const uploaded = (await upload(png).expect(201)).body as Envelope<{
        imageKey: string;
        imageUrl: string;
      }>;
      expect(uploaded.data.imageKey).toMatch(/^broadcasts\/[0-9a-f-]{36}\.png$/);
      // Text with an image label is still not an image.
      await upload(Buffer.from('<svg onload=alert(1)>'), 'image/png').expect(415);
      // Too big, even with a real PNG header.
      await upload(Buffer.concat([png, Buffer.alloc(1_050_000)])).expect(413);

      await request(server())
        .post(`${V1}/admin/notifications/broadcasts`)
        .set(auth(token))
        .send({
          title: 'Look',
          body: 'A picture.',
          audience: 'new',
          imageKey: 'broadcasts/../../etc/passwd',
        })
        .expect(400);

      const sent = (
        await request(server())
          .post(`${V1}/admin/notifications/broadcasts`)
          .set(auth(token))
          .send({
            title: 'Diwali sale',
            body: 'Lights, gifts, and 20% off.',
            audience: 'new',
            imageKey: uploaded.data.imageKey,
          })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const job = ctx.scheduler.added.find(
        (j) =>
          j.name === 'admin-broadcast' &&
          (j.data as { broadcastId: string }).broadcastId === sent.data.id,
      );
      await app.get(SchedulerRegistry).get('admin-broadcast')!(job!.data);
      await ctx.drainNotifications();
      const note = await eventually(async () =>
        Boolean(
          await db()
            .collection('notifications')
            .findOne({
              userId: new Types.ObjectId(user.userId),
              title: 'Diwali sale',
            }),
        ),
      );
      expect(note).toBe(true);
      const row = await db()
        .collection('notifications')
        .findOne({ userId: new Types.ObjectId(user.userId), title: 'Diwali sale' });
      expect((row!.payload as { imageUrl?: string }).imageUrl).toBe(uploaded.data.imageUrl);

      const list = (
        await request(server())
          .get(`${V1}/admin/notifications/broadcasts`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { id: string; imageUrl: string | null }[] }>;
      expect(list.data.items.find((b) => b.id === sent.data.id)?.imageUrl).toBe(
        uploaded.data.imageUrl,
      );
    });

    it('turns off pushes to one device', async () => {
      const token = await adminToken();
      const user = await newUser();
      const deviceId = new Types.ObjectId();
      await db()
        .collection('device_tokens')
        .insertOne({
          _id: deviceId,
          userId: new Types.ObjectId(user.userId),
          token: `tok-${deviceId.toString()}`,
          platform: 'android',
          deviceName: 'Pixel 8',
          lastSeenAt: new Date(),
          revokedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await request(server())
        .post(`${V1}/admin/notifications/devices/${deviceId.toString()}/actions/revoke`)
        .set(auth(token))
        .send({ reason: 'Lost phone' })
        .expect(200);
      const after = await db().collection('device_tokens').findOne({ _id: deviceId });
      expect(after!.revokedAt).toBeTruthy();
    });
  });

  describe('operations desk', () => {
    const db = () => app.get<Connection>(getConnectionToken()).db!;
    /** Lookups are recorded after the response; give them a moment. */
    const eventually = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('never happened');
    };
    const roleToken = async (role: string): Promise<string> => {
      const email = `${role}-o${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };

    it('lists every queue, and pauses and resumes one on the record', async () => {
      const token = await adminToken();
      const list = (
        await request(server()).get(`${V1}/admin/ops/queues`).set(auth(token)).expect(200)
      ).body as Envelope<{ name: string; paused: boolean; counts: Record<string, number> }[]>;
      expect(list.data.map((q) => q.name)).toEqual(
        expect.arrayContaining(['scheduler', 'notifications']),
      );

      await request(server())
        .post(`${V1}/admin/ops/queues/scheduler/pause`)
        .set(auth(token))
        .send({ paused: true, reason: 'Investigating a stuck job' })
        .expect(200);
      const one = (
        await request(server()).get(`${V1}/admin/ops/queues/scheduler`).set(auth(token)).expect(200)
      ).body as Envelope<{ paused: boolean; state: string; jobs: unknown[] }>;
      expect(one.data.paused).toBe(true);
      expect(one.data.state).toBe('failed');
      await request(server())
        .post(`${V1}/admin/ops/queues/scheduler/pause`)
        .set(auth(token))
        .send({ paused: false, reason: 'Fixed' })
        .expect(200);
      const cleared = (
        await request(server())
          .post(`${V1}/admin/ops/queues/scheduler/clear-failed`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ removed: number }>;
      expect(typeof cleared.data.removed).toBe('number');

      await request(server()).get(`${V1}/admin/ops/queues/nonsense`).set(auth(token)).expect(404);
      // Support has no business with the machinery.
      await request(server())
        .get(`${V1}/admin/ops/queues`)
        .set(auth(await roleToken('support')))
        .expect(403);

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetId: 'scheduler' })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(audit.data.items.map((a) => a.action)).toEqual(
        expect.arrayContaining(['ops.pause_queue', 'ops.resume_queue', 'ops.clear_failed']),
      );
    });

    it('checks the database, Redis and queues', async () => {
      const token = await adminToken();
      const health = (
        await request(server()).get(`${V1}/admin/ops/health`).set(auth(token)).expect(200)
      ).body as Envelope<{ checks: { name: string; ok: boolean }[] }>;
      expect(health.data.checks.map((c) => c.name)).toEqual(['Database', 'Redis', 'Queues']);
      expect(health.data.checks.find((c) => c.name === 'Database')?.ok).toBe(true);
    });

    it('shows product search spending, and counts cache hits apart from misses', async () => {
      const token = await adminToken();
      const user = await newUser();
      // The same search twice: the first goes to the provider, the second is cached.
      for (let i = 0; i < 2; i++) {
        await request(server())
          .get(`${V1}/products/search`)
          .query({ q: `ops check ${seq}` })
          .set(auth(user.token))
          .expect(200);
      }
      const stats = (
        await request(server()).get(`${V1}/admin/ops/product-search`).set(auth(token)).expect(200)
      ).body as Envelope<{
        provider: string;
        breaker: string;
        requests: { thisMonth: number };
        cache: { days: { hits: number; misses: number }[]; hitRate: number | null };
      }>;
      const today = stats.data.cache.days.at(-1)!;
      expect(today.hits).toBeGreaterThanOrEqual(1);
      expect(today.misses).toBeGreaterThanOrEqual(1);
      expect(stats.data.requests.thisMonth).toBeGreaterThanOrEqual(1);
      // Refresh: the same answer, with SerpApi asked again rather than remembered.
      await request(server())
        .get(`${V1}/admin/ops/product-search`)
        .query({ fresh: '1' })
        .set(auth(token))
        .expect(200);
      expect(stats.data.breaker).toBe('closed');

      const budget = (
        await request(server())
          .get(`${V1}/admin/ops/product-search/budget/${user.userId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ spent: number; budget: number }>;
      expect(budget.data.budget).toBe(60);

      await request(server())
        .post(`${V1}/admin/ops/product-search/reset-breaker`)
        .set(auth(token))
        .send({ reason: 'Vendor is back' })
        .expect(200);
    });

    it('breaks a day down by person, and one person by lookup', async () => {
      const token = await adminToken();
      const user = await newUser();
      const words = `day view ${seq}`;
      // Sent to the store, then answered from the cache.
      for (let i = 0; i < 2; i++) {
        await request(server())
          .get(`${V1}/products/search`)
          .query({ q: words })
          .set(auth(user.token))
          .expect(200);
      }
      const uid = new Types.ObjectId(user.userId);
      await eventually(
        async () => (await db().collection('search_lookups').countDocuments({ userId: uid })) === 2,
      );
      await eventually(
        async () => (await db().collection('search_logs').countDocuments({ userId: uid })) === 2,
      );
      await eventually(
        async () =>
          (await db().collection('vendor_requests').countDocuments({ userId: uid })) === 1,
      );
      const day = new Date().toISOString().slice(0, 10);

      const summary = (
        await request(server())
          .get(`${V1}/admin/ops/product-search/days/${day}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        recordedSince: string | null;
        lookups: { total: number; cache: number; store: number };
        byReason: { origin: string; total: number }[];
        people: {
          userId: string;
          typed: number;
          lookups: { total: number; cache: number; store: number };
          why: Record<string, number>;
        }[];
        topSearches: { query: string; searches: number }[];
        sent: {
          answered: number;
          byPurpose: { purpose: string; answered: number }[];
        } | null;
        priceCheckLimit: number;
      }>;
      expect(summary.data.recordedSince).not.toBeNull();
      // What the store was sent, by what for — one search, answered.
      expect(
        summary.data.sent?.byPurpose.find((p) => p.purpose === 'search')?.answered,
      ).toBeGreaterThanOrEqual(1);
      expect(summary.data.priceCheckLimit).toBe(200);
      expect(summary.data.byReason.map((r) => r.origin)).toContain('search');
      expect(summary.data.people.find((p) => p.userId === user.userId)).toMatchObject({
        typed: 2,
        lookups: { total: 2, cache: 1, store: 1 },
        why: { search: 2 },
      });
      expect(summary.data.topSearches.find((t) => t.query === words)?.searches).toBe(2);

      const person = (
        await request(server())
          .get(`${V1}/admin/ops/product-search/days/${day}/people/${user.userId}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        lookups: { origin: string; query: string; answer: string }[];
        typed: { query: string; freshness: string }[];
        requests: { purpose: string; subject: string; outcome: string }[];
        allowance: { budget: number } | null;
      }>;
      expect(person.data.requests.map((r) => [r.purpose, r.subject, r.outcome])).toEqual([
        ['search', words, 'answered'],
      ]);
      expect(person.data.lookups.map((l) => [l.origin, l.query, l.answer])).toEqual([
        ['search', words, 'store'],
        ['search', words, 'cache'],
      ]);
      expect(person.data.typed.map((t) => t.freshness)).toEqual(['live', 'cached']);
      // Today's allowance is known; an earlier day's is not.
      expect(person.data.allowance?.budget).toBe(60);

      await request(server())
        .get(`${V1}/admin/ops/product-search/days/yesterday`)
        .set(auth(token))
        .expect(400);
    });

    it('clears a named cache, and only the named ones', async () => {
      const token = await adminToken();
      await request(server()).get(`${V1}/admin/dashboard`).set(auth(token)).expect(200);
      const cleared = (
        await request(server())
          .post(`${V1}/admin/ops/caches/dashboard/clear`)
          .set(auth(token))
          .send({ reason: 'Numbers looked stale' })
          .expect(200)
      ).body as Envelope<{ removed: number }>;
      expect(cleared.data.removed).toBeGreaterThanOrEqual(1);
      await request(server())
        .post(`${V1}/admin/ops/caches/sessions/clear`)
        .set(auth(token))
        .send({ reason: 'Nope' })
        .expect(404);
    });

    it('lists migrations and the settings, with no secret among them', async () => {
      const token = await adminToken();
      const migrations = (
        await request(server()).get(`${V1}/admin/ops/migrations`).set(auth(token)).expect(200)
      ).body as Envelope<{ id: string; applied: boolean }[]>;
      expect(migrations.data.some((m) => m.id.startsWith('038'))).toBe(true);

      const settings = await request(server())
        .get(`${V1}/admin/ops/settings`)
        .set(auth(token))
        .expect(200);
      const text = JSON.stringify(settings.body).toLowerCase();
      expect(text).toContain('product search');
      for (const secret of ['secret', 'password', 'apikey', 'mongodb://', 'dsn']) {
        expect(text).not.toContain(secret);
      }
    });
  });

  describe('catalogue desk', () => {
    const roleToken = async (role: string): Promise<string> => {
      const email = `${role}-c${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };
    type Term = { id: string; key: string; label: string; active: boolean; uses: number };
    const optionsText = async (): Promise<string> =>
      JSON.stringify((await request(server()).get(`${V1}/onboarding/options`).expect(200)).body);

    it('manages only interests and colours; the rest is set in the app', async () => {
      const token = await adminToken();
      const kinds = (
        await request(server()).get(`${V1}/admin/catalog/taxonomy`).set(auth(token)).expect(200)
      ).body as Envelope<{ kind: string; canAdd: boolean }[]>;
      expect(kinds.data.map((k) => k.kind)).toEqual(['interest_category', 'interest', 'color']);
      expect(kinds.data.find((k) => k.kind === 'color')?.canAdd).toBe(false);
      for (const kind of ['lifestyle', 'fit_preference', 'occasion', 'event_type', 'flavours']) {
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/${kind}`)
          .set(auth(token))
          .expect(404);
      }
    });

    it('adds, relabels, retires and restores an interest category, and the app sees each change', async () => {
      const token = await adminToken();
      await optionsText(); // warm the options cache
      const key = `stargazing_${seq}`;
      const created = (
        await request(server())
          .post(`${V1}/admin/catalog/taxonomy/interest_category`)
          .set(auth(token))
          .send({ key, label: 'Stargazing' })
          .expect(201)
      ).body as Envelope<Term>;
      expect(await optionsText()).toContain('Stargazing');
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest_category`)
        .set(auth(token))
        .send({ key, label: 'Again' })
        .expect(409);

      await request(server())
        .patch(`${V1}/admin/catalog/taxonomy/interest_category/${created.data.id}`)
        .set(auth(token))
        .send({ label: 'Stargazing and astronomy', key: 'ignored' })
        .expect(200);
      let text = await optionsText();
      expect(text).toContain('Stargazing and astronomy');
      expect(text).toContain(key);

      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest_category/${created.data.id}/active`)
        .set(auth(token))
        .send({ active: false, reason: 'Too niche' })
        .expect(200);
      text = await optionsText();
      expect(text).not.toContain(key);
      const list = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/interest_category`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: Term[]; pictures: boolean }>;
      expect(list.data.terms.find((t) => t.key === key)?.active).toBe(false);
      expect(list.data.pictures).toBe(true);

      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest_category/${created.data.id}/active`)
        .set(auth(token))
        .send({ active: true })
        .expect(200);
      expect(await optionsText()).toContain(key);

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetId: created.data.id })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(audit.data.items.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'catalog.add_option',
          'catalog.edit_option',
          'catalog.retire_option',
          'catalog.restore_option',
        ]),
      );
    });

    it('keeps sub-interests under a category, and lets one move to another', async () => {
      const token = await adminToken();
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest`)
        .set(auth(token))
        .send({ key: `x_${seq}`, label: 'No category' })
        .expect(400);
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest`)
        .set(auth(token))
        .send({ key: `x_${seq}`, label: 'Bad category', meta: { category: 'nonsense' } })
        .expect(400);
      const interests = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/interest`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ choices: Record<string, { value: string }[]> }>;
      const [first, second] = interests.data.choices.category.map((c) => c.value);
      const kites = (
        await request(server())
          .post(`${V1}/admin/catalog/taxonomy/interest`)
          .set(auth(token))
          .send({ key: `${first}_kites_${seq}`, label: 'Kites', meta: { category: first } })
          .expect(201)
      ).body as Envelope<Term & { meta: Record<string, string> }>;
      const moved = (
        await request(server())
          .patch(`${V1}/admin/catalog/taxonomy/interest/${kites.data.id}`)
          .set(auth(token))
          .send({ meta: { category: second } })
          .expect(200)
      ).body as Envelope<{ meta: Record<string, string> }>;
      expect(moved.data.meta.category).toBe(second);
    });

    it('lets colours be renamed, recoloured and moved between groups — never added or retired', async () => {
      const token = await adminToken();
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/color`)
        .set(auth(token))
        .send({ key: `c_${seq}`, label: 'New', meta: { hex: '#123456', group: 'red' } })
        .expect(400);
      const colours = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/color`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        terms: (Term & { meta: Record<string, string> })[];
        choices: Record<string, { value: string; label: string }[]>;
        canAdd: boolean;
        canRetire: boolean;
      }>;
      expect(colours.data).toMatchObject({ canAdd: false, canRetire: false });
      const groups = colours.data.choices.group;
      expect(groups.length).toBeGreaterThan(1);
      const colour = colours.data.terms[0];
      const target = groups.find((g) => g.value !== colour.meta.group)!;
      const path = `${V1}/admin/catalog/taxonomy/color/${colour.id}`;
      await request(server())
        .patch(path)
        .set(auth(token))
        .send({ meta: { hex: 'red' } })
        .expect(400);
      await request(server())
        .patch(path)
        .set(auth(token))
        .send({ meta: { group: 'no_such_group' } })
        .expect(400);
      const changed = (
        await request(server())
          .patch(path)
          .set(auth(token))
          .send({ label: 'Deep sea', meta: { hex: '#0A3D62', group: target.value } })
          .expect(200)
      ).body as Envelope<{ label: string; meta: Record<string, string> }>;
      // Moved, and named for its new group.
      expect(changed.data.meta).toMatchObject({
        hex: '#0A3D62',
        group: target.value,
        groupLabel: target.label,
      });
      await request(server())
        .post(`${path}/active`)
        .set(auth(token))
        .send({ active: false })
        .expect(400);
      // Put it back for the rest of the suite.
      await request(server())
        .patch(path)
        .set(auth(token))
        .send({ label: colour.label, meta: { hex: colour.meta.hex, group: colour.meta.group } })
        .expect(200);
    });

    it('gives interests and categories a WebP picture the app is sent, and takes it away', async () => {
      const token = await adminToken();
      const categories = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/interest_category`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: (Term & { meta: Record<string, string> })[] }>;
      const category = categories.data.terms.find((t) => t.active)!;
      const path = `${V1}/admin/catalog/taxonomy/interest_category/${category.id}/picture`;
      const webp = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBPVP8 '),
        Buffer.alloc(32, 1),
      ]);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      await request(server())
        .post(path)
        .set(auth(token))
        .set('Content-Type', 'image/png')
        .send(png)
        .expect(415);
      const set = (
        await request(server())
          .post(path)
          .set(auth(token))
          .set('Content-Type', 'image/webp')
          .send(webp)
          .expect(200)
      ).body as Envelope<{ meta: Record<string, string> }>;
      const url = set.data.meta.imageUrl;
      expect(url).toMatch(/taxonomy\/interest_category\/.+\.webp/);
      expect(await optionsText()).toContain(url);
      const storage = app.get<IStorageProvider>(STORAGE);
      const stored = async (u: string) => (await storage.head(storage.keyFromPublicUrl(u)!)).exists;
      expect(await stored(url)).toBe(true);

      // Relabelling keeps the picture.
      await request(server())
        .patch(`${V1}/admin/catalog/taxonomy/interest_category/${category.id}`)
        .set(auth(token))
        .send({ label: category.label, meta: {} })
        .expect(200);
      expect(await optionsText()).toContain(url);

      await request(server())
        .post(`${path}/remove`)
        .set(auth(token))
        .send({ reason: 'Wrong picture' })
        .expect(200);
      expect(await optionsText()).not.toContain(url);
      // Taken out of storage with it.
      expect(await stored(url)).toBe(false);

      // A second picture replaces the first, which leaves storage.
      const pictureUrl = async () =>
        (
          (
            await request(server())
              .post(path)
              .set(auth(token))
              .set('Content-Type', 'image/webp')
              .send(webp)
              .expect(200)
          ).body as Envelope<{ meta: Record<string, string> }>
        ).data.meta.imageUrl;
      const first = await pictureUrl();
      const second = await pictureUrl();
      expect(await stored(first)).toBe(false);
      expect(await stored(second)).toBe(true);
      await request(server())
        .post(`${path}/remove`)
        .set(auth(token))
        .send({ reason: 'Tidy' })
        .expect(200);

      // Colours have no pictures.
      const colour = (
        (
          await request(server())
            .get(`${V1}/admin/catalog/taxonomy/color`)
            .set(auth(token))
            .expect(200)
        ).body as Envelope<{ terms: Term[] }>
      ).data.terms[0];
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/color/${colour.id}/picture`)
        .set(auth(token))
        .set('Content-Type', 'image/webp')
        .send(webp)
        .expect(400);
    });

    it('reorders options, counts their use, and lets only catalogue managers change them', async () => {
      const token = await adminToken();
      const user = await newUser();
      const before = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/interest_category`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: Term[] }>;
      const picked = before.data.terms[0];
      await request(server())
        .patch(`${V1}/me/preferences`)
        .set(auth(user.token))
        .send({ interestCategories: [picked.key] })
        .expect(200);

      const reversed = [...before.data.terms].reverse().map((t) => t.id);
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest_category/reorder`)
        .set(auth(token))
        .send({ ids: reversed })
        .expect(200);
      const after = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/interest_category`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: Term[] }>;
      expect(after.data.terms.map((t) => t.id)).toEqual(reversed);
      expect(after.data.terms.find((t) => t.id === picked.id)!.uses).toBeGreaterThanOrEqual(1);
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest_category/reorder`)
        .set(auth(token))
        .send({ ids: before.data.terms.map((t) => t.id) })
        .expect(200);

      const support = await roleToken('support');
      await request(server())
        .get(`${V1}/admin/catalog/taxonomy/interest_category`)
        .set(auth(support))
        .expect(200);
      await request(server())
        .patch(`${V1}/admin/catalog/taxonomy/interest_category/${picked.id}`)
        .set(auth(support))
        .send({ label: 'Nope' })
        .expect(403);
    });

    it('browses products with their sellers and stores, and refreshes one on the record', async () => {
      const token = await adminToken();
      const user = await newUser();
      await request(server())
        .get(`${V1}/products/search`)
        .query({ q: 'headphones' })
        .set(auth(user.token))
        .expect(200);

      const list = (
        await request(server())
          .get(`${V1}/admin/catalog/products`)
          .query({ sort: 'synced' })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        items: { id: string; title: string; provider: string; trust: number }[];
        total: number;
      }>;
      expect(list.data.total).toBeGreaterThan(0);
      const product = list.data.items[0];
      expect([0, 1, 2]).toContain(product.trust);

      const providers = (
        await request(server())
          .get(`${V1}/admin/catalog/products/facets/provider`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<string[]>;
      expect(providers.data).toContain(product.provider);

      const detail = (
        await request(server())
          .get(`${V1}/admin/catalog/products/${product.id}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ sections: { key: string }[] }>;
      expect(detail.data.sections.map((s) => s.key)).toEqual(['offers', 'items', 'clicks']);

      const refreshed = (
        await request(server())
          .post(`${V1}/admin/catalog/products/${product.id}/actions/refresh`)
          .set(auth(token))
          .send({ reason: 'Price looked wrong' })
          .expect(200)
      ).body as Envelope<{ result: { freshness: string } }>;
      expect(refreshed.data.result.freshness).toBeTruthy();
      await request(server())
        .post(`${V1}/admin/catalog/products/${product.id}/actions/delete`)
        .set(auth(token))
        .send({ reason: 'Nope' })
        .expect(400);

      const stores = (
        await request(server()).get(`${V1}/admin/catalog/stores`).set(auth(token)).expect(200)
      ).body as Envelope<{ trusted: string[]; resellers: string[]; merchants: unknown[] }>;
      expect(stores.data.trusted).toContain('amazon');
      expect(stores.data.resellers).toContain('ubuy');

      const csv = await request(server())
        .get(`${V1}/admin/catalog/products/export`)
        .set(auth(token))
        .expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text).toContain(product.id);
    });
  });

  describe('blog desk', () => {
    const roleToken = async (role: string): Promise<string> => {
      const email = `${role}-b${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };
    type Post = {
      id: string;
      slug: string;
      status: string;
      excerpt: string;
      contentHtml: string;
      previousSlugs: string[];
      coverUrl: string | null;
    };
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.alloc(32),
    ]);

    // The website's /api/revalidate, as the blog calls it.
    let revalidations: { url: string; secret: string | null; tags: string[] }[] = [];
    beforeEach(() => {
      revalidations = [];
      jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
        const headers = new Headers(init?.headers);
        revalidations.push({
          url: input instanceof Request ? input.url : input.toString(),
          secret: headers.get('x-revalidate-secret'),
          tags: (
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { tags: string[] }
          ).tags,
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
    });
    afterEach(() => jest.restoreAllMocks());

    const create = async (token: string, body: Record<string, unknown>) =>
      (
        (
          await request(server())
            .post(`${V1}/admin/blog/posts`)
            .set(auth(token))
            .send(body)
            .expect(201)
        ).body as Envelope<Post>
      ).data;
    const publicPost = (slug: string) => request(server()).get(`${V1}/public/blog/posts/${slug}`);
    const publicSlugs = async (): Promise<string[]> =>
      (
        (await request(server()).get(`${V1}/public/blog/posts`).expect(200)).body as Envelope<{
          items: { slug: string }[];
        }>
      ).data.items.map((p) => p.slug);

    it('writes a draft, publishes it, serves it, and keeps scripts out of the body', async () => {
      const token = await adminToken();
      const title = `Gift ideas ${seq} for Diwali`;
      const post = await create(token, {
        title,
        contentHtml:
          '<h1>Big lights</h1><p>Hello <strong>world</strong><script>alert(1)</script></p>' +
          '<img src="https://evil.example/x.png" onerror="alert(1)">' +
          '<p><a href="https://example.com" onclick="steal()">a shop</a></p>',
      });
      expect(post.status).toBe('draft');
      expect(post.slug).toBe(`gift-ideas-${seq}-for-diwali`);
      expect(post.contentHtml).not.toMatch(/script|onerror|onclick|evil\.example|<h1/);
      expect(post.contentHtml).toContain('<h2>Big lights</h2>');
      expect(post.contentHtml).toContain('rel="noopener noreferrer nofollow"');

      // A draft is nobody's business but the panel's.
      expect(await publicSlugs()).not.toContain(post.slug);
      await publicPost(post.slug).expect(404);
      expect(revalidations).toHaveLength(0);

      const live = (
        (
          await request(server())
            .post(`${V1}/admin/blog/posts/${post.id}/publish`)
            .set(auth(token))
            .send({})
            .expect(200)
        ).body as Envelope<Post>
      ).data;
      expect(live.status).toBe('published');
      // Published without a summary: introduced by its first words.
      expect(live.excerpt).toContain('Big lights');
      expect(await publicSlugs()).toContain(post.slug);
      const served = (await publicPost(post.slug).expect(200)).body as Envelope<{
        post: { title: string; contentHtml: string };
      }>;
      expect(served.data.post.title).toBe(title);
      expect(served.data.post.contentHtml).toContain('<strong>world</strong>');
      // …and the website was told, with the shared secret.
      expect(revalidations.at(-1)).toEqual({
        url: 'http://web.test/api/revalidate',
        secret: 'test-revalidate-secret',
        tags: ['blog', `blog-post:${post.slug}`],
      });

      // A new address keeps the old one working.
      const renamed = `diwali-gifts-${seq}`;
      await request(server())
        .patch(`${V1}/admin/blog/posts/${post.id}`)
        .set(auth(token))
        .send({ slug: renamed })
        .expect(200);
      const moved = (await publicPost(post.slug).expect(200)).body as Envelope<{
        redirectTo: string;
      }>;
      expect(moved.data.redirectTo).toBe(renamed);
      expect(revalidations.at(-1)?.tags).toEqual(
        expect.arrayContaining([`blog-post:${renamed}`, `blog-post:${post.slug}`]),
      );

      await request(server())
        .post(`${V1}/admin/blog/posts/${post.id}/unpublish`)
        .set(auth(token))
        .expect(200);
      await publicPost(renamed).expect(404);

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetId: post.id })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(audit.data.items.map((a) => a.action)).toEqual(
        expect.arrayContaining(['blog.create', 'blog.publish', 'blog.edit', 'blog.unpublish']),
      );
    });

    it('schedules a post, and the sweep publishes it when its time comes', async () => {
      const token = await adminToken();
      const post = await create(token, {
        title: `Coming soon ${seq}`,
        contentHtml: '<p>Soon.</p>',
      });
      const scheduled = (
        (
          await request(server())
            .post(`${V1}/admin/blog/posts/${post.id}/publish`)
            .set(auth(token))
            .send({ publishAt: new Date(Date.now() + 3_600_000).toISOString() })
            .expect(200)
        ).body as Envelope<Post>
      ).data;
      expect(scheduled.status).toBe('scheduled');
      expect(await publicSlugs()).not.toContain(post.slug);

      await app
        .get<Connection>(getConnectionToken())
        .db!.collection('blog_posts')
        .updateOne(
          { _id: new Types.ObjectId(post.id) },
          { $set: { publishAt: new Date(Date.now() - 1_000) } },
        );
      expect(await app.get(BlogService).publishDue()).toBeGreaterThanOrEqual(1);
      expect(await publicSlugs()).toContain(post.slug);
    });

    it('takes WebP pictures only, and a cover must be one of ours', async () => {
      const token = await adminToken();
      await request(server())
        .post(`${V1}/admin/blog/images`)
        .set(auth(token))
        .set('Content-Type', 'image/png')
        .send(Buffer.from('\x89PNG\r\n\x1a\nnot really'))
        .expect(415);
      const { url } = (
        (
          await request(server())
            .post(`${V1}/admin/blog/images`)
            .set(auth(token))
            .set('Content-Type', 'image/webp')
            .send(webp)
            .expect(200)
        ).body as Envelope<{ url: string }>
      ).data;
      expect(url).toMatch(/\/blog\/[0-9a-f-]+\.webp$/);

      await request(server())
        .post(`${V1}/admin/blog/posts`)
        .set(auth(token))
        .send({ title: 'Borrowed cover', coverUrl: 'https://evil.example/x.webp' })
        .expect(400);
      const post = await create(token, {
        title: `Our cover ${seq}`,
        coverUrl: url,
        contentHtml: `<p>Look:</p><img src="${url}" alt="a gift">`,
      });
      expect(post.coverUrl).toBe(url);
      expect(post.contentHtml).toContain(`<img src="${url}" alt="a gift" />`);
    });

    it('a picture leaves storage once no post shows it', async () => {
      const token = await adminToken();
      const storage = app.get<IStorageProvider>(STORAGE);
      const stored = async (url: string) =>
        (await storage.head(storage.keyFromPublicUrl(url)!)).exists;
      const image = async () =>
        (
          (
            await request(server())
              .post(`${V1}/admin/blog/images`)
              .set(auth(token))
              .set('Content-Type', 'image/webp')
              .send(webp)
              .expect(200)
          ).body as Envelope<{ url: string }>
        ).data.url;
      const cover = await image();
      const inside = await image();
      const post = await create(token, {
        title: `Pictures ${seq}`,
        coverUrl: cover,
        contentHtml: `<p>Hi</p><img src="${inside}" alt="x">`,
      });
      // Another post shows the same cover in its body.
      const other = await create(token, {
        title: `Borrowing ${seq}`,
        contentHtml: `<img src="${cover}" alt="y">`,
      });

      // Taken out of the body: gone. The cover stays.
      await request(server())
        .patch(`${V1}/admin/blog/posts/${post.id}`)
        .set(auth(token))
        .send({ contentHtml: '<p>Hi</p>' })
        .expect(200);
      expect(await stored(inside)).toBe(false);
      expect(await stored(cover)).toBe(true);

      // The post deleted: its cover is still in the other post, so it stays...
      await request(server())
        .post(`${V1}/admin/blog/posts/${post.id}/remove`)
        .set(auth(token))
        .send({ reason: 'Test' })
        .expect(200);
      expect(await stored(cover)).toBe(true);

      // ...until that one goes too.
      await request(server())
        .post(`${V1}/admin/blog/posts/${other.id}/remove`)
        .set(auth(token))
        .send({ reason: 'Test' })
        .expect(200);
      expect(await stored(cover)).toBe(false);
    });

    it('keeps addresses unique: a chosen one must be free, a made one gets a number', async () => {
      const token = await adminToken();
      const first = await create(token, { title: `Same name ${seq}` });
      const second = await create(token, { title: `Same name ${seq}` });
      expect(second.slug).toBe(`${first.slug}-2`);
      await request(server())
        .post(`${V1}/admin/blog/posts`)
        .set(auth(token))
        .send({ title: 'Clash', slug: first.slug })
        .expect(409);
    });

    it('a content editor manages the blog and nothing else; support cannot touch it', async () => {
      const editor = await roleToken('content_editor');
      await request(server()).get(`${V1}/admin/blog/posts`).set(auth(editor)).expect(200);
      await create(editor, { title: `Written by an editor ${seq}` });
      await request(server()).get(`${V1}/admin/users`).set(auth(editor)).expect(403);

      const support = await roleToken('support');
      await request(server()).get(`${V1}/admin/blog/posts`).set(auth(support)).expect(403);
    });
  });

  describe('analytics insights', () => {
    const db = () => app.get<Connection>(getConnectionToken()).db!;
    const today = () => new Date().toISOString().slice(0, 10);
    const roleToken = async (role: string): Promise<string> => {
      const email = `${role}-i${++seq}-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: role, roles: [role] })
        .expect(201);
      return signIn(email, password);
    };
    // One sign-in for the reads below: a sign-in per read trips the login throttle.
    let readToken: string | null = null;
    const get = async <T>(path: string, query: Record<string, string> = {}): Promise<T> =>
      (
        (
          await request(server())
            .get(`${V1}/admin/analytics/${path}`)
            .query(query)
            .set(auth((readToken ??= await adminToken())))
            .expect(200)
        ).body as Envelope<T>
      ).data;
    /** Listeners record after the response; give them a moment. */
    const eventually = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 40; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('never happened');
    };
    const clearCache = async () =>
      request(server())
        .post(`${V1}/admin/ops/caches/analytics/clear`)
        .set(auth(await adminToken()))
        .send({ reason: 'fresh numbers for the test' })
        .expect(200);
    const idem = () => ({ 'Idempotency-Key': `idem-${randomUUID()}` });

    it('follows signups through onboarding, a wishlist, an item and a shared link', async () => {
      await adminToken();
      const owner = await newUser();
      const visitor = await newUser();
      await db()
        .collection('user_profiles')
        .updateOne(
          { userId: new Types.ObjectId(owner.userId) },
          { $set: { onboardingCompletedAt: new Date() } },
          { upsert: true },
        );
      const list = (
        await request(server())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: `Funnel list ${seq}`, visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string; share?: { slug: string } }>;
      await request(server())
        .post(`${V1}/wishlists/${list.data.id}/items`)
        .set(auth(owner.token))
        .send({ title: 'Kite' })
        .expect(201);
      // The owner opening their own link is not a share.
      await request(server())
        .get(`${V1}/public/wishlists/${list.data.share!.slug}`)
        .set(auth(owner.token))
        .expect(200);
      await request(server())
        .get(`${V1}/public/wishlists/${list.data.share!.slug}`)
        .set(auth(visitor.token))
        .expect(200);
      await eventually(
        async () =>
          (await eventModel.countDocuments({
            name: 'wishlist_link_opened',
            'props.ownerId': owner.userId,
          })) === 1,
      );

      await clearCache();
      const funnel = await get<{
        steps: { key: string; users: number; ofStart: number | null }[];
        sharedSince: string | null;
      }>('funnel', { from: today(), to: today() });
      const step = (k: string) => funnel.steps.find((s) => s.key === k)!;
      expect(funnel.steps.map((s) => s.key)).toEqual([
        'signed_up',
        'onboarded',
        'wishlist',
        'item',
        'shared',
      ]);
      expect(step('signed_up').users).toBeGreaterThanOrEqual(2);
      for (const k of ['onboarded', 'wishlist', 'item', 'shared']) {
        expect(step(k).users).toBeGreaterThanOrEqual(1);
      }
      expect(step('shared').users).toBeLessThanOrEqual(step('signed_up').users);
      expect(funnel.sharedSince).not.toBeNull();

      // Each step opens on the people it counts — as many as the number says.
      type People = {
        total: number;
        items: { id: string; name: string | null; at: string | null }[];
      };
      const peopleAt = (metric: string, extra: Record<string, string> = {}) =>
        get<People>('people', { metric, from: today(), to: today(), limit: '100', ...extra });
      for (const k of ['signed_up', 'onboarded', 'wishlist', 'item', 'shared']) {
        const people = await peopleAt(`funnel.${k}`);
        expect(people.total).toBe(step(k).users);
        expect(people.items.map((p) => p.id)).toContain(owner.userId);
      }
      const shared = await peopleAt('funnel.shared');
      expect(shared.items.map((p) => p.id)).not.toContain(visitor.userId);
      expect(shared.items.find((p) => p.id === owner.userId)?.name).toBeTruthy();
    });

    it('logs what people search for, and who, and whether the cache answered', async () => {
      const token = await adminToken();
      const searcher = await newUser();
      const words = `Bluetooth Speaker ${seq}`;
      // The same words twice (the second from the cache), in different case and
      // spacing, then something else — and a second page, which is not a new search.
      for (const q of [words, `  ${words.toUpperCase()}  `, `lamp ${seq}`]) {
        await request(server())
          .get(`${V1}/products/search`)
          .query({ q })
          .set(auth(searcher.token))
          .expect(200);
      }
      await request(server())
        .get(`${V1}/products/search`)
        .query({ q: `lamp ${seq}`, page: 2 })
        .set(auth(searcher.token))
        .expect(200);
      const mine = () =>
        db()
          .collection('search_logs')
          .countDocuments({ userId: new Types.ObjectId(searcher.userId) });
      await eventually(async () => (await mine()) === 3);

      await clearCache();
      const range = { from: today(), to: today() };
      const activity = await get<{
        searches: number;
        people: number;
        fromCache: number;
        topSearches: { query: string; searches: number; people: number }[];
        topSearchers: { id: string; searches: number }[];
      }>('search-activity', range);
      expect(activity.searches).toBeGreaterThanOrEqual(3);
      expect(activity.fromCache).toBeGreaterThanOrEqual(1);
      expect(
        activity.topSearches.find((t) => t.query.toLowerCase() === words.toLowerCase()),
      ).toMatchObject({ searches: 2, people: 1 });
      expect(activity.topSearchers.find((s) => s.id === searcher.userId)?.searches).toBe(3);

      const log = await get<{ total: number; items: { query: string; freshness: string }[] }>(
        'search-activity/log',
        { user: searcher.userId },
      );
      expect(log.total).toBe(3);
      expect(log.items.map((i) => i.freshness)).toContain('cached');

      const who = await get<{ items: { id: string; times: number }[] }>('people', {
        metric: 'searches.term',
        term: words,
        ...range,
      });
      expect(who.items).toEqual([expect.objectContaining({ id: searcher.userId, times: 2 })]);

      const history = (
        (
          await request(server())
            .get(`${V1}/admin/users/${searcher.userId}/sections/searches`)
            .set(auth(token))
            .expect(200)
        ).body as Envelope<{ items: { query: string }[] }>
      ).data;
      expect(history.items).toHaveLength(3);
      expect(history.items[0].query).toBe(`lamp ${seq}`);
    });

    it('lists the people behind gifting, delivery and activity numbers', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const gifter = await newUser();
      const list = (
        (
          await request(server())
            .post(`${V1}/wishlists`)
            .set(auth(owner.token))
            .send({ title: `People list ${seq}`, visibility: WishlistVisibility.PUBLIC })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      const item = (
        (
          await request(server())
            .post(`${V1}/wishlists/${list}/items`)
            .set(auth(owner.token))
            .send({ title: 'Lamp', price: { amountMinor: 99900 } })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      await request(server())
        .post(`${V1}/items/${item}/reserve`)
        .set(auth(gifter.token))
        .set(idem())
        .send({})
        .expect(201);
      await db()
        .collection('delivery_logs')
        .insertMany(
          (['push', 'sms'] as const).map((channel, i) => ({
            userId: new Types.ObjectId(owner.userId),
            type: 'gift_reserved',
            channel,
            refId: `people-${seq}`,
            dedupeKey: `people-${seq}-${i}-${Date.now()}`,
            status: 'failed',
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );

      const range = { from: today(), to: today() };
      await clearCache();
      const gifting = await get<{ reserved: number }>('gifting', range);
      const reserved = await get<{ total: number; items: { id: string }[] }>('people', {
        metric: 'gifting.reserved',
        ...range,
        limit: '100',
      });
      expect(reserved.total).toBeLessThanOrEqual(gifting.reserved);
      expect(reserved.items.map((p) => p.id)).toContain(gifter.userId);

      // Engagement counts the new rows, and each opens on the people behind it.
      const engagement = await get<Record<string, number>>('engagement', range);
      for (const key of [
        'wishlistsPublic',
        'itemsAdded',
        'giftsReserved',
        'invitesSent',
        'wishlistChatMessages',
        'groupGiftChatMessages',
        'giftsPurchased',
        'giftsBoughtOffline',
        'itemsDelivered',
        'reelWishes',
        'reelsOpenedFromLink',
      ]) {
        expect(typeof engagement[key]).toBe('number');
      }
      expect(engagement.itemsAdded).toBeGreaterThanOrEqual(1);
      expect(engagement.giftsReserved).toBeGreaterThanOrEqual(1);
      for (const [metric, who] of [
        ['created.itemsAdded', owner.userId],
        ['created.wishlistsPublic', owner.userId],
        ['created.giftsReserved', gifter.userId],
      ] as const) {
        const page = await get<{ total: number; items: { id: string }[] }>('people', {
          metric,
          ...range,
          limit: '100',
        });
        expect(page.items.map((p) => p.id)).toContain(who);
      }
      const added = await get<{ total: number }>('people', {
        metric: 'created.itemsAdded',
        ...range,
        limit: '100',
      });
      expect(added.total).toBeLessThanOrEqual(engagement.itemsAdded);

      const failedPush = await get<{ items: { id: string }[] }>('people', {
        metric: 'deliveries.failed',
        channel: 'push',
        ...range,
        limit: '100',
      });
      expect(failedPush.items.map((p) => p.id)).toContain(owner.userId);
      // SMS is not a channel Wishtick sends on.
      const sms = await get<{ total: number }>('people', {
        metric: 'deliveries.failed',
        channel: 'sms',
        ...range,
      });
      expect(sms.total).toBe(0);

      // A cohort's members, and nonsense refused.
      const monday = new Date();
      monday.setUTCHours(0, 0, 0, 0);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const cohort = await get<{ items: { id: string }[] }>('people', {
        metric: 'retention.cohort',
        week: monday.toISOString().slice(0, 10),
        k: '0',
        limit: '100',
      });
      expect(cohort.items.map((p) => p.id)).toEqual(
        expect.arrayContaining([owner.userId, gifter.userId]),
      );
      await request(server())
        .get(`${V1}/admin/analytics/people`)
        .query({ metric: 'gifting.exploded' })
        .set(auth(token))
        .expect(400);
    });

    it('counts a person active once a day however often they sign in, and builds cohorts', async () => {
      const email = `active-${++seq}.${Date.now()}@example.com`;
      const { user } = await authService.signup(
        { email, password: PASSWORD, name: 'Active' },
        { ip: '127.0.0.1', userAgent: 'e2e' },
      );
      for (let i = 0; i < 3; i++) {
        await authService.login(
          { identifier: email, password: PASSWORD },
          { ip: '127.0.0.1', userAgent: 'e2e' },
        );
      }
      await eventually(
        async () =>
          (await eventModel.countDocuments({
            name: 'active',
            userId: new Types.ObjectId(user.id),
          })) >= 1,
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(
        await eventModel.countDocuments({ name: 'active', userId: new Types.ObjectId(user.id) }),
      ).toBe(1);

      await clearCache();
      const retention = await get<{
        cohorts: { week: string; size: number; weeks: (number | null)[]; d1: number | null }[];
        overall: { d1: number | null };
        activeSince: string | null;
      }>('retention', { weeks: '4' });
      expect(retention.cohorts).toHaveLength(4);
      const latest = retention.cohorts.at(-1)!;
      expect(latest.size).toBeGreaterThanOrEqual(1);
      // A week that has not happened yet is unknown, not zero.
      expect(latest.weeks).toEqual([]);
      expect(latest.d1).toBeNull();
      expect(retention.cohorts[0].weeks).toHaveLength(3);
      expect(retention.activeSince).not.toBeNull();

      // Signed in three times today, recorded as active once.
      expect(
        await eventModel.countDocuments({ name: 'active', userId: new Types.ObjectId(user.id) }),
      ).toBe(1);
      // The raw event stream is no longer part of the panel.
      await request(server())
        .get(`${V1}/admin/analytics/raw`)
        .set(auth(await adminToken()))
        .expect(404);
    });

    it('reports gifting, group gifts, events and notifications for a range', async () => {
      const owner = await newUser();
      const gifter = await newUser();
      const list = (
        await request(server())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: `Gifting list ${seq}`, visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const itemId = (
        (
          await request(server())
            .post(`${V1}/wishlists/${list.data.id}/items`)
            .set(auth(owner.token))
            .send({ title: 'Teapot' })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      const giftId = (
        (
          await request(server())
            .post(`${V1}/items/${itemId}/reserve`)
            .set(auth(gifter.token))
            .set(idem())
            .send({})
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;
      await request(server())
        .post(`${V1}/gifts/${giftId}/purchase`)
        .set(auth(gifter.token))
        .set(idem())
        .send({})
        .expect(200);

      await clearCache();
      const range = { from: today(), to: today() };
      const gifting = await get<{
        reserved: number;
        purchased: number;
        purchaseRate: number | null;
        days: { day: string; reserved: number }[];
      }>('gifting', range);
      expect(gifting.reserved).toBeGreaterThanOrEqual(1);
      expect(gifting.purchased).toBeGreaterThanOrEqual(1);
      expect(gifting.purchaseRate).not.toBeNull();
      expect(gifting.days.at(-1)).toMatchObject({ day: today() });

      const group = await get<{ started: number; fundedRate: number | null }>('group-gifts', range);
      expect(typeof group.started).toBe('number');
      const events = await get<{ created: number; replies: Record<string, number> }>(
        'occasions',
        range,
      );
      expect(events.replies).toEqual(expect.objectContaining({ yes: expect.any(Number) }));
      const channels = await get<{ channel: string; sent: number }[]>('notifications', range);
      expect(Array.isArray(channels)).toBe(true);
    });

    it('counts searches, empty results, store tabs and paid calls per day', async () => {
      const user = await newUser();
      const search = (query: Record<string, string>) =>
        request(server())
          .get(`${V1}/products/search`)
          .query(query)
          .set(auth(user.token))
          .expect(200);
      await search({ q: 'headphones' });
      await search({ q: `nothing-matches-this-${seq}` });
      await search({ q: 'headphones', platform: 'amazon' });

      await clearCache();
      const stats = await get<{
        days: { day: string; searches: number; empty: number; providerCalls: number }[];
        totals: { searches: number; empty: number; emptyRate: number | null };
        platforms: { platform: string; searches: number }[];
      }>('search', { from: today(), to: today() });
      const day = stats.days.at(-1)!;
      expect(day.day).toBe(today());
      expect(day.searches).toBeGreaterThanOrEqual(2);
      expect(day.empty).toBeGreaterThanOrEqual(1);
      expect(day.providerCalls).toBeGreaterThanOrEqual(1);
      expect(stats.platforms.find((p) => p.platform === 'amazon')?.searches).toBeGreaterThanOrEqual(
        1,
      );
    });

    it('is for analytics:view only', async () => {
      await request(server())
        .get(`${V1}/admin/analytics/funnel`)
        .set(auth(await roleToken('support')))
        .expect(403);
      await request(server())
        .get(`${V1}/admin/analytics/funnel`)
        .set(auth(await roleToken('analyst')))
        .expect(200);
      await request(server())
        .get(`${V1}/admin/analytics/retention`)
        .query({ weeks: 99 })
        .set(auth(await adminToken()))
        .expect(400);
    });
  });

  describe('governance', () => {
    const password = 'a-long-enough-password';
    // Sign the super admin in once: every sign-in counts against the login throttle.
    let superToken: string | undefined;
    const su = async () => (superToken ??= await adminToken());
    const makeAdmin = async (role: string, ipAllowlist?: string[]) => {
      const email = `${role}-g${++seq}-${Date.now()}@wishtick.test`;
      const created = (
        await request(server())
          .post(`${V1}/admin/admins`)
          .set(auth(await su()))
          .send({ email, password, name: `Gov ${role}`, roles: [role], ipAllowlist })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      return { id: created.data.id, email };
    };
    const me = (token: string) => request(server()).get(`${V1}/admin/auth/me`).set(auth(token));
    type Sessions = {
      active: { id: string; ip: string | null; userAgent: string | null; active: boolean }[];
      recent: { id: string; endedReason: string | null; endedBy: string | null }[];
    };
    const sessionsOf = async (id: string) =>
      (
        (
          await request(server())
            .get(`${V1}/admin/admins/${id}/sessions`)
            .set(auth(await su()))
            .expect(200)
        ).body as Envelope<Sessions>
      ).data;
    const auditFor = async (targetId: string) =>
      (
        (
          await request(server())
            .get(`${V1}/admin/audit`)
            .query({ targetId })
            .set(auth(await su()))
            .expect(200)
        ).body as Envelope<{ items: { action: string }[] }>
      ).data.items.map((a) => a.action);

    it('records each sign-in as a session, and ends one or all of them on the record', async () => {
      const mod = await makeAdmin('moderator');
      const first = await signIn(mod.email, password);
      const second = await signIn(mod.email, password);
      let sessions = await sessionsOf(mod.id);
      expect(sessions.active).toHaveLength(2);
      expect(sessions.active[0].ip).toBeTruthy();

      // End the older one: its token stops, the newer one carries on.
      const older = sessions.active[1];
      await request(server())
        .post(`${V1}/admin/admins/${mod.id}/sessions/${older.id}/end`)
        .set(auth(await su()))
        .expect(200);
      await me(first).expect(401);
      await me(second).expect(200);
      await request(server())
        .post(`${V1}/admin/admins/${mod.id}/sessions/${older.id}/end`)
        .set(auth(await su()))
        .expect(409);
      sessions = await sessionsOf(mod.id);
      expect(sessions.active).toHaveLength(1);
      expect(sessions.recent[0]).toMatchObject({ endedReason: 'ended_by_admin' });

      // Everywhere: every token, recorded or not, stops.
      const ended = (
        await request(server())
          .post(`${V1}/admin/admins/${mod.id}/logout-all`)
          .set(auth(await su()))
          .expect(200)
      ).body as Envelope<{ ended: number }>;
      expect(ended.data.ended).toBe(1);
      await me(second).expect(401);
      expect((await sessionsOf(mod.id)).active).toHaveLength(0);

      expect(await auditFor(mod.id)).toEqual(
        expect.arrayContaining(['admin.login', 'admin.session_end', 'admin.logout_all']),
      );
      // A moderator does not manage admins.
      const third = await signIn(mod.email, password);
      await request(server())
        .get(`${V1}/admin/admins/${mod.id}/sessions`)
        .set(auth(third))
        .expect(403);
    });

    it('marks a session ended when its admin signs out', async () => {
      const support = await makeAdmin('support');
      const token = await signIn(support.email, password);
      await request(server()).post(`${V1}/admin/auth/logout`).set(auth(token)).expect(200);
      const sessions = await sessionsOf(support.id);
      expect(sessions.active).toHaveLength(0);
      expect(sessions.recent[0]).toMatchObject({ endedReason: 'logout' });
      expect(await auditFor(support.id)).toEqual(
        expect.arrayContaining(['admin.login', 'admin.logout']),
      );
    });

    it('takes IP ranges in the allowlist and refuses anything that is not one', async () => {
      const outside = await makeAdmin('support', ['10.0.0.0/8']);
      await request(server())
        .post(`${V1}/admin/auth/login`)
        .send({ email: outside.email, password })
        .expect(403);
      // The test client connects from loopback, whichever family it reports.
      const inside = await makeAdmin('support', ['127.0.0.0/8', '::1/128']);
      await signIn(inside.email, password);
      await request(server())
        .patch(`${V1}/admin/admins/${inside.id}`)
        .set(auth(await su()))
        .send({ ipAllowlist: ['127.0.0.1', 'office-wifi'] })
        .expect(400);
    });

    it('separates reads from changes, exports the trail, and sums up one admin', async () => {
      const token = await su();
      await request(server()).get(`${V1}/admin/users/export`).set(auth(token)).expect(200);

      const reads = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ kind: 'read', limit: 100 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(reads.data.items.length).toBeGreaterThan(0);
      expect(reads.data.items.every((a) => /reveal|export/.test(a.action))).toBe(true);
      const changes = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ kind: 'change', limit: 100 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(changes.data.items.some((a) => /reveal|export/.test(a.action))).toBe(false);

      const csv = await request(server())
        .get(`${V1}/admin/audit/export`)
        .query({ kind: 'read' })
        .set(auth(token))
        .expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text).toContain('when,admin,action,kind');
      expect(csv.text).toContain('user.export');

      const self = (await me(token).expect(200)).body as Envelope<{ id: string }>;
      const activity = (
        await request(server())
          .get(`${V1}/admin/admins/${self.data.id}/activity`)
          .query({ days: 7 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        total: number;
        reads: number;
        byDay: { day: string }[];
        byAction: { action: string }[];
        lastAt: string | null;
      }>;
      expect(activity.data.byDay).toHaveLength(7);
      expect(activity.data.reads).toBeGreaterThanOrEqual(1);
      expect(activity.data.byAction.map((a) => a.action)).toEqual(
        expect.arrayContaining(['admin.login', 'audit.export']),
      );
      expect(activity.data.lastAt).not.toBeNull();
    });

    it('gives the finance role money and nothing else', async () => {
      const finance = await makeAdmin('finance');
      const token = await signIn(finance.email, password);
      await request(server()).get(`${V1}/admin/money/gifts`).set(auth(token)).expect(200);
      await request(server()).get(`${V1}/admin/users`).set(auth(token)).expect(200);
      await request(server()).get(`${V1}/admin/content/wishlists`).set(auth(token)).expect(403);
      await request(server()).get(`${V1}/admin/moderation/queue`).set(auth(token)).expect(403);
      await request(server()).get(`${V1}/admin/admins`).set(auth(token)).expect(403);
    });
  });

  describe('catch-up: blocks, held messages, shared dates, loved wishes', () => {
    const db = () => app.get<Connection>(getConnectionToken()).db!;
    const sectionOf = async <T>(userId: string, key: string) =>
      (
        (
          await request(server())
            .get(`${V1}/admin/users/${userId}/sections/${key}`)
            .set(auth(await adminToken()))
            .expect(200)
        ).body as Envelope<{ items: T[]; names?: Record<string, string> }>
      ).data;

    it('shows blocks both ways, and counts how many people blocked someone', async () => {
      const blocker = await newUser();
      const blocked = await newUser();
      await request(server())
        .post(`${V1}/people/${blocked.userId}/block`)
        .set(auth(blocker.token))
        .expect((res) => expect([200, 201, 204]).toContain(res.status));

      type Block = { direction: string; otherId: string; wereWishMates: boolean };
      const theirs = await sectionOf<Block>(blocker.userId, 'blocks');
      expect(theirs.items).toEqual([
        expect.objectContaining({ direction: 'blocked_them', otherId: blocked.userId }),
      ]);
      const other = await sectionOf<Block>(blocked.userId, 'blocks');
      expect(other.items).toEqual([
        expect.objectContaining({ direction: 'blocked_by', otherId: blocker.userId }),
      ]);
      const profile = (
        await request(server())
          .get(`${V1}/admin/users/${blocked.userId}/profile`)
          .set(auth(await adminToken()))
          .expect(200)
      ).body as Envelope<{ counts: Record<string, number> }>;
      expect(profile.data.counts.blockedBy).toBe(1);
      expect(profile.data.counts.blocking).toBe(0);
    });

    it('marks a message held by a block, and names a shared profile', async () => {
      const a = await newUser();
      const b = await newUser();
      const shared = await newUser();
      const chatId = new Types.ObjectId();
      const now = new Date();
      await db()
        .collection('chats')
        .insertOne({
          _id: chatId,
          type: 'direct',
          participantIds: [new Types.ObjectId(a.userId), new Types.ObjectId(b.userId)],
          createdAt: now,
          updatedAt: now,
        });
      await db()
        .collection('messages')
        .insertMany([
          {
            chatId,
            senderId: new Types.ObjectId(a.userId),
            kind: 'text',
            body: 'Hello?',
            attachments: [],
            reactions: [{ emoji: '👍', userIds: [new Types.ObjectId(a.userId)] }],
            hideFromUserIds: [new Types.ObjectId(b.userId)],
            createdAt: now,
            updatedAt: now,
          },
          {
            chatId,
            senderId: new Types.ObjectId(a.userId),
            kind: 'profile',
            body: '',
            attachments: [],
            reactions: [],
            sharedUserId: new Types.ObjectId(shared.userId),
            hideFromUserIds: [],
            createdAt: new Date(now.getTime() + 1000),
            updatedAt: now,
          },
        ]);
      const detail = (
        await request(server())
          .get(`${V1}/admin/content/chats/${chatId.toString()}`)
          .set(auth(await adminToken()))
          .expect(200)
      ).body as Envelope<{
        sections: {
          key: string;
          items: {
            kind: string;
            heldFromIds: string[];
            sharedUserId: string | null;
            reactions: { emoji: string; count: number }[];
          }[];
        }[];
        names: Record<string, string>;
      }>;
      const messages = detail.data.sections.find((s) => s.key === 'messages')!.items;
      const held = messages.find((m) => m.kind === 'text')!;
      expect(held.heldFromIds).toEqual([b.userId]);
      expect(held.reactions).toEqual([{ emoji: '👍', count: 1 }]);
      expect(messages.find((m) => m.kind === 'profile')!.sharedUserId).toBe(shared.userId);
      expect(detail.data.names[b.userId]).toBeTruthy();
      expect(detail.data.names[shared.userId]).toBeTruthy();
    });

    it('shows which dates are shared, and who asked to be reminded of them', async () => {
      const owner = await newUser();
      const follower = await newUser();
      const dateId = new Types.ObjectId();
      await db()
        .collection('important_dates')
        .insertOne({
          _id: dateId,
          userId: new Types.ObjectId(owner.userId),
          personName: 'Mum',
          occasionKey: 'birthday',
          date: new Date('2026-12-01T00:00:00Z'),
          monthDay: '12-01',
          visibility: 'wishmates',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      await db()
        .collection('important_date_follows')
        .insertOne({
          userId: new Types.ObjectId(follower.userId),
          importantDateId: dateId,
          ownerId: new Types.ObjectId(owner.userId),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      const dates = await sectionOf<{ id: string; visibility: string }>(
        owner.userId,
        'important-dates',
      );
      expect(dates.items.find((d) => d.id === dateId.toString())?.visibility).toBe('wishmates');
      type Follow = { direction: string; otherId: string; dateName: string | null };
      expect((await sectionOf<Follow>(owner.userId, 'date-follows')).items).toEqual([
        expect.objectContaining({
          direction: 'followed_by',
          otherId: follower.userId,
          dateName: 'Mum',
        }),
      ]);
      expect((await sectionOf<Follow>(follower.userId, 'date-follows')).items).toEqual([
        expect.objectContaining({ direction: 'follows', otherId: owner.userId }),
      ]);
    });

    it('shows a wish the recipient loved', async () => {
      const host = await newUser();
      const capsuleId = new Types.ObjectId();
      const now = new Date();
      await db()
        .collection('memory_capsules')
        .insertOne({
          _id: capsuleId,
          hostId: new Types.ObjectId(host.userId),
          title: 'Loved check',
          status: 'unlocked',
          unlockAt: now,
          createdAt: now,
          updatedAt: now,
        });
      await db()
        .collection('memory_wishes')
        .insertOne({
          capsuleId,
          contributorId: new Types.ObjectId(host.userId),
          contributorName: 'Host',
          kind: 'text',
          text: 'Happy birthday',
          order: 0,
          lovedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      const detail = (
        await request(server())
          .get(`${V1}/admin/content/memories/${capsuleId.toString()}`)
          .set(auth(await adminToken()))
          .expect(200)
      ).body as Envelope<{ sections: { key: string; items: { lovedAt: string | null }[] }[] }>;
      const wishes = detail.data.sections.find((s) => s.key === 'wishes')!.items;
      expect(wishes[0].lovedAt).toBeTruthy();
    });
  });

  describe('moderation upgrades', () => {
    const reportWishlist = async (reporter: Actor, wishlistId: string) =>
      (
        (
          await request(server())
            .post(`${V1}/reports`)
            .set(auth(reporter.token))
            .send({ targetType: 'wishlist', targetId: wishlistId, reason: 'spam' })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;

    const newList = async (owner: Actor) =>
      (
        (
          await request(server())
            .post(`${V1}/wishlists`)
            .set(auth(owner.token))
            .send({ title: `Mod list ${++seq}`, visibility: WishlistVisibility.PUBLIC })
            .expect(201)
        ).body as Envelope<{ id: string }>
      ).data.id;

    it('removes through a report, shows the removal, and restores it', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const reporter = await newUser();
      const listId = await newList(owner);
      const reportId = await reportWishlist(reporter, listId);

      await request(server())
        .post(`${V1}/admin/moderation/reports/${reportId}/act`)
        .set(auth(token))
        .send({ action: 'remove', reason: 'spam' })
        .expect(200);
      const target = (
        await request(server())
          .get(`${V1}/admin/moderation/reports/${reportId}/target`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ state: string; removal: { id: string } | null }>;
      expect(target.data.removal).not.toBeNull();

      const restored = (
        await request(server())
          .post(`${V1}/admin/moderation/reports/${reportId}/restore`)
          .set(auth(token))
          .send({ reason: 'Appeal: it was a real list' })
          .expect(200)
      ).body as Envelope<{ status: string; resolution: string }>;
      expect(restored.data.status).toBe('dismissed');
      expect(restored.data.resolution).toContain('Restored');
      const list = await app
        .get<Connection>(getConnectionToken())
        .db!.collection('wishlists')
        .findOne({ _id: new Types.ObjectId(listId) });
      expect(list!.archivedAt).toBeNull();
    });

    it('lets a moderator claim a report, and not take one held by someone else', async () => {
      const root = await adminToken();
      const owner = await newUser();
      const reporter = await newUser();
      const reportId = await reportWishlist(reporter, await newList(owner));

      const email = `mod-claim-${++seq}-${Date.now()}@wishtick.test`;
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(root))
        .send({ email, password: 'a-long-enough-password', name: 'Mod', roles: ['moderator'] })
        .expect(201);
      const mod = await signIn(email, 'a-long-enough-password');

      await request(server())
        .post(`${V1}/admin/moderation/reports/${reportId}/claim`)
        .set(auth(mod))
        .send({})
        .expect(200);
      await request(server())
        .post(`${V1}/admin/moderation/reports/${reportId}/claim`)
        .set(auth(root))
        .send({})
        .expect(409);

      const mine = (
        await request(server())
          .get(`${V1}/admin/moderation/queue`)
          .query({ assigned: 'me' })
          .set(auth(mod))
          .expect(200)
      ).body as Envelope<{ items: { _id: string }[] }>;
      expect(mine.data.items.map((r) => r._id)).toContain(reportId);

      await request(server())
        .post(`${V1}/admin/moderation/reports/${reportId}/claim`)
        .set(auth(root))
        .send({ takeOver: true })
        .expect(200);
    });

    it('acts on several reports at once and says which failed', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const reporter = await newUser();
      const one = await reportWishlist(reporter, await newList(owner));
      const two = await reportWishlist(reporter, await newList(owner));

      const res = (
        await request(server())
          .post(`${V1}/admin/moderation/reports/bulk`)
          .set(auth(token))
          .send({ ids: [one, two, DUMMY_ID], action: 'approve', reason: 'Fine' })
          .expect(200)
      ).body as Envelope<{ done: string[]; failed: { id: string; code: string }[] }>;
      expect(res.data.done.sort()).toEqual([one, two].sort());
      expect(res.data.failed).toEqual([
        expect.objectContaining({ id: DUMMY_ID, code: 'REPORT_NOT_FOUND' }),
      ]);
    });

    it("shows the reporter's and the author's record", async () => {
      const token = await adminToken();
      const owner = await newUser();
      const reporter = await newUser();
      const first = await reportWishlist(reporter, await newList(owner));
      await request(server())
        .post(`${V1}/admin/moderation/reports/${first}/act`)
        .set(auth(token))
        .send({ action: 'remove', reason: 'spam' })
        .expect(200);
      const second = await reportWishlist(reporter, await newList(owner));

      const ctxRes = (
        await request(server())
          .get(`${V1}/admin/moderation/reports/${second}/context`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        reporter: { id: string; reports: number; upheld: number };
        author: { id: string; removals: number; reportsAboutContent: number };
        sameTarget: number;
      }>;
      expect(ctxRes.data.reporter).toEqual(
        expect.objectContaining({ id: reporter.userId, reports: 2, upheld: 1 }),
      );
      expect(ctxRes.data.author).toEqual(
        expect.objectContaining({ id: owner.userId, removals: 1, reportsAboutContent: 2 }),
      );
      expect(ctxRes.data.sameTarget).toBe(1);
    });

    it('accepts reports on the new kinds of content', async () => {
      const reporter = await newUser();
      const someone = await newUser();
      await request(server())
        .post(`${V1}/reports`)
        .set(auth(reporter.token))
        .send({ targetType: 'profile', targetId: someone.userId, reason: 'impersonation' })
        .expect(201);
    });
  });

  describe('search', () => {
    type Hit = { kind: string; id: string; label: string; sub: string | null };

    const searchAs = async (token: string, q: string): Promise<Hit[]> =>
      (
        (
          await request(server())
            .get(`${V1}/admin/search`)
            .query({ q })
            .set(auth(token))
            .expect(200)
        ).body as Envelope<Hit[]>
      ).data;

    it('finds a user by email, and by username on their profile', async () => {
      const token = await adminToken();
      const user = await newUser();
      const handle = `findme${Date.now().toString(36)}`;
      await request(server())
        .post(`${V1}/me/username`)
        .set(auth(user.token))
        .send({ username: handle })
        .expect(201);

      const byHandle = await searchAs(token, handle);
      expect(byHandle.some((h) => h.kind === 'user' && h.id === user.userId)).toBe(true);
      expect(byHandle.find((h) => h.id === user.userId)?.sub).toContain(`@${handle}`);

      // By id too — what support is usually pasted.
      const byId = await searchAs(token, user.userId);
      expect(byId.map((h) => h.id)).toContain(user.userId);
    });

    it('finds a wishlist by its title', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const title = `Search target ${Date.now()}`;
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(owner.token))
        .send({ title, visibility: WishlistVisibility.PUBLIC })
        .expect(201);

      const hits = await searchAs(token, title);
      expect(hits.some((h) => h.kind === 'wishlist' && h.label === title)).toBe(true);
    });

    // An analyst may look up users and money, not wishlists or events.
    it('searches only the kinds the admin may see', async () => {
      const owner = await newUser();
      const title = `Hidden from analysts ${Date.now()}`;
      await request(server())
        .post(`${V1}/wishlists`)
        .set(auth(owner.token))
        .send({ title, visibility: WishlistVisibility.PUBLIC })
        .expect(201);

      const email = `analyst-${Date.now()}@wishtick.test`;
      const password = 'a-long-enough-password';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(await adminToken()))
        .send({ email, password, name: 'Analyst', roles: ['analyst'] })
        .expect(201);

      const hits = await searchAs(await signIn(email, password), title);
      expect(hits.filter((h) => h.kind === 'wishlist')).toEqual([]);
    });

    it('needs at least two characters', async () => {
      await request(server())
        .get(`${V1}/admin/search`)
        .query({ q: 'a' })
        .set(auth(await adminToken()))
        .expect(400);
    });
  });

  describe('webhook dead-letter', () => {
    // It lived at /webhooks/affiliate/dead-letter behind a user role no account
    // is ever given, so nobody could open it.
    it('is listed under /admin, paged, for those who can see money', async () => {
      const token = await adminToken();
      const page = (
        await request(server())
          .get(`${V1}/admin/webhooks/dead-letter`)
          .query({ page: 1, limit: 10 })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: unknown[]; total: number; page: number; limit: number }>;
      expect(page.data).toEqual({ items: [], total: 0, page: 1, limit: 10 });
    });
  });

  // ── Exit criterion: suspending a live user kills sockets + blocks next request ─

  describe('suspension enforcement', () => {
    it('disconnects the live socket and blocks the next REST call', async () => {
      const token = await adminToken();
      const user = await newUser();

      // The user has a live websocket and a working REST session.
      const socket = await connect(user.token);
      expect(socket.connected).toBe(true);
      await request(server()).get(`${V1}/me`).set(auth(user.token)).expect(200);

      const disconnected = new Promise<string>((resolve) =>
        socket.on('disconnect', (reason: string) => resolve(reason)),
      );

      // Suspend.
      await request(server())
        .post(`${V1}/admin/users/${user.userId}/suspend`)
        .set(auth(token))
        .send({ reason: 'abuse' })
        .expect(200);

      // The socket is force-closed…
      const reason = await Promise.race([disconnected, delay(4000).then(() => 'TIMEOUT')]);
      expect(reason).not.toBe('TIMEOUT');
      expect(socket.connected).toBe(false);

      // …and the next request on the same (now-revoked) token is blocked. A
      // suspended account is 403 (Forbidden); a plain revocation would be 401 —
      // either way the request does not go through.
      const blocked = await request(server()).get(`${V1}/me`).set(auth(user.token));
      expect([401, 403]).toContain(blocked.status);
    });

    it('reactivating a user is itself audited', async () => {
      const token = await adminToken();
      const user = await newUser();
      await request(server())
        .post(`${V1}/admin/users/${user.userId}/suspend`)
        .set(auth(token))
        .send({ reason: 'temp' })
        .expect(200);
      await request(server())
        .post(`${V1}/admin/users/${user.userId}/reactivate`)
        .set(auth(token))
        .expect(200);

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetType: 'user', targetId: user.userId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[]; total: number }>;
      const actions = audit.data.items.map((a) => a.action);
      expect(actions).toContain('user.suspend');
      expect(actions).toContain('user.reactivate');
    });
  });

  // ── Exit criterion: every admin mutation lands in the audit log with a diff ──

  describe('audit trail', () => {
    it('records a readable field-level diff for a suspension', async () => {
      const token = await adminToken();
      const user = await newUser();

      await request(server())
        .post(`${V1}/admin/users/${user.userId}/suspend`)
        .set(auth(token))
        .send({ reason: 'spam ring' })
        .expect(200);

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetType: 'user', targetId: user.userId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        items: {
          action: string;
          actorEmail: string;
          diff: { field: string; before: unknown; after: unknown }[];
        }[];
        total: number;
      }>;

      const entry = audit.data.items.find((a) => a.action === 'user.suspend');
      expect(entry).toBeDefined();
      expect(entry!.actorEmail).toBe(ADMIN_EMAIL);
      const statusChange = entry!.diff.find((d) => d.field === 'status');
      expect(statusChange).toEqual({ field: 'status', before: 'active', after: 'suspended' });
      const reasonChange = entry!.diff.find((d) => d.field === 'suspendedReason');
      expect(reasonChange?.after).toBe('spam ring');
    });
  });

  // ── Moderation: report → queue → act (audited) ───────────────────────────────

  describe('admin management', () => {
    it('cannot disable your own account, or demote yourself out of the panel', async () => {
      const token = await adminToken();
      const me = (await request(server()).get(`${V1}/admin/auth/me`).set(auth(token)).expect(200))
        .body as Envelope<{ id: string }>;

      // Self-disable is refused — otherwise an operator can lock themselves out
      // and the only recovery is a manual database write.
      const disabled = await request(server())
        .patch(`${V1}/admin/admins/${me.data.id}`)
        .set(auth(token))
        .send({ status: 'disabled' })
        .expect(403);
      expect((disabled.body as { error: { code: string } }).error.code).toBe('ADMIN_FORBIDDEN');

      // Same for removing your own super-admin role.
      await request(server())
        .patch(`${V1}/admin/admins/${me.data.id}`)
        .set(auth(token))
        .send({ roles: ['support'] })
        .expect(403);

      // And the account is untouched.
      const after = (
        await request(server()).get(`${V1}/admin/auth/me`).set(auth(token)).expect(200)
      ).body as Envelope<{ roles: string[] }>;
      expect(after.data.roles).toContain('super_admin');
    });

    it('updates a second admin and records a readable diff', async () => {
      const token = await adminToken();
      const created = (
        await request(server())
          .post(`${V1}/admin/admins`)
          .set(auth(token))
          .send({
            email: `mod-${Date.now()}@wishtick.test`,
            password: 'a-long-enough-password',
            name: 'Mod One',
            roles: ['moderator'],
          })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      const updated = (
        await request(server())
          .patch(`${V1}/admin/admins/${created.data.id}`)
          .set(auth(token))
          .send({ roles: ['support'], name: 'Support One' })
          .expect(200)
      ).body as Envelope<{ roles: string[]; name: string; permissions: string[] }>;

      expect(updated.data.roles).toEqual(['support']);
      expect(updated.data.name).toBe('Support One');
      // Permissions are recomputed from roles, not stored.
      expect(updated.data.permissions).toContain('users:manage');

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetType: 'admin', targetId: created.data.id })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        items: { action: string; diff: { field: string; before: unknown; after: unknown }[] }[];
      }>;
      const entry = audit.data.items.find((a) => a.action === 'admin.update');
      expect(entry).toBeDefined();
      const roleChange = entry!.diff.find((d) => d.field === 'roles');
      expect(roleChange).toEqual({ field: 'roles', before: ['moderator'], after: ['support'] });
    });

    it('resetting a password never records the password itself', async () => {
      const token = await adminToken();
      const created = (
        await request(server())
          .post(`${V1}/admin/admins`)
          .set(auth(token))
          .send({
            email: `pw-${Date.now()}@wishtick.test`,
            password: 'original-password-1',
            name: 'Pw Test',
            roles: ['analyst'],
          })
          .expect(201)
      ).body as Envelope<{ id: string }>;

      await request(server())
        .post(`${V1}/admin/admins/${created.data.id}/password`)
        .set(auth(token))
        .send({ password: 'a-brand-new-password' })
        .expect(200);

      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetType: 'admin', targetId: created.data.id })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[] }>;
      expect(audit.data.items.map((a) => a.action)).toContain('admin.password_reset');
      // An audit log that quotes a credential is a credential leak with a timestamp.
      expect(JSON.stringify(audit.data)).not.toContain('a-brand-new-password');
    });

    it('paginates the audit log and filters it by day', async () => {
      const token = await adminToken();
      const today = new Date().toISOString().slice(0, 10);

      const page1 = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ page: 1, limit: 2, from: today, to: today })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: unknown[]; total: number; page: number; limit: number }>;

      expect(page1.data.page).toBe(1);
      expect(page1.data.limit).toBe(2);
      expect(page1.data.items.length).toBeLessThanOrEqual(2);
      // `to` is inclusive of the whole day — entries written seconds ago must match.
      expect(page1.data.total).toBeGreaterThan(0);

      // A range that ended yesterday must exclude today's entries.
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const past = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ to: yesterday })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ total: number }>;
      expect(past.data.total).toBeLessThan(page1.data.total);
    });
  });

  describe('moderation flow', () => {
    it('offers approve and remove — flag and escalate are gone, one at a time or in bulk', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const reporter = await newUser();
      const wl = (
        await request(server())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: 'Escalation check', visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const report = (
        await request(server())
          .post(`${V1}/reports`)
          .set(auth(reporter.token))
          .send({ targetType: 'wishlist', targetId: wl.data.id, reason: 'spam' })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      for (const action of ['escalate', 'flag']) {
        await request(server())
          .post(`${V1}/admin/moderation/reports/${report.data.id}/act`)
          .set(auth(token))
          .send({ action })
          .expect(400);
        await request(server())
          .post(`${V1}/admin/moderation/reports/bulk`)
          .set(auth(token))
          .send({ ids: [report.data.id], action })
          .expect(400);
      }
      // The same bulk call with a real action goes through — so the 400 was the action.
      await request(server())
        .post(`${V1}/admin/moderation/reports/bulk`)
        .set(auth(token))
        .send({ ids: [report.data.id], action: 'approve' })
        .expect((res) => expect([200, 201]).toContain(res.status));
      const decided = (
        await request(server())
          .get(`${V1}/admin/moderation/reports/${report.data.id}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ status: string }>;
      expect(decided.data.status).toBe('dismissed');
    });

    it('carries a user report through the queue to a removal, deduped and audited', async () => {
      const token = await adminToken();
      const owner = await newUser();
      const reporter = await newUser();

      // Owner creates a public wishlist; two users could see it.
      const wl = (
        await request(server())
          .post(`${V1}/wishlists`)
          .set(auth(owner.token))
          .send({ title: 'Spammy list', visibility: WishlistVisibility.PUBLIC })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      const wishlistId = wl.data.id;

      // Reporter files a report — twice; the second dedupes to the same report.
      const first = (
        await request(server())
          .post(`${V1}/reports`)
          .set(auth(reporter.token))
          .send({ targetType: 'wishlist', targetId: wishlistId, reason: 'spam' })
          .expect(201)
      ).body as Envelope<{ id: string; status: string }>;
      const again = (
        await request(server())
          .post(`${V1}/reports`)
          .set(auth(reporter.token))
          .send({ targetType: 'wishlist', targetId: wishlistId, reason: 'spam again' })
          .expect(201)
      ).body as Envelope<{ id: string }>;
      expect(again.data.id).toBe(first.data.id); // deduped

      // It appears in the moderator queue.
      const queue = (
        await request(server()).get(`${V1}/admin/moderation/queue`).set(auth(token)).expect(200)
      ).body as Envelope<{
        items: { _id: string; targetId: string; status: string }[];
        total: number;
      }>;
      const queued = queue.data.items.find((r) => r.targetId === wishlistId);
      expect(queued).toBeDefined();
      expect(queued!.status).toBe('open');

      // The queue is paginated, not a bare array — a backlog must be reachable.
      expect(typeof queue.data.total).toBe('number');

      // The report opens on its own — not by paging the queue until it turns up.
      const one = (
        await request(server())
          .get(`${V1}/admin/moderation/reports/${first.data.id}`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ status: string; targetType: string }>;
      expect(one.data.status).toBe('open');
      expect(one.data.targetType).toBe('wishlist');
      await request(server())
        .get(`${V1}/admin/moderation/reports/${DUMMY_ID}`)
        .set(auth(token))
        .expect(404);

      // And the reported content itself resolves, so the moderator can judge it
      // rather than acting on an opaque id.
      const target = (
        await request(server())
          .get(`${V1}/admin/moderation/reports/${first.data.id}/target`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{
        targetType: string;
        exists: boolean;
        title: string | null;
        authorId: string | null;
        state: string | null;
      }>;
      expect(target.data.targetType).toBe('wishlist');
      expect(target.data.exists).toBe(true);
      expect(target.data.title).toBeTruthy();
      expect(target.data.authorId).toBeTruthy();
      expect(target.data.state).toBeNull(); // not yet archived

      // Moderator removes the content.
      await request(server())
        .post(`${V1}/admin/moderation/reports/${first.data.id}/act`)
        .set(auth(token))
        .send({ action: 'remove', reason: 'confirmed spam' })
        .expect(200);

      // The report is resolved and no longer open in the queue.
      const after = (
        await request(server()).get(`${V1}/admin/moderation/queue`).set(auth(token)).expect(200)
      ).body as Envelope<{ items: { targetId: string }[] }>;
      expect(after.data.items.find((r) => r.targetId === wishlistId)).toBeUndefined();

      // The action is in the audit trail.
      const audit = (
        await request(server())
          .get(`${V1}/admin/audit`)
          .query({ targetType: 'wishlist', targetId: wishlistId })
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ items: { action: string }[]; total: number }>;
      expect(audit.data.items.map((a) => a.action)).toContain('moderation.remove');
    });
  });

  // ── Analytics ingestion + attribution ────────────────────────────────────────

  describe('analytics ingestion & attribution', () => {
    it('accepts a batch of tracked events for the authenticated user', async () => {
      const user = await newUser();
      const res = await request(server())
        .post(`${V1}/events/track`)
        .set(auth(user.token))
        .send({ events: [{ name: 'app_open' }, { name: 'view_wishlist' }] })
        .expect(202);
      expect((res.body as Envelope<{ accepted: number }>).data.accepted).toBe(2);

      const count = await eventModel.countDocuments({
        userId: new Types.ObjectId(user.userId),
      });
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('measures gift shelves, and keeps nothing about who they were for', async () => {
      const user = await newUser();
      const shelf = (kind: string, personalised: boolean) => ({
        surface: 'discover',
        kind,
        personalised,
      });
      const res = await request(server())
        .post(`${V1}/events/track`)
        .set(auth(user.token))
        .send({
          events: [
            {
              name: 'shelf_viewed',
              props: { ...shelf('wishmate_taste', true), recipientUserId: 'u_x' },
            },
            { name: 'shelf_viewed', props: shelf('wishmate_taste', true) },
            {
              name: 'shelf_product_opened',
              props: { ...shelf('wishmate_taste', true), position: 0 },
            },
            { name: 'shelf_viewed', props: shelf('person_occasion', false) },
            // Not a shelf anybody draws: dropped, not stored.
            {
              name: 'shelf_viewed',
              props: { surface: 'discover', kind: 'mystery', personalised: true },
            },
          ],
        })
        .expect(202);
      expect((res.body as Envelope<{ accepted: number }>).data.accepted).toBe(4);

      const stored = await eventModel
        .find({ userId: new Types.ObjectId(user.userId), name: /^shelf_/ })
        .lean();
      expect(JSON.stringify(stored)).not.toContain('u_x');

      const bucket = new Date().toISOString().slice(0, 10);
      await analytics.rollupDay(bucket);
      const rows = (
        await request(server())
          .get(`${V1}/admin/analytics/shelves`)
          .query({ from: bucket, to: bucket })
          .set(auth(await adminToken()))
          .expect(200)
      ).body as Envelope<{ kind: string; views: number; opens: number; openRate: number | null }[]>;

      const taste = rows.data.find((r) => r.kind === 'wishmate_taste');
      expect(taste).toMatchObject({ personalised: true, views: 2, opens: 1, openRate: 0.5 });
      expect(rows.data.find((r) => r.kind === 'person_occasion')).toMatchObject({
        personalised: false,
        views: 1,
        opens: 0,
        openRate: 0,
      });
    });

    it('captures the acquisition source at signup, visible to admin + analytics', async () => {
      const token = await adminToken();
      const user = await newUser({ source: 'tiktok', ref: 'campaign-42' });

      // The user profile carries the attribution.
      const detail = (
        await request(server()).get(`${V1}/admin/users/${user.userId}`).set(auth(token)).expect(200)
      ).body as Envelope<{ acquisition: { source: string; ref: string | null } | null }>;
      expect(detail.data.acquisition?.source).toBe('tiktok');
      expect(detail.data.acquisition?.ref).toBe('campaign-42');

      // The signup landed in the analytics stream with that source (listener is
      // fire-and-forget, so poll briefly).
      let signupEvent: AnalyticsEventDocument | null = null;
      for (let i = 0; i < 20 && !signupEvent; i++) {
        signupEvent = await eventModel.findOne({
          name: 'signup',
          userId: new Types.ObjectId(user.userId),
        });
        if (!signupEvent) await delay(50);
      }
      expect(signupEvent).not.toBeNull();
      expect(signupEvent!.source).toBe('tiktok');
    });
  });

  // ── Exit criterion: DAU/WAU/MAU reconcile with a raw recount (≤0.5%) ─────────

  describe('DAU/WAU/MAU reconciliation', () => {
    const bucketOf = (d: Date): string => d.toISOString().slice(0, 10);

    it('matches the rollup metrics against an independent raw-event recount', async () => {
      // Isolate: this test asserts exact distinct-user counts, so clear the
      // stream first (other tests' signups would otherwise inflate the windows).
      await eventModel.deleteMany({});

      const now = new Date();

      // Distinct cohorts: 5 active today, +8 three days ago, +12 twenty days ago.
      const docs: {
        userId: Types.ObjectId;
        anonymousId: null;
        name: string;
        props: Record<string, unknown>;
        source: null;
        ts: Date;
      }[] = [];
      const push = (count: number, offsetDays: number): void => {
        for (let i = 0; i < count; i++) {
          docs.push({
            userId: new Types.ObjectId(),
            anonymousId: null,
            name: 'app_open',
            props: {},
            source: null,
            ts: new Date(now.getTime() - offsetDays * DAY_MS),
          });
        }
      };
      push(5, 0); // today
      push(8, 3); // within 7d + 30d
      push(12, 20); // within 30d only
      // An anonymous event (userId null) that must NOT be counted as an active user.
      docs.push({
        userId: null as unknown as Types.ObjectId,
        anonymousId: null,
        name: 'app_open',
        props: {},
        source: null,
        ts: now,
      });
      await eventModel.insertMany(docs);

      const bucket = bucketOf(now);
      await analytics.rollupDay(bucket);

      const overview = (
        await request(server())
          .get(`${V1}/admin/analytics/overview`)
          .query({ to: bucket })
          .set(auth(await adminToken()))
          .expect(200)
      ).body as Envelope<{ dau: number; wau: number; mau: number }>;

      // Independent recount straight from the raw stream, same windows as rollupDay.
      const dayStart = new Date(`${bucket}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart.getTime() + DAY_MS);
      const recount = async (start: Date, end: Date): Promise<number> => {
        const ids = await eventModel.distinct('userId', {
          ts: { $gte: start, $lt: end },
          userId: { $ne: null },
        });
        return ids.length;
      };
      const dau = await recount(dayStart, dayEnd);
      const wau = await recount(new Date(dayEnd.getTime() - 7 * DAY_MS), dayEnd);
      const mau = await recount(new Date(dayEnd.getTime() - 30 * DAY_MS), dayEnd);

      // The controlled cohorts (the anonymous event is excluded).
      expect(dau).toBe(5);
      expect(wau).toBe(13);
      expect(mau).toBe(25);

      // The exit criterion: dashboard numbers within 0.5% of the recount.
      const within = (a: number, b: number): boolean =>
        b === 0 ? a === 0 : Math.abs(a - b) / b <= 0.005;
      expect(within(overview.data.dau, dau)).toBe(true);
      expect(within(overview.data.wau, wau)).toBe(true);
      expect(within(overview.data.mau, mau)).toBe(true);
      // In fact they are computed by the same distinct-count, so they match exactly.
      expect(overview.data.dau).toBe(dau);
      expect(overview.data.wau).toBe(wau);
      expect(overview.data.mau).toBe(mau);
    });
  });
});
