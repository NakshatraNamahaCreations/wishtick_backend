import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MongooseHealthIndicator } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { QueueHealthIndicator } from './indicators/queue.health';
import { RedisHealthIndicator } from './indicators/redis.health';

/**
 * VERSION_NEUTRAL is load-bearing. main.ts enables URI versioning with a
 * default of v1, which otherwise rewrites these routes to /v1/health and
 * /v1/ready — and the global prefix `exclude` does NOT exclude them from
 * versioning. An orchestrator probing /health would then get 404 and restart
 * every healthy pod in a loop. Probes are infrastructure contracts, not API
 * surface, so they must never carry a version.
 */
@ApiTags('health')
@Controller({ version: VERSION_NEUTRAL })
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongo: MongooseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly queue: QueueHealthIndicator,
  ) {}

  /**
   * Liveness: is the process itself alive? Deliberately checks no dependencies —
   * a Redis blip must not make the orchestrator kill and restart a healthy pod.
   */
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: string; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** Readiness: can this instance actually serve traffic? Checks every dependency. */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (Mongo + Redis + queue)' })
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.mongo.pingCheck('mongo', { timeout: 3_000 }),
      () => this.redis.check('redis'),
      () => this.queue.check('queue'),
    ]);
  }
}
