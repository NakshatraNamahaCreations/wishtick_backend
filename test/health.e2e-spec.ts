import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthCheckService, MongooseHealthIndicator, TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from 'src/modules/health/health.controller';
import { QueueHealthIndicator } from 'src/modules/health/indicators/queue.health';
import { RedisHealthIndicator } from 'src/modules/health/indicators/redis.health';

/**
 * Guards the *routing* of the probes, not their checks.
 *
 * This exists because /health and /ready silently moved to /v1/health once URI
 * versioning was enabled: the global-prefix `exclude` skips the prefix but not
 * the version. Nothing failed — the app booted happily and every auth test
 * passed — while an orchestrator would have 404'd on liveness and restarted
 * every healthy pod forever. A probe that answers on the wrong path is worse
 * than no probe, so the path itself is asserted.
 *
 * The indicators are stubbed: the real ones need Mongo, Redis, and a BullMQ
 * connection, and this suite is about where the routes live.
 */
describe('Health routing (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        { provide: RedisHealthIndicator, useValue: { check: jest.fn() } },
        { provide: QueueHealthIndicator, useValue: { check: jest.fn() } },
        { provide: MongooseHealthIndicator, useValue: { pingCheck: jest.fn() } },
        {
          provide: HealthCheckService,
          useValue: { check: jest.fn().mockResolvedValue({ status: 'ok', details: {} }) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts exactly — the bug lived in this combination, so weakening
    // it here would make the test worthless.
    app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves liveness at /health — unprefixed and unversioned', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', uptimeSeconds: expect.any(Number) });
  });

  it('serves readiness at /ready — unprefixed and unversioned', async () => {
    await request(app.getHttpServer()).get('/ready').expect(200);
  });

  it('does not expose the probes under the versioned API surface', async () => {
    // If these ever start answering, versioning has leaked back onto the probes.
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
    await request(app.getHttpServer()).get('/v1/health').expect(404);
  });
});
