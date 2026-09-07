import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  get client(): Redis {
    return this.redis;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Cache key ${key} held unparseable JSON; treating as a miss`);
      return null;
    }
  }

  /**
   * Every cached value carries a TTL. There is deliberately no infinite-TTL
   * overload — an un-expiring cache entry is a stale-data incident waiting to
   * happen (see the cache audit in Sprint 12).
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  /** Read-through helper: returns the cached value or computes, stores, and returns it. */
  async wrap<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /** Deletes every key matching a pattern using SCAN (never KEYS — it blocks Redis). */
  async delByPattern(pattern: string): Promise<number> {
    const prefix = this.redis.options.keyPrefix ?? '';
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${prefix}${pattern}`,
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length > 0) {
        // SCAN returns fully-prefixed keys, but DEL re-applies keyPrefix — strip it first.
        const unprefixed = keys.map((k) =>
          prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k,
        );
        deleted += await this.redis.del(...unprefixed);
      }
    } while (cursor !== '0');
    return deleted;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
