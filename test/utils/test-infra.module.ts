import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import { REDIS_CLIENT } from 'src/infra/redis/redis.constants';
import { MAILER, type IMailer } from 'src/infra/notifier/mailer.port';
import { PUSH_SENDER, type IPushSender } from 'src/infra/notifier/push.port';
import { SMS_SENDER, type ISmsSender } from 'src/infra/notifier/sms.port';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';

/**
 * Test-time stand-in for RedisModule + NotifierModule + the QueueModule's
 * SchedulerRegistry.
 *
 * It must be @Global for the same reason those are: feature modules inject
 * CacheService / SchedulerRegistry without importing anything, so a non-global
 * provider is invisible to them. The real SchedulerRegistry is used (not a
 * fake) so the registrars' handler registrations run exactly as in production;
 * there is just no dispatcher Worker consuming the queue.
 */
@Global()
@Module({})
export class TestInfraModule {
  static forRoot(deps: {
    redis: Redis;
    mailer: IMailer;
    sms: ISmsSender;
    push: IPushSender;
  }): DynamicModule {
    return {
      module: TestInfraModule,
      providers: [
        { provide: REDIS_CLIENT, useValue: deps.redis },
        CacheService,
        LockService,
        SchedulerRegistry,
        { provide: MAILER, useValue: deps.mailer },
        { provide: SMS_SENDER, useValue: deps.sms },
        { provide: PUSH_SENDER, useValue: deps.push },
      ],
      exports: [
        REDIS_CLIENT,
        CacheService,
        LockService,
        SchedulerRegistry,
        MAILER,
        SMS_SENDER,
        PUSH_SENDER,
      ],
    };
  }
}
