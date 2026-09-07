import { ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import RedisMock from 'ioredis-mock';
import helmet from 'helmet';
import compression from 'compression';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { AllExceptionsFilter } from 'src/common/filters/all-exceptions.filter';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { NoSqlInjectionGuard } from 'src/common/guards/no-sql-injection.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { ResponseInterceptor } from 'src/common/interceptors/response.interceptor';
import { IdempotencyInterceptor } from 'src/common/idempotency/idempotency.interceptor';
import { RequestIdMiddleware } from 'src/common/middleware/request-id.middleware';
import { configuration } from 'src/config/configuration';
import { envValidationSchema } from 'src/config/env.validation';
import { MIGRATIONS, MigrationRunner } from 'src/infra/migrations';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { StorageModule } from 'src/infra/storage/storage.module';
import { VideoModule } from 'src/infra/video/video.module';
import { AdminModule } from 'src/modules/admin/admin.module';
import { AnalyticsModule } from 'src/modules/analytics/analytics.module';
import { AnalyticsRollupProcessor } from 'src/modules/analytics/analytics.processor';
import { AuthModule } from 'src/modules/auth/auth.module';
import { DashboardModule } from 'src/modules/dashboard/dashboard.module';
import { DiscoverModule } from 'src/modules/discover/discover.module';
import { EventsModule } from 'src/modules/events/events.module';
import { ChatModule } from 'src/modules/chat/chat.module';
import { GiftingModule } from 'src/modules/gifting/gifting.module';
import { OrdersModule } from 'src/modules/orders/orders.module';
import { GroupGiftModule } from 'src/modules/group-gifts/group-gift.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { NotificationProcessor } from 'src/modules/notifications/notification.processor';
import { MemoriesModule } from 'src/modules/memories/memories.module';
import { ReelsModule } from 'src/modules/reels/reels.module';
import { ReelProcessor } from 'src/modules/reels/reel.processor';
import { NotificationService } from 'src/modules/notifications/notification.service';
import { ThankYouService } from 'src/modules/notifications/thank-you.service';
import {
  NOTIFICATION_DIGEST_JOB,
  NOTIFICATION_DISPATCH_JOB,
  THANK_YOU_SEND_JOB,
  type DispatchJobData,
  type ThankYouSendJobData,
} from 'src/modules/notifications/notification.jobs';
import { MediaModule } from 'src/modules/media/media.module';
import { OnboardingModule } from 'src/modules/onboarding/onboarding.module';
import { ProfileModule } from 'src/modules/profile/profile.module';
import { TaxonomyModule } from 'src/modules/taxonomy/taxonomy.module';
import { UsersModule } from 'src/modules/users/users.module';
import { AffiliateSyncProcessor } from 'src/modules/products/affiliate-sync.processor';
import { ProductsModule } from 'src/modules/products/products.module';
import { WishlistsModule } from 'src/modules/wishlists/wishlists.module';
import { FakeMailer, FakePushSender, FakeSmsSender } from './fake-notifier';
import { FakeQueue } from './fake-queue';
import { TestInfraModule } from './test-infra.module';

export interface TestApp {
  app: INestApplication;
  redis: Redis;
  mailer: FakeMailer;
  sms: FakeSmsSender;
  /** Records device pushes, and can declare tokens the provider rejected. */
  push: FakePushSender;
  /** Records jobs enqueued on the scheduler queue (anonymization, reminders). */
  scheduler: FakeQueue;
  /** Records jobs enqueued on the notifications queue (dispatch, thank-you, digest). */
  notifications: FakeQueue;
  /** Records jobs enqueued on the reels queue (compile). Tests drive the compile service. */
  reels: FakeQueue;
  /** Records jobs enqueued on the analytics-rollup queue. Tests drive rollup directly. */
  analytics: FakeQueue;
  /**
   * Runs every immediate (non-delayed) notification job through the real
   * services — the in-process stand-in for the BullMQ worker. Delayed jobs
   * (quiet-hours defers, the 24h thank-you) are left on the queue to inspect.
   */
  drainNotifications: () => Promise<void>;
  /** Wipes rate-limit counters and OTP/denylist/cache keys between tests. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Boots the real HTTP stack — same pipes, filter, interceptor, and guard chain
 * as main.ts — against an in-memory Mongo and an in-memory Redis.
 *
 * QueueModule and HealthModule are left out: BullMQ opens a real socket on
 * construction. The scheduler queue is injected as a FakeQueue instead, so the
 * scheduling *decisions* are still asserted (see fake-queue.ts).
 */
export async function createTestApp(
  options: { throttle?: { limit: number; ttlSeconds: number } } = {},
): Promise<TestApp> {
  // A single-node REPLICA SET, not a standalone mongod.
  //
  // Mongo only supports transactions on a replica set, and the item reorder
  // runs in one. A standalone here would make every transactional path fail in
  // tests while working in dev and prod (docker-compose.yml also runs rs0) —
  // the test environment must not be the only place without transactions.
  const mongod = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  const redis = new RedisMock();
  const mailer = new FakeMailer();
  const sms = new FakeSmsSender();
  const push = new FakePushSender();
  const scheduler = new FakeQueue();
  const notifications = new FakeQueue();
  const reels = new FakeQueue();
  const analytics = new FakeQueue();

  const throttleLimit = options.throttle?.limit ?? 1_000;
  const throttleTtl = (options.throttle?.ttlSeconds ?? 60) * 1_000;

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [configuration],
        validationSchema: envValidationSchema,
        cache: false,
        ignoreEnvFile: true,
      }),
      MongooseModule.forRoot(mongod.getUri(), { dbName: 'wishtick_test' }),
      // Deliberately the DEFAULT in-memory storage, not the Redis storage
      // AppModule uses.
      //
      // ThrottlerStorageRedisService only adopts a client that passes
      // `instanceof Redis`; anything else it treats as connection *options* and
      // silently constructs a real ioredis client from. An ioredis-mock fails
      // that check, so passing one here does not wire up the mock — it opens a
      // real connection to localhost:6379, quietly rate-limits against whatever
      // Redis happens to be running on the dev machine, and leaks counters
      // between runs (and hangs the suite on the open handle).
      //
      // The throttler name must stay 'default' to match @Throttle in
      // AuthController — see the comment there.
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'default', ttl: throttleTtl, limit: throttleLimit }],
      }),
      EventEmitterModule.forRoot({ global: true }),
      TestInfraModule.forRoot({ redis, mailer, sms, push }),
      // The real StorageModule, not a fake: STORAGE_DRIVER=local in the test
      // env, so it selects the local adapter and uploads land in a temp dir.
      // Faking it here would leave the presign → PUT → confirm path — the part
      // most likely to break — exercised by nothing.
      StorageModule,
      // Global in the real app, so nothing below names it — but this list is
      // not AppModule's, and MediaService injects the VIDEO token from it.
      // Without it no suite that boots MediaModule gets past DI.
      // VIDEO_DRIVER defaults to `storage`, so this is the passthrough adapter.
      VideoModule,
      UsersModule,
      AuthModule,
      TaxonomyModule,
      MediaModule,
      ProfileModule,
      OnboardingModule,
      WishlistsModule,
      EventsModule,
      ProductsModule,
      GiftingModule,
      OrdersModule,
      GroupGiftModule,
      ChatModule,
      NotificationsModule,
      ReelsModule,
      MemoriesModule,
      DashboardModule,
      DiscoverModule,
      AnalyticsModule,
      AdminModule,
    ],
    providers: [
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      // Same order as AppModule: inside the response wrapper, so it caches the
      // raw handler output and replays it back through ResponseInterceptor.
      { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      // Same guard order as AppModule: reject injection first, then throttle,
      // authenticate, authorize.
      { provide: APP_GUARD, useClass: NoSqlInjectionGuard },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
    ],
  })
    .overrideProvider(getQueueToken(QUEUE.SCHEDULER))
    .useValue(scheduler)
    // Registers a repeatable schedule in onModuleInit and would start a real
    // worker. Tests drive AffiliateSyncService.syncReferencedProducts() directly.
    .overrideProvider(AffiliateSyncProcessor)
    .useValue({})
    .overrideProvider(getQueueToken(QUEUE.AFFILIATE_SYNC))
    .useValue(new FakeQueue())
    // Same reason as the other processors: its @Processor would open a real
    // BullMQ worker. Tests drain the FakeQueue through the services instead.
    .overrideProvider(NotificationProcessor)
    .useValue({})
    .overrideProvider(getQueueToken(QUEUE.NOTIFICATIONS))
    .useValue(notifications)
    // ffmpeg is far too heavy to run on every enqueue; tests drive
    // ReelCompileService.compile() directly when they want a real render.
    .overrideProvider(ReelProcessor)
    .useValue({})
    .overrideProvider(getQueueToken(QUEUE.REELS))
    .useValue(reels)
    // Its onModuleInit schedules two repeatable cron jobs and would open a real
    // BullMQ worker. Tests call AnalyticsService.rollupDay()/rollupRecent()
    // directly and inspect the FakeQueue for the scheduled decisions.
    .overrideProvider(AnalyticsRollupProcessor)
    .useValue({})
    .overrideProvider(getQueueToken(QUEUE.ANALYTICS_ROLLUP))
    .useValue(analytics)
    .compile();

  // rawBody: true matches main.ts — the affiliate webhook needs req.rawBody to
  // verify its HMAC over the exact received bytes (the global JSON parser runs
  // before module middleware, so a raw-body middleware cannot capture them).
  const app = moduleRef.createNestApplication({ rawBody: true });

  // Match main.ts: trust the first proxy hop so req.ip reflects X-Forwarded-For.
  // The per-IP throttler keys on req.ip, so a test that needs to look like N
  // distinct clients (the 50-reserver race) can set a distinct XFF per request;
  // requests without an XFF still fall back to the socket address as before.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Match main.ts's edge middleware so the security headers + compression are
  // exercised by the e2e suite exactly as they ship.
  app.use(helmet());
  app.use(compression());

  const requestId = new RequestIdMiddleware();
  app.use(requestId.use.bind(requestId));
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validateCustomDecorators: true,
    }),
  );

  await app.init();

  // Run the real migrations rather than hand-seeding fixtures. The taxonomy is
  // a product asset, so a test that seeds its own copy would pass while the
  // shipped seed was broken — and onboarding validates every key against it.
  const connection = app.get<Connection>(getConnectionToken());
  await new MigrationRunner(connection.db!, MIGRATIONS).up();

  const throttlerStorage = app.get<ThrottlerStorage & { storage?: Map<string, unknown> }>(
    ThrottlerStorage,
  );

  const drainNotifications = async (): Promise<void> => {
    const svc = app.get(NotificationService);
    const thankYou = app.get(ThankYouService);
    // Loop until no immediate job remains — dispatch can enqueue further immediate
    // jobs (a thank-you send fans out its own dispatch).
    for (;;) {
      const job = notifications.added.find((j) => !j.opts.delay);
      if (!job) break;
      notifications.added.splice(notifications.added.indexOf(job), 1);
      if (job.name === NOTIFICATION_DISPATCH_JOB) {
        await svc.dispatch(job.data as DispatchJobData);
      } else if (job.name === THANK_YOU_SEND_JOB) {
        await thankYou.fireScheduled((job.data as ThankYouSendJobData).noteId);
      } else if (job.name === NOTIFICATION_DIGEST_JOB) {
        await svc.runDailyDigest();
      }
    }
  };

  return {
    app,
    redis,
    mailer,
    sms,
    push,
    scheduler,
    notifications,
    reels,
    analytics,
    drainNotifications,
    reset: async () => {
      throttlerStorage.storage?.clear();
      // Clears throttle counters, OTP codes, the access-token denylist, and the
      // taxonomy/dashboard caches. The taxonomy simply re-reads from Mongo.
      await redis.flushall();
      mailer.reset();
      sms.reset();
      scheduler.reset();
      notifications.reset();
      reels.reset();
      analytics.reset();
    },
    close: async () => {
      // Order matters: close the app (and its Mongo connection) before killing
      // the server it points at, or Mongoose retries against a dead socket and
      // Jest hangs on the open handle.
      await app.close();
      await mongod.stop();
    },
  };
}

/** Base path for v1 routes, matching main.ts's prefix + URI versioning. */
export const V1 = '/api/v1';
