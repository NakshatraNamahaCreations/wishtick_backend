import request from 'supertest';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  PlayStoreClient,
  PlayStoreError,
  type PlayRelease,
} from 'src/modules/app-version/play-store.client';
import { createTestApp, V1, type TestApp } from './utils/test-app';

const ADMIN_EMAIL = 'root@wishtick.test';
const ADMIN_PASSWORD = 'RootAdminPassw0rd!';

interface Envelope<T> {
  data: T;
  error?: { code: string };
}
interface Check {
  status: 'ok' | 'optional' | 'required';
  latestVersionCode: number;
  latestVersionName: string | null;
  minVersionCode: number;
  storeUrl: string;
  message: string | null;
}
interface Policy {
  platform: string;
  latestVersionCode: number;
  minVersionCode: number;
  forced: boolean;
  storeUrl: string;
  updatedBy: string | null;
}

/**
 * The app's update prompt and force update: set in the admin panel, read by
 * every build at launch, signed in or not.
 */
describe('App version (e2e)', () => {
  let ctx: TestApp;
  let app: INestApplication;
  let seq = 0;

  const server = (): Server => app.getHttpServer() as Server;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const adminToken = async (email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> => {
    const res = await request(server())
      .post(`${V1}/admin/auth/login`)
      .send({ email, password })
      .expect(200);
    return (res.body as Envelope<{ accessToken: string }>).data.accessToken;
  };
  let rootToken: string | null = null;
  const root = async (): Promise<string> => (rootToken ??= await adminToken());

  const roleToken = async (role: string): Promise<string> => {
    const email = `${role}-appver-${++seq}-${Date.now()}@wishtick.test`;
    const password = 'a-long-enough-password';
    await request(server())
      .post(`${V1}/admin/admins`)
      .set(auth(await root()))
      .send({ email, password, name: role, roles: [role] })
      .expect(201);
    return adminToken(email, password);
  };

  const check = async (versionCode: number): Promise<Check> =>
    (
      (
        await request(server())
          .get(`${V1}/app/version`)
          .query({ platform: 'android', versionCode })
          .expect(200)
      ).body as Envelope<Check>
    ).data;

  const save = (token: string, body: Record<string, unknown>) =>
    request(server()).put(`${V1}/admin/app-version/android`).set(auth(token)).send(body);

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
    await app
      .get<Connection>(getConnectionToken())
      .db!.collection('app_version_policy')
      .deleteMany({});
  });

  it('with no policy, every build is current and is sent to the Play listing', async () => {
    const res = await check(1);
    expect(res.status).toBe('ok');
    expect(res.storeUrl).toBe(
      'https://play.google.com/store/apps/details?id=com.wishtick.wishtick',
    );
  });

  it('is answered with no sign-in at all', async () => {
    await request(server())
      .get(`${V1}/app/version`)
      .query({ platform: 'android', versionCode: 2 })
      .expect(200);
  });

  it('refuses a request with no build number or an unknown platform', async () => {
    await request(server()).get(`${V1}/app/version`).query({ platform: 'android' }).expect(400);
    await request(server())
      .get(`${V1}/app/version`)
      .query({ platform: 'windows', versionCode: 2 })
      .expect(400);
  });

  it('a new latest version is offered to older builds, at once', async () => {
    await check(2); // warms the cache, which the save must clear
    await save(await root(), {
      latestVersionCode: 3,
      latestVersionName: '1.0.2',
      minVersionCode: 0,
      message: 'A fresh new Home screen',
    }).expect(200);

    const old = await check(2);
    expect(old.status).toBe('optional');
    expect(old.latestVersionName).toBe('1.0.2');
    expect(old.message).toBe('A fresh new Home screen');
    expect((await check(3)).status).toBe('ok');
  });

  it('a force update blocks builds below the minimum, and only those', async () => {
    const admin = await root();
    await save(admin, {
      latestVersionCode: 5,
      latestVersionName: '1.0.4',
      minVersionCode: 3,
      minVersionName: '1.0.2',
    }).expect(200);

    expect((await check(2)).status).toBe('required');
    expect((await check(3)).status).toBe('optional');
    expect((await check(5)).status).toBe('ok');

    // Turned off again: the old build is only offered the update.
    await save(admin, { latestVersionCode: 5, minVersionCode: 0 }).expect(200);
    expect((await check(2)).status).toBe('optional');
  });

  it('cannot force a build the store does not have yet', async () => {
    await save(await root(), { latestVersionCode: 3, minVersionCode: 4 }).expect(400);
  });

  it('takes only store links', async () => {
    await save(await root(), {
      latestVersionCode: 3,
      minVersionCode: 0,
      storeUrl: 'https://example.com/wishtick.apk',
    }).expect(400);
  });

  it('the panel shows each platform, and the save is audited as a force update', async () => {
    const admin = await root();
    await save(admin, {
      latestVersionCode: 3,
      minVersionCode: 3,
      reason: 'Security fix in 1.0.2',
    }).expect(200);

    const list = (
      (await request(server()).get(`${V1}/admin/app-version`).set(auth(admin)).expect(200))
        .body as Envelope<Policy[]>
    ).data;
    const android = list.find((p) => p.platform === 'android')!;
    expect(android.forced).toBe(true);
    expect(android.updatedBy).not.toBeNull();
    expect(list.map((p) => p.platform)).toEqual(['android', 'ios']);

    const audit = await app
      .get<Connection>(getConnectionToken())
      .db!.collection('audit_logs')
      .findOne({ targetType: 'app_version' });
    expect(audit?.action).toBe('app_version.force_on');
  });

  it('saving needs ops:manage; a support agent cannot', async () => {
    const support = await roleToken('support');
    await save(support, { latestVersionCode: 3, minVersionCode: 3 }).expect(403);
  });

  describe('Google Play sync', () => {
    interface PlayView {
      latestVersionCode: number;
      latestVersionName: string | null;
      message: string | null;
      minVersionCode: number;
      play: {
        connected: boolean;
        ok: boolean | null;
        error: string | null;
        liveVersionCode: number | null;
        rolloutVersionCode: number | null;
        rolloutPercent: number | null;
        advancedAt: string | null;
      };
    }

    const release = (over: Partial<PlayRelease>): PlayRelease => ({
      versionCode: 3,
      versionName: '1.0.2',
      status: 'completed',
      userFraction: null,
      notes: null,
      ...over,
    });

    /** Play, as the test wants it: connected, and answering [answer]. */
    const playAnswers = (answer: PlayRelease[] | Error) => {
      const client = app.get(PlayStoreClient);
      jest.spyOn(client, 'configured', 'get').mockReturnValue(true);
      jest
        .spyOn(client, 'productionReleases')
        .mockImplementation(() =>
          answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
        );
    };

    const refresh = async (token: string, status = 200): Promise<PlayView> =>
      (
        (
          await request(server())
            .post(`${V1}/admin/app-version/android/sync`)
            .set(auth(token))
            .expect(status)
        ).body as Envelope<PlayView>
      ).data;

    afterEach(() => jest.restoreAllMocks());

    it('with no service account, Refresh says Play is not connected', async () => {
      await request(server())
        .post(`${V1}/admin/app-version/android/sync`)
        .set(auth(await root()))
        .expect(409);
    });

    it("a build out to everyone becomes the latest, with Play's What's new", async () => {
      playAnswers([
        release({ versionCode: 2, versionName: '1.0.1' }),
        release({ notes: 'A fresh new Home screen' }),
      ]);
      const view = await refresh(await root());

      expect(view.latestVersionCode).toBe(3);
      expect(view.latestVersionName).toBe('1.0.2');
      expect(view.message).toBe('A fresh new Home screen');
      expect(view.play).toMatchObject({ connected: true, ok: true, liveVersionCode: 3 });
      expect(view.play.advancedAt).not.toBeNull();

      // The app hears of it at once.
      const old = await check(2);
      expect(old.status).toBe('optional');
      expect(old.message).toBe('A fresh new Home screen');

      const audit = await app
        .get<Connection>(getConnectionToken())
        .db!.collection('audit_logs')
        .findOne({ action: 'app_version.play_sync' });
      expect(audit).not.toBeNull();
    });

    it('a staged rollout is shown, but not offered until it reaches 100%', async () => {
      const admin = await root();
      playAnswers([
        release({}),
        release({ versionCode: 4, versionName: '1.0.3', status: 'inProgress', userFraction: 0.2 }),
      ]);
      const view = await refresh(admin);

      expect(view.latestVersionCode).toBe(3);
      expect(view.play.rolloutVersionCode).toBe(4);
      expect(view.play.rolloutPercent).toBe(20);
      expect((await check(3)).status).toBe('ok');
    });

    it('never touches the force update, and never moves the version down', async () => {
      const admin = await root();
      await save(admin, { latestVersionCode: 5, minVersionCode: 3 }).expect(200);
      playAnswers([release({ versionCode: 4, versionName: '1.0.3' })]);

      const view = await refresh(admin);
      expect(view.latestVersionCode).toBe(5);
      expect(view.minVersionCode).toBe(3);
    });

    it('a failed read is shown and changes nothing', async () => {
      const admin = await root();
      await save(admin, { latestVersionCode: 3, minVersionCode: 0 }).expect(200);
      playAnswers(new PlayStoreError('Google Play refused the service account.'));

      const view = await refresh(admin);
      expect(view.latestVersionCode).toBe(3);
      expect(view.play.ok).toBe(false);
      expect(view.play.error).toBe('Google Play refused the service account.');
    });

    it('Refresh needs ops:manage', async () => {
      playAnswers([release({})]);
      await refresh(await roleToken('support'), 403);
    });
  });
});
