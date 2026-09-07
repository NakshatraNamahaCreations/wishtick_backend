import { Global, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from './cache.service';
import { LockService } from './lock.service';
import { REDIS_CLIENT } from './redis.constants';

const logger = new Logger('RedisModule');

export const buildRedisOptions = (
  config: ConfigService<AppConfig, true>,
  /** BullMQ manages its own key namespace, so it must not inherit our keyPrefix. */
  opts: { withKeyPrefix: boolean },
) => {
  const redis = config.get('redis', { infer: true });
  return {
    host: redis.host,
    port: redis.port,
    password: redis.password,
    db: redis.db,
    ...(redis.tls ? { tls: {} } : {}),
    ...(opts.withKeyPrefix ? { keyPrefix: redis.keyPrefix } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number): number => Math.min(times * 200, 5_000),
  };
};

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Redis => {
        const client = new Redis(buildRedisOptions(config, { withKeyPrefix: true }));
        client.on('connect', () => logger.log('Redis connected'));
        client.on('ready', () => logger.log('Redis ready'));
        client.on('error', (err: Error) => logger.error(`Redis error: ${err.message}`));
        client.on('close', () => logger.warn('Redis connection closed'));
        return client;
      },
    },
    CacheService,
    LockService,
  ],
  exports: [REDIS_CLIENT, CacheService, LockService],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly cache: CacheService) {}

  async onApplicationShutdown(): Promise<void> {
    await this.cache.disconnect();
  }
}
