import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { CacheService } from 'src/infra/redis/cache.service';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly cache: CacheService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async check(key = 'redis'): Promise<HealthIndicatorResult> {
    const check = this.indicator.check(key);
    const startedAt = Date.now();
    const ok = await this.cache.ping();
    const latencyMs = Date.now() - startedAt;

    return ok ? check.up({ latencyMs }) : check.down({ message: 'Redis PING failed' });
  }
}
