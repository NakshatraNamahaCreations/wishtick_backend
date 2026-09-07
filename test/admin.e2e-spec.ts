import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { io, type Socket } from 'socket.io-client';
import { AuthService } from 'src/modules/auth/auth.service';
import { AnalyticsService } from 'src/modules/analytics/analytics.service';
import {
  AnalyticsEvent,
  type AnalyticsEventDocument,
} from 'src/modules/analytics/schemas/analytics-event.schema';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
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
    totp?: string,
  ): Promise<Envelope<{ accessToken: string; setupRequired: boolean }>['data']> => {
    const res = await request(server())
      .post(`${V1}/admin/auth/login`)
      .send({ email, password, ...(totp ? { totp } : {}) })
      .expect(200);
    return (res.body as Envelope<{ accessToken: string; setupRequired: boolean }>).data;
  };

  const adminToken = async (): Promise<string> => (await adminLogin()).accessToken;

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
      // No TOTP enrolled on the seed yet, so the first login flags setup.
      expect(data.setupRequired).toBe(true);
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

  // ── TOTP enrollment → login now requires the code ────────────────────────────

  describe('admin 2FA (TOTP)', () => {
    it('enrolls a second admin in 2FA and enforces it on the next login', async () => {
      const superToken = await adminToken();

      // Super-admin creates a second admin.
      const email = `mod-${Date.now()}@wishtick.test`;
      const password = 'ModeratorPassw0rd!';
      await request(server())
        .post(`${V1}/admin/admins`)
        .set(auth(superToken))
        .send({ email, password, name: 'Mod', roles: ['moderator'] })
        .expect(201);

      // First login is password-only and flags setup.
      const first = await adminLogin(email, password);
      expect(first.setupRequired).toBe(true);

      // Begin enrollment → returns a secret; compute the current code and enable.
      const setup = (
        await request(server())
          .post(`${V1}/admin/auth/totp/setup`)
          .set(auth(first.accessToken))
          .expect(200)
      ).body as Envelope<{ secret: string; keyUri: string }>;
      expect(setup.data.keyUri).toMatch(/^otpauth:\/\/totp\//);

      const totp = app.get((await import('src/modules/admin/totp.service')).TotpService);
      const code = await totp.current(setup.data.secret);
      await request(server())
        .post(`${V1}/admin/auth/totp/enable`)
        .set(auth(first.accessToken))
        .send({ token: code })
        .expect(200);

      // Now password alone is rejected…
      await request(server()).post(`${V1}/admin/auth/login`).send({ email, password }).expect(401);

      // …and password + a fresh code succeeds.
      const fresh = await totp.current(setup.data.secret);
      const second = await adminLogin(email, password, fresh);
      expect(second.setupRequired).toBe(false);
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
