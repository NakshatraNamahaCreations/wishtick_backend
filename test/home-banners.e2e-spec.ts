import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AuthService } from 'src/modules/auth/auth.service';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const PASSWORD = 'correct-horse-battery-staple';
const ADMIN_EMAIL = 'root@wishtick.test';
const ADMIN_PASSWORD = 'RootAdminPassw0rd!';

interface Envelope<T> {
  data: T;
  error?: { code: string };
}
interface Banner {
  id: string;
  placement: string;
  title: string;
  subtitle: string | null;
  imageUrl: string;
  linkUrl: string | null;
  position: number;
  active: boolean;
  live: boolean;
}
interface Live {
  exclusiveOffers: Banner[];
  specialOffers: Banner[];
}

/**
 * Home's ad carousels — "Exclusive Offers" and "Special Offers for You" — set
 * up in the admin panel and shown by the app with no release in between.
 */
describe('Home banners (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const server = (): Server => app.getHttpServer() as Server;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** The smallest thing that passes for a WebP: its two magic words. */
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
    Buffer.alloc(32),
  ]);

  let rootToken: string | null = null;
  const adminToken = async (email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> => {
    const res = await request(server())
      .post(`${V1}/admin/auth/login`)
      .send({ email, password })
      .expect(200);
    return (res.body as Envelope<{ accessToken: string }>).data.accessToken;
  };
  /** One sign-in for most calls: a sign-in each trips the login throttle. */
  const root = async (): Promise<string> => (rootToken ??= await adminToken());

  const roleToken = async (role: string): Promise<string> => {
    const email = `${role}-banners-${++seq}-${Date.now()}@wishtick.test`;
    const password = 'a-long-enough-password';
    await request(server())
      .post(`${V1}/admin/admins`)
      .set(auth(await root()))
      .send({ email, password, name: role, roles: [role] })
      .expect(201);
    return adminToken(email, password);
  };

  const userToken = async (): Promise<string> => {
    const { tokens } = await app
      .get(AuthService)
      .signup(
        { email: `banners${++seq}.${Date.now()}@example.com`, password: PASSWORD, name: 'Asha' },
        { ip: '127.0.0.1', userAgent: 'e2e' },
      );
    return tokens.accessToken;
  };

  const upload = async (token: string): Promise<string> =>
    (
      (
        await request(server())
          .post(`${V1}/admin/banners/images`)
          .set(auth(token))
          .set('Content-Type', 'image/webp')
          .send(webp)
          .expect(200)
      ).body as Envelope<{ url: string }>
    ).data.url;

  const create = async (token: string, body: Record<string, unknown>): Promise<Banner> =>
    (
      (
        await request(server())
          .post(`${V1}/admin/banners`)
          .set(auth(token))
          .send({ imageUrl: await upload(token), ...body })
          .expect(201)
      ).body as Envelope<Banner>
    ).data;

  const live = async (token: string): Promise<Live> =>
    (
      (await request(server()).get(`${V1}/home/banners`).set(auth(token)).expect(200))
        .body as Envelope<Live>
    ).data;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    rootToken = null;
    // The reset clears Redis only: banners from one test would still be live
    // in the next, which reads the carousels whole.
    await app.get<Connection>(getConnectionToken()).db!.collection('home_banners').deleteMany({});
  });

  it('shows the switched-on banners of each carousel, in order', async () => {
    const admin = await root();
    const second = await create(admin, {
      placement: 'exclusive_offers',
      title: 'Second',
      position: 2,
    });
    const first = await create(admin, {
      placement: 'exclusive_offers',
      title: 'Curated gifts for every occasion',
      subtitle: 'Handpicked offers from our trusted partners',
      linkUrl: '/discover/occasions/birthday',
      position: 1,
    });
    const special = await create(admin, {
      placement: 'special_offers',
      title: 'Up to 40% off on curated gifts',
      linkUrl: 'https://partner.example/offer',
    });
    // Drafts and finished campaigns stay off Home.
    await create(admin, { placement: 'exclusive_offers', title: 'Draft', active: false });
    await create(admin, {
      placement: 'special_offers',
      title: 'Next week',
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await create(admin, {
      placement: 'special_offers',
      title: 'Last month',
      startsAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });

    const shown = await live(await userToken());
    expect(shown.exclusiveOffers.map((b) => b.id)).toEqual([first.id, second.id]);
    expect(shown.specialOffers.map((b) => b.id)).toEqual([special.id]);
    expect(shown.exclusiveOffers[0]).toMatchObject({
      title: 'Curated gifts for every occasion',
      subtitle: 'Handpicked offers from our trusted partners',
      linkUrl: '/discover/occasions/birthday',
    });
    // What the panel does not need to show the app: none of its bookkeeping.
    expect(shown.exclusiveOffers[0]).not.toHaveProperty('active');
  });

  it('a change in the panel shows in the app at once, and is audited', async () => {
    const admin = await root();
    const user = await userToken();
    const banner = await create(admin, { placement: 'special_offers', title: 'Old words' });
    // Read once, so a cached copy exists to go stale.
    expect((await live(user)).specialOffers[0].title).toBe('Old words');

    await request(server())
      .patch(`${V1}/admin/banners/${banner.id}`)
      .set(auth(admin))
      .send({ title: 'New words' })
      .expect(200);
    expect((await live(user)).specialOffers[0].title).toBe('New words');

    await request(server())
      .patch(`${V1}/admin/banners/${banner.id}`)
      .set(auth(admin))
      .send({ active: false })
      .expect(200);
    expect((await live(user)).specialOffers).toHaveLength(0);

    await request(server())
      .post(`${V1}/admin/banners/${banner.id}/remove`)
      .set(auth(admin))
      .expect(200);
    await request(server()).get(`${V1}/admin/banners/${banner.id}`).set(auth(admin)).expect(404);

    const audit = (
      await request(server())
        .get(`${V1}/admin/audit`)
        .query({ targetId: banner.id })
        .set(auth(admin))
        .expect(200)
    ).body as Envelope<{ items: { action: string }[] }>;
    expect(audit.data.items.map((a) => a.action)).toEqual(
      expect.arrayContaining(['banner.create', 'banner.edit', 'banner.remove']),
    );
  });

  it('the panel lists everything, live or not, and says which is live', async () => {
    const admin = await root();
    await create(admin, { placement: 'exclusive_offers', title: 'On' });
    await create(admin, { placement: 'exclusive_offers', title: 'Off', active: false });

    const all = (
      (await request(server()).get(`${V1}/admin/banners`).set(auth(admin)).expect(200))
        .body as Envelope<Banner[]>
    ).data;
    expect(all.map((b) => [b.title, b.live])).toEqual(
      expect.arrayContaining([
        ['On', true],
        ['Off', false],
      ]),
    );
  });

  it('takes only our own WebP pictures, sensible links and dates', async () => {
    const admin = await root();
    await request(server())
      .post(`${V1}/admin/banners/images`)
      .set(auth(admin))
      .set('Content-Type', 'image/png')
      .send(Buffer.from('\x89PNG\r\n\x1a\nnot really'))
      .expect(415);

    const url = await upload(admin);
    expect(url).toMatch(/\/banners\/[0-9a-f-]+\.webp$/);

    const post = (body: Record<string, unknown>) =>
      request(server())
        .post(`${V1}/admin/banners`)
        .set(auth(admin))
        .send({ placement: 'special_offers', title: 'Offer', imageUrl: url, ...body });

    // A picture from somewhere else.
    await post({ imageUrl: 'https://evil.example/x.webp' }).expect(400);
    // Only a web page over https, or an app path.
    await post({ linkUrl: 'javascript:alert(1)' }).expect(400);
    await post({ linkUrl: 'http://insecure.example' }).expect(400);
    await post({ linkUrl: '/wishlist' }).expect(201);
    // A placement that does not exist.
    await post({ placement: 'popup' }).expect(400);
    // Ending before it starts.
    await post({
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date().toISOString(),
    }).expect(400);
  });

  it('a content editor manages banners; support cannot touch them', async () => {
    const editor = await roleToken('content_editor');
    await create(editor, { placement: 'exclusive_offers', title: `By an editor ${seq}` });

    const support = await roleToken('support');
    await request(server()).get(`${V1}/admin/banners`).set(auth(support)).expect(403);
  });

  it('the app needs a signed-in user; a user cannot use the panel routes', async () => {
    await request(server()).get(`${V1}/home/banners`).expect(401);
    const user = await userToken();
    await request(server()).get(`${V1}/admin/banners`).set(auth(user)).expect(401);
  });
});
