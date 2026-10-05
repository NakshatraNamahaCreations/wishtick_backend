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
import { NotificationService } from 'src/modules/notifications/notification.service';
import { NotificationChannel } from 'src/modules/notifications/notification.types';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
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

    it('rotates a share link and archives a list, both on the record', async () => {
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

      await request(server())
        .post(`${V1}/admin/content/wishlists/${listId}/actions/rotate-share`)
        .set(auth(token))
        .send({ reason: 'Link leaked publicly' })
        .expect(200);
      expect(await slugOf()).not.toBe(before);

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
        expect.arrayContaining(['content.rotate_share', 'content.remove', 'content.restore']),
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
            channel: 'email',
            refId: `r-${seq}`,
            dedupeKey: `k-${seq}-1-${Date.now()}`,
            status: 'failed',
            destination: 'asha.rao@example.com',
            providerRef: null,
            error: 'mailbox full',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            userId: uid,
            type: 'gift_purchased',
            channel: 'email',
            refId: `r-${seq}`,
            dedupeKey: `k-${seq}-2-${Date.now()}`,
            status: 'sent',
            destination: 'asha.rao@example.com',
            providerRef: 'p1',
            error: null,
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
      expect(failed.data.items[0].error).toBe('mailbox full');
      expect(failed.data.items[0].destination).not.toContain('asha.rao');

      const overview = (
        await request(server())
          .get(`${V1}/admin/notifications/overview`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ byChannel: { channel: string; counts: Record<string, number> }[] }>;
      const email = overview.data.byChannel.find((c) => c.channel === 'email')!;
      expect(email.counts.failed).toBeGreaterThanOrEqual(1);

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

    it('lets an address receive again, on the record', async () => {
      const token = await adminToken();
      const address = `bounce-${seq}-${Date.now()}@example.com`;
      await app.get(NotificationService).suppress(NotificationChannel.EMAIL, address);

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
      expect(listed.data.channels.find((c) => c.channel === 'email')!.addresses).toContain(address);

      // Support can look, but not change who receives mail.
      await request(server())
        .post(`${V1}/admin/notifications/suppressions/remove`)
        .set(auth(await roleToken('support')))
        .send({ channel: 'email', address, reason: 'Fixed mailbox' })
        .expect(403);

      await request(server())
        .post(`${V1}/admin/notifications/suppressions/remove`)
        .set(auth(token))
        .send({ channel: 'email', address, reason: 'Fixed mailbox' })
        .expect(200);
      expect(
        await app.get(NotificationService).isSuppressedAddress(NotificationChannel.EMAIL, address),
      ).toBe(false);
      await request(server())
        .post(`${V1}/admin/notifications/suppressions/remove`)
        .set(auth(token))
        .send({ channel: 'email', address, reason: 'Again' })
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

    it('counts an audience first, then announces to exactly it', async () => {
      const token = await adminToken();
      const city = `Zzcity${seq}${Date.now()}`;
      const inCity = await newUser();
      const elsewhere = await newUser();
      await db()
        .collection('user_profiles')
        .updateOne(
          { userId: new Types.ObjectId(inCity.userId) },
          { $set: { city } },
          { upsert: true },
        );

      const dry = (
        await request(server())
          .post(`${V1}/admin/notifications/broadcasts/dry-run`)
          .set(auth(token))
          .send({ segment: { city: city.toLowerCase() } })
          .expect(200)
      ).body as Envelope<{ count: number }>;
      expect(dry.data.count).toBe(1);

      const sent = (
        await request(server())
          .post(`${V1}/admin/notifications/broadcasts`)
          .set(auth(token))
          .send({ title: 'Hello city', body: 'Something for you.', segment: { city } })
          .expect(201)
      ).body as Envelope<{ id: string; audience: number }>;
      expect(sent.data.audience).toBe(1);

      // The fan-out is a scheduler job: queued, then run here as the worker would.
      const job = ctx.scheduler.added.find(
        (j) =>
          j.name === 'admin-broadcast' &&
          (j.data as { broadcastId: string }).broadcastId === sent.data.id,
      );
      expect(job).toBeDefined();
      await app.get(SchedulerRegistry).get('admin-broadcast')!(job!.data);
      await ctx.drainNotifications();

      const done = await eventually(async () => {
        const b = await db()
          .collection('admin_broadcasts')
          .findOne({ _id: new Types.ObjectId(sent.data.id) });
        return b?.status === 'sent';
      });
      expect(done).toBe(true);
      const got = (id: string) =>
        db()
          .collection('notifications')
          .countDocuments({ userId: new Types.ObjectId(id), type: 'admin_announcement' });
      expect(await eventually(async () => (await got(inCity.userId)) === 1)).toBe(true);
      expect(await got(elsewhere.userId)).toBe(0);

      // Nobody matches → nothing is queued.
      await request(server())
        .post(`${V1}/admin/notifications/broadcasts`)
        .set(auth(token))
        .send({ title: 'Nobody', body: 'No one here.', segment: { city: 'Nowhere-at-all' } })
        .expect(400);
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
        expect.arrayContaining(['ops.pause_queue', 'ops.resume_queue']),
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

    it('adds, relabels, retires and restores an option, and the app sees each change', async () => {
      const token = await adminToken();
      const kinds = (
        await request(server()).get(`${V1}/admin/catalog/taxonomy`).set(auth(token)).expect(200)
      ).body as Envelope<{ kind: string; total: number; canAdd: boolean }[]>;
      expect(kinds.data.find((k) => k.kind === 'lifestyle')?.total).toBeGreaterThan(0);
      expect(kinds.data.find((k) => k.kind === 'event_type')?.canAdd).toBe(false);
      await optionsText(); // warm the options cache

      const key = `stargazing_${seq}`;
      const created = (
        await request(server())
          .post(`${V1}/admin/catalog/taxonomy/lifestyle`)
          .set(auth(token))
          .send({ key, label: 'Stargazing' })
          .expect(201)
      ).body as Envelope<Term>;
      expect(await optionsText()).toContain('Stargazing');
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/lifestyle`)
        .set(auth(token))
        .send({ key, label: 'Again' })
        .expect(409);

      await request(server())
        .patch(`${V1}/admin/catalog/taxonomy/lifestyle/${created.data.id}`)
        .set(auth(token))
        .send({ label: 'Stargazing and astronomy', key: 'ignored' })
        .expect(200);
      let text = await optionsText();
      expect(text).toContain('Stargazing and astronomy');
      expect(text).toContain(key);

      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/lifestyle/${created.data.id}/active`)
        .set(auth(token))
        .send({ active: false, reason: 'Too niche' })
        .expect(200);
      text = await optionsText();
      expect(text).not.toContain(key);
      // Retired, not deleted: the panel still lists it.
      const list = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/lifestyle`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: Term[] }>;
      expect(list.data.terms.find((t) => t.key === key)?.active).toBe(false);

      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/lifestyle/${created.data.id}/active`)
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

    it('checks the extras an option needs, and keeps the ones the app depends on', async () => {
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
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/color`)
        .set(auth(token))
        .send({
          key: `c_${seq}`,
          label: 'Bad hex',
          meta: { hex: 'red', group: 'red', groupLabel: 'Reds' },
        })
        .expect(400);
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/lifestyle`)
        .set(auth(token))
        .send({ key: 'Has Spaces', label: 'Bad key' })
        .expect(400);
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/event_type`)
        .set(auth(token))
        .send({ key: `party_${seq}`, label: 'Party' })
        .expect(400);

      const interests = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/interest`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ choices: Record<string, { value: string }[]> }>;
      const category = interests.data.choices.category[0].value;
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/interest`)
        .set(auth(token))
        .send({ key: `${category}_kites_${seq}`, label: 'Kites', meta: { category } })
        .expect(201);

      const occasions = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/occasion`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: (Term & { fixed: boolean })[] }>;
      const other = occasions.data.terms.find((t) => t.key === 'other')!;
      expect(other.fixed).toBe(true);
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/occasion/${other.id}/active`)
        .set(auth(token))
        .send({ active: false })
        .expect(400);
    });

    it('reorders options, counts their use, and lets only catalogue managers change them', async () => {
      const token = await adminToken();
      const user = await newUser();
      const before = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/fit_preference`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: Term[] }>;
      const fit = before.data.terms[0];
      await request(server())
        .patch(`${V1}/me/preferences`)
        .set(auth(user.token))
        .send({ fitPreference: fit.key })
        .expect(200);

      const reversed = [...before.data.terms].reverse().map((t) => t.id);
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/fit_preference/reorder`)
        .set(auth(token))
        .send({ ids: reversed })
        .expect(200);
      const after = (
        await request(server())
          .get(`${V1}/admin/catalog/taxonomy/fit_preference`)
          .set(auth(token))
          .expect(200)
      ).body as Envelope<{ terms: Term[] }>;
      expect(after.data.terms.map((t) => t.id)).toEqual(reversed);
      expect(after.data.terms.find((t) => t.id === fit.id)!.uses).toBeGreaterThanOrEqual(1);
      // Put it back for the rest of the suite.
      await request(server())
        .post(`${V1}/admin/catalog/taxonomy/fit_preference/reorder`)
        .set(auth(token))
        .send({ ids: before.data.terms.map((t) => t.id) })
        .expect(200);

      const support = await roleToken('support');
      await request(server())
        .get(`${V1}/admin/catalog/taxonomy/fit_preference`)
        .set(auth(support))
        .expect(200);
      await request(server())
        .patch(`${V1}/admin/catalog/taxonomy/fit_preference/${fit.id}`)
        .set(auth(support))
        .send({ label: 'Nope' })
        .expect(403);
      await request(server())
        .get(`${V1}/admin/catalog/taxonomy/flavours`)
        .set(auth(token))
        .expect(404);
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
