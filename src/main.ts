import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';
import { RedisIoAdapter } from './infra/ws/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // rawBody: true makes the built-in parsers stash the exact received bytes on
  // req.rawBody. The affiliate webhook verifies an HMAC over those bytes, and the
  // global JSON parser runs before any module middleware (see NestApplication.init:
  // parser first, then module middleware), so a raw-body middleware can never win
  // the race for an application/json request — the parser has already consumed the
  // stream. Capturing rawBody at parse time is the only ordering that works.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService<AppConfig, true>);
  const appCfg = config.get('app', { infer: true });

  app.use(helmet());
  // gzip response bodies — the list and dashboard payloads are the ones that
  // benefit, and the CPU cost is negligible next to the bytes saved on mobile.
  app.use(compression());
  app.set('trust proxy', 1);

  // Back the chat gateway with the Redis adapter so a message emitted on one
  // instance reaches clients connected to any other — horizontal scale from the
  // first deploy, not a later retrofit.
  app.useWebSocketAdapter(new RedisIoAdapter(app, config));

  app.enableCors({
    origin: appCfg.corsOrigins.includes('*') ? true : appCfg.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
  });

  // /health and /ready sit outside the prefix so orchestrators can probe them
  // without knowing about API versioning.
  app.setGlobalPrefix(appCfg.apiPrefix, { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      // whitelist strips unknown properties; forbidNonWhitelisted rejects them
      // outright. Together they stop mass-assignment — a client cannot smuggle
      // `roles: ["admin"]` into a signup body.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validateCustomDecorators: true,
    }),
  );

  // Drains in-flight HTTP requests, BullMQ workers, and Mongo/Redis connections
  // instead of dropping them on SIGTERM during a rolling deploy.
  app.enableShutdownHooks();

  if (appCfg.swaggerEnabled && !appCfg.isProduction) {
    const doc = new DocumentBuilder()
      .setTitle('Wishtick API')
      .setDescription(
        'Wishtick MVP backend.\n\n' +
          'Successful responses are wrapped as `{success, data, requestId, timestamp}`.\n' +
          'Errors are `{success: false, error: {code, message, details}}` — branch on `error.code`, never on the message.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth', 'Signup, login, sessions, verification, password reset')
      .addTag('profile', 'The authenticated user, preferences, account lifecycle, data export')
      .addTag('onboarding', 'Server-driven onboarding steps and options')
      .addTag('taxonomy', 'The seeded option catalogue behind preferences')
      .addTag('media', 'Presigned uploads and confirmation')
      .addTag('wishlists', 'Wishlists, items, participants, share links')
      .addTag('products', 'Catalogue search, affiliate import, URL resolution')
      .addTag('events', 'Events, invites, RSVP, reminders')
      .addTag('gifting', 'Reservations, offline gifts, fulfilment')
      .addTag('group-gifts', 'Group gifts, contributions, funding')
      .addTag('chat', 'Wishlist and group-gift chat')
      .addTag('notifications', 'In-app notifications, preferences, thank-you notes')
      .addTag('reels', 'Birthday wish collection, time-locked release, compilation')
      .addTag('moderation', 'User reporting intake')
      .addTag('analytics', 'Event ingestion')
      .addTag('admin', 'Operator plane: users, moderation, analytics, audit')
      .addTag('dashboard', 'The profile summary sections')
      .addTag('health', 'Liveness and readiness probes')
      .build();

    SwaggerModule.setup(`${appCfg.apiPrefix}/docs`, app, SwaggerModule.createDocument(app, doc), {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(appCfg.port, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(`Wishtick API listening on port ${appCfg.port} [${appCfg.env}]`);
  if (appCfg.swaggerEnabled && !appCfg.isProduction) {
    logger.log(`Swagger UI at ${appCfg.appUrl}/${appCfg.apiPrefix}/docs`);
  }
}

void bootstrap();
