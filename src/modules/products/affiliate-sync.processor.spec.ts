import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { AppConfig } from 'src/config/configuration';
import { AffiliateSyncProcessor } from './affiliate-sync.processor';
import { SEARCH_PREWARM_JOB } from './search-prewarm.service';
import type { AffiliateSyncService } from './affiliate-sync.service';
import type { ConversionSyncService } from './affiliate/conversion-sync.service';
import type { SearchPrewarmService } from './search-prewarm.service';

/**
 * What the processor schedules on boot.
 *
 * The prewarm spends real SerpApi searches against a monthly quota, so the
 * flag that turns it off has to actually turn it off — including a schedule an
 * earlier boot left behind in Redis, which no amount of *not* re-adding it
 * will clear.
 */
describe('AffiliateSyncProcessor scheduling', () => {
  const build = ({
    prewarmEnabled,
    existing = [],
  }: {
    prewarmEnabled: boolean;
    existing?: { name: string; key: string }[];
  }) => {
    const added: { name: string; opts: Record<string, unknown> }[] = [];
    const removedKeys: string[] = [];
    const queue = {
      add: (name: string, _data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, opts });
        return Promise.resolve();
      },
      getRepeatableJobs: () => Promise.resolve(existing),
      removeRepeatableByKey: (key: string) => {
        removedKeys.push(key);
        return Promise.resolve();
      },
    } as unknown as Queue;

    const config = {
      get: () => ({ prewarmEnabled, prewarmCron: '20 */4 * * *' }),
    } as unknown as ConfigService<AppConfig, true>;

    const processor = new AffiliateSyncProcessor(
      {} as AffiliateSyncService,
      {} as ConversionSyncService,
      {} as SearchPrewarmService,
      config,
      queue,
    );
    return { processor, added, removedKeys };
  };

  it('schedules the prewarm when it is enabled', async () => {
    const { processor, added, removedKeys } = build({ prewarmEnabled: true });

    await processor.onModuleInit();

    const prewarm = added.find((job) => job.name === SEARCH_PREWARM_JOB);
    expect(prewarm).toBeDefined();
    expect(prewarm!.opts.repeat).toMatchObject({ pattern: '20 */4 * * *' });
    expect(removedKeys).toHaveLength(0);
  });

  it('does not schedule it when it is disabled', async () => {
    const { processor, added } = build({ prewarmEnabled: false });

    await processor.onModuleInit();

    expect(added.map((job) => job.name)).not.toContain(SEARCH_PREWARM_JOB);
  });

  // The bug this exists for: a repeatable lives in Redis, so an earlier boot's
  // schedule outlives the flag and goes on spending searches.
  it('removes a schedule an earlier boot left behind', async () => {
    const { processor, removedKeys } = build({
      prewarmEnabled: false,
      existing: [
        { name: SEARCH_PREWARM_JOB, key: 'search-prewarm:::20 */4 * * *' },
        { name: 'affiliate-conversion-sync', key: 'conversions:::40 * * * *' },
      ],
    });

    await processor.onModuleInit();

    // Only the prewarm: the hourly conversion sync is nobody's quota.
    expect(removedKeys).toEqual(['search-prewarm:::20 */4 * * *']);
  });

  // Matched on name, not on the cron the flag now hides: a schedule registered
  // under an older pattern must still be reachable by the config disabling it.
  it('removes a schedule registered under a different cron', async () => {
    const { processor, removedKeys } = build({
      prewarmEnabled: false,
      existing: [{ name: SEARCH_PREWARM_JOB, key: 'search-prewarm:::0 * * * *' }],
    });

    await processor.onModuleInit();

    expect(removedKeys).toEqual(['search-prewarm:::0 * * * *']);
  });
});
