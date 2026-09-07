import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfig } from 'src/config/configuration';
import { buildRedisOptions } from 'src/infra/redis/redis.module';

/**
 * Socket.IO adapter backed by Redis pub/sub, so the gateway scales horizontally
 * from day one: a message emitted on one instance reaches clients connected to
 * every other instance.
 *
 * The pub/sub pair is built with `withKeyPrefix: false` — the redis-adapter owns
 * its own channel names and must not inherit the app's `keyPrefix` — mirroring
 * exactly how the ThrottlerModule builds its client. `maxRetriesPerRequest: null`
 * (already in the shared options) is what lets the blocking subscribe work.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const appCfg = this.config.get('app', { infer: true });
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: appCfg.corsOrigins.includes('*') ? true : appCfg.corsOrigins,
        credentials: true,
      },
    }) as Server;

    this.pubClient = new Redis(buildRedisOptions(this.config, { withKeyPrefix: false }));
    this.subClient = this.pubClient.duplicate();
    for (const [name, client] of [
      ['pub', this.pubClient],
      ['sub', this.subClient],
    ] as const) {
      client.on('error', (err: Error) =>
        this.logger.error(`Socket.IO Redis ${name} client error: ${err.message}`),
      );
    }

    server.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log('Socket.IO Redis adapter attached');
    return server;
  }

  /** Drain the pub/sub connections on shutdown so the process can exit cleanly. */
  async closeRedis(): Promise<void> {
    await Promise.allSettled([this.pubClient?.quit(), this.subClient?.quit()]);
  }
}
