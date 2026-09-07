import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { NoSqlInjectionGuard } from './common/guards/no-sql-injection.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { configuration, type AppConfig } from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { MongoModule } from './infra/mongo/mongo.module';
import { NotifierModule } from './infra/notifier/notifier.module';
import { QueueModule } from './infra/queue/queue.module';
import { buildRedisOptions, RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.module';
import { VideoModule } from './infra/video/video.module';
import { AdminModule } from './modules/admin/admin.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DiscoverModule } from './modules/discover/discover.module';
import { EventsModule } from './modules/events/events.module';
import { GiftingModule } from './modules/gifting/gifting.module';
import { OrdersModule } from './modules/orders/orders.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MemoriesModule } from './modules/memories/memories.module';
import { ReelsModule } from './modules/reels/reels.module';
import { GroupGiftModule } from './modules/group-gifts/group-gift.module';
import { HealthModule } from './modules/health/health.module';
import { MediaModule } from './modules/media/media.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { ProductsModule } from './modules/products/products.module';
import { ProfileModule } from './modules/profile/profile.module';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module';
import { UsersModule } from './modules/users/users.module';
import { WishlistsModule } from './modules/wishlists/wishlists.module';
import { WishmatesModule } from './modules/wishmates/wishmates.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
      cache: true,
    }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const app = config.get('app', { infer: true });
        return {
          pinoHttp: {
            level: app.logLevel,
            // Correlates every log line with the x-request-id we echo to clients.
            // RequestIdMiddleware always sets this; the fallback only exists for
            // requests that bypass middleware entirely.
            genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
            transport: app.isProduction
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true, colorize: true } },
            // Credentials and tokens must never reach the log store.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.refreshToken',
                'req.body.token',
                'req.body.code',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            autoLogging: {
              ignore: (req) => ['/health', '/ready'].includes((req.url ?? '').split('?')[0]),
            },
          },
        };
      },
    }),

    // Redis-backed so limits are shared across instances. An in-memory store
    // would let an attacker multiply their budget by the number of pods.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const throttle = config.get('throttle', { infer: true });
        return {
          throttlers: [
            { name: 'default', ttl: throttle.ttlSeconds * 1_000, limit: throttle.limit },
          ],
          storage: new ThrottlerStorageRedisService(
            buildRedisOptions(config, { withKeyPrefix: false }),
          ),
        };
      },
    }),

    EventEmitterModule.forRoot({ global: true, maxListeners: 20 }),

    MongoModule,
    RedisModule,
    QueueModule,
    NotifierModule,
    StorageModule,
    VideoModule,

    HealthModule,
    UsersModule,
    AuthModule,
    TaxonomyModule,
    MediaModule,
    ProfileModule,
    OnboardingModule,
    WishlistsModule,
    WishmatesModule,
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
    // Analytics is imported before Admin because AdminModule depends on it.
    AnalyticsModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // Registered AFTER ResponseInterceptor, so it runs INSIDE the response
    // wrapper: it caches the handler's raw output and, on replay, returns that
    // raw value back through ResponseInterceptor for a consistently-shaped,
    // freshly-stamped envelope.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // Order matters. Reject operator-injection first (cheapest, no I/O), then
    // throttle so an unauthenticated flood is cheap to reject, then authenticate,
    // then authorize.
    { provide: APP_GUARD, useClass: NoSqlInjectionGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // '{*path}' is the path-to-regexp v8 spelling Nest 11 expects; a bare '*'
    // still works but only via a deprecation shim that logs on every boot.
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
