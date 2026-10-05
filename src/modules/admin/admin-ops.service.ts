import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectConnection } from '@nestjs/mongoose';
import type { Job, JobType, Queue } from 'bullmq';
import { Connection, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { MIGRATIONS, MigrationRunner } from 'src/infra/migrations';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { CacheService } from 'src/infra/redis/cache.service';
import { ProviderGuard } from 'src/modules/products/providers/provider-guard.service';
import { ProductsService } from 'src/modules/products/products.service';
import {
  DAILY_SEARCH_BUDGET,
  DAILY_SEARCH_HARD_CAP,
  VendorBudgetService,
} from 'src/modules/suggestions/vendor-budget.service';
import type { AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

/** The job states an admin can list. */
export const JOB_STATES = ['failed', 'waiting', 'active', 'delayed', 'completed'] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * Caches an admin may clear, by name. Only caches: never the counters,
 * budgets, rate limits or session denylist that share the same Redis.
 */
export const CACHE_PRESETS: Record<string, { pattern: string; label: string; warning?: string }> = {
  analytics: { pattern: 'analytics:*', label: 'Analytics charts' },
  dashboard: { pattern: 'admin:dashboard:*', label: 'Admin dashboard numbers' },
  'product-categories': { pattern: 'products:categories:*', label: 'Store categories' },
  'product-search': {
    pattern: 'products:search:*',
    label: 'Product search results',
    warning:
      'Every search after this goes to the store again until the cache refills — on SerpApi each one uses a paid search.',
  },
};

export interface QueueSummary {
  name: string;
  paused: boolean;
  counts: Record<string, number>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The operations desk: the background queues and their stuck jobs, whether
 * the database, Redis and the queues answer, how product search is spending
 * its vendor quota, the caches that can be cleared, which migrations ran,
 * and the settings the server is running with.
 */
@Injectable()
export class AdminOpsService {
  private readonly logger = new Logger(AdminOpsService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @InjectConnection() private readonly conn: Connection,
    private readonly cache: CacheService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly guard: ProviderGuard,
    private readonly products: ProductsService,
    private readonly budget: VendorBudgetService,
    private readonly audit: AuditService,
  ) {}

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  // ── Queues ─────────────────────────────────────────────────────────────────

  private queue(name: string): Queue {
    if (!(Object.values(QUEUE) as string[]).includes(name)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such queue', 404);
    }
    return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
  }

  async queues(): Promise<QueueSummary[]> {
    return Promise.all(
      (Object.values(QUEUE) as string[]).map(async (name) => {
        const q = this.queue(name);
        const [counts, paused] = await Promise.all([
          q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused'),
          q.isPaused(),
        ]);
        return { name, paused, counts };
      }),
    );
  }

  /** One queue: its jobs in [state], newest first, and its repeating schedules. */
  async queueDetail(name: string, state: JobState, page: number, limit = 25) {
    const q = this.queue(name);
    const start = (Math.max(1, page) - 1) * limit;
    const [jobs, total, repeatable, paused] = await Promise.all([
      q.getJobs([state as JobType], start, start + limit - 1, false),
      q.getJobCountByTypes(state as JobType),
      q.getRepeatableJobs(),
      q.isPaused(),
    ]);
    return {
      name,
      paused,
      state,
      page: Math.max(1, page),
      limit,
      total,
      jobs: jobs.filter(Boolean).map((j) => AdminOpsService.jobView(j)),
      repeatable: repeatable.map((r) => ({
        key: r.key,
        name: r.name,
        pattern: r.pattern ?? null,
        every: r.every ?? null,
        next: r.next ? new Date(r.next) : null,
      })),
    };
  }

  private static jobView(j: Job) {
    return {
      id: j.id ?? '',
      name: j.name,
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason ?? null,
      // The first lines say where; the rest is noise on a phone screen.
      stack: (j.stacktrace ?? []).slice(-1)[0]?.split('\n').slice(0, 12).join('\n') ?? null,
      data: j.data as unknown,
      createdAt: j.timestamp ? new Date(j.timestamp) : null,
      processedAt: j.processedOn ? new Date(j.processedOn) : null,
      finishedAt: j.finishedOn ? new Date(j.finishedOn) : null,
      delayUntil: j.delay ? new Date(j.timestamp + j.delay) : null,
    };
  }

  async retryJob(name: string, jobId: string, actor: AuthenticatedAdmin, ip: string | null) {
    const job = await this.job(name, jobId);
    if (!(await job.isFailed())) {
      throw new AppException(
        ErrorCode.CONTENT_ACTION_INVALID,
        'Only a failed job can be retried',
        409,
      );
    }
    await job.retry('failed');
    await this.record(actor, ip, 'ops.retry_job', 'job', `${name}:${jobId}`, { name: job.name });
    return { ok: true as const };
  }

  async retryAllFailed(name: string, actor: AuthenticatedAdmin, ip: string | null) {
    const q = this.queue(name);
    const failed = await q.getJobCountByTypes('failed');
    await q.retryJobs({ state: 'failed', count: 500 });
    await this.record(actor, ip, 'ops.retry_failed', 'queue', name, { jobs: failed });
    return { retried: failed };
  }

  async removeJob(name: string, jobId: string, actor: AuthenticatedAdmin, ip: string | null) {
    const job = await this.job(name, jobId);
    if (await job.isActive()) {
      throw new AppException(
        ErrorCode.CONTENT_ACTION_INVALID,
        'A running job cannot be removed',
        409,
      );
    }
    const jobName = job.name;
    await job.remove();
    await this.record(actor, ip, 'ops.remove_job', 'job', `${name}:${jobId}`, { name: jobName });
    return { ok: true as const };
  }

  /**
   * Stops a queue taking new jobs (running ones finish), or starts it again.
   * Across every instance: the pause lives in Redis, not in this process.
   */
  async setPaused(
    name: string,
    paused: boolean,
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ) {
    const q = this.queue(name);
    if (paused) await q.pause();
    else await q.resume();
    await this.record(actor, ip, paused ? 'ops.pause_queue' : 'ops.resume_queue', 'queue', name, {
      reason,
    });
    return { paused };
  }

  private async job(name: string, jobId: string): Promise<Job> {
    const job = await this.queue(name).getJob(jobId);
    if (!job) throw new AppException(ErrorCode.NOT_FOUND, 'No such job', 404);
    return job;
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  /** The same checks as `/ready`, with how long each took. */
  async health() {
    const timed = async (name: string, check: () => Promise<unknown>) => {
      const started = Date.now();
      try {
        await check();
        return { name, ok: true, ms: Date.now() - started, error: null as string | null };
      } catch (e) {
        return { name, ok: false, ms: Date.now() - started, error: errText(e) };
      }
    };
    const checks = await Promise.all([
      timed('Database', () => this.db.admin().ping()),
      timed('Redis', async () => {
        if (!(await this.cache.ping())) throw new Error('No answer');
      }),
      // The same probe as /ready: a queue that can count its jobs is reachable.
      timed('Queues', () => this.queue(QUEUE.HEALTH).getJobCounts('waiting', 'failed')),
    ]);
    const sentryDsn = this.config.get('observability', { infer: true }).sentryDsn;
    return {
      checks,
      sentry: { configured: Boolean(sentryDsn) },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
      },
    };
  }

  // ── Product search ─────────────────────────────────────────────────────────

  /**
   * How product search is spending: requests sent this month and last, what
   * SerpApi says is left on the plan, the breaker, and how often the cache
   * answers instead of the vendor.
   */
  async productSearch() {
    const cfg = this.config.get('products', { infer: true });
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);
    const [thisMonth, lastMonth, lookups, account] = await Promise.all([
      this.guard.requestsIn(cfg.provider, month),
      this.guard.requestsIn(cfg.provider, last),
      this.products.lookupStats(14),
      this.serpApiAccount(),
    ]);
    const hits = lookups.reduce((s, d) => s + d.hits, 0);
    const misses = lookups.reduce((s, d) => s + d.misses, 0);
    return {
      provider: cfg.provider,
      breaker: this.guard.stateOf(cfg.provider),
      requests: { thisMonth, lastMonth, month },
      account,
      cache: {
        days: lookups,
        hitRate: hits + misses ? Math.round((hits / (hits + misses)) * 10_000) / 100 : null,
      },
      limits: {
        rateLimitPerMinute: cfg.rateLimitPerMinute,
        dailyBudgetPerPerson: DAILY_SEARCH_BUDGET,
        dailyHardCapPerPerson: DAILY_SEARCH_HARD_CAP,
        cacheTtlSeconds: cfg.cacheTtlSeconds,
      },
      prewarm: { enabled: cfg.prewarmEnabled, cron: cfg.prewarmCron },
    };
  }

  /** SerpApi's own account numbers; null when not on SerpApi or it cannot be reached. */
  private async serpApiAccount(): Promise<{
    planSearchesLeft: number | null;
    searchesPerMonth: number | null;
    thisMonthUsage: number | null;
    plan: string | null;
  } | null> {
    const cfg = this.config.get('products', { infer: true });
    if (cfg.provider !== 'serpapi' || !cfg.serpApiKey) return null;
    return this.cache.wrap('admin:ops:serpapi-account:v1', 300, async () => {
      try {
        const res = await fetch(
          `https://serpapi.com/account.json?api_key=${encodeURIComponent(cfg.serpApiKey)}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!res.ok) return null;
        const a = (await res.json()) as Record<string, unknown>;
        const n = (v: unknown) => (typeof v === 'number' ? v : null);
        return {
          planSearchesLeft: n(a.plan_searches_left) ?? n(a.total_searches_left),
          searchesPerMonth: n(a.searches_per_month),
          thisMonthUsage: n(a.this_month_usage),
          plan: typeof a.plan_name === 'string' ? a.plan_name : null,
        };
      } catch (e) {
        this.logger.warn(`SerpApi account lookup failed: ${errText(e)}`);
        return null;
      }
    });
  }

  async resetBreaker(actor: AuthenticatedAdmin, ip: string | null, reason: string) {
    const provider = this.config.get('products', { infer: true }).provider;
    const before = this.guard.stateOf(provider);
    this.guard.resetBreaker(provider);
    await this.record(actor, ip, 'ops.reset_breaker', 'provider', provider, { reason, before });
    return { state: this.guard.stateOf(provider) };
  }

  /** One person's product searches today against their daily budget. */
  async budgetOf(userId: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such person', 404);
    }
    const spent = await this.budget.spentToday(userId);
    return {
      userId,
      spent,
      budget: DAILY_SEARCH_BUDGET,
      hardCap: DAILY_SEARCH_HARD_CAP,
      allowance: await this.budget.allowanceFor(userId),
    };
  }

  // ── Caches ─────────────────────────────────────────────────────────────────

  caches() {
    return Object.entries(CACHE_PRESETS).map(([key, p]) => ({
      key,
      label: p.label,
      warning: p.warning ?? null,
    }));
  }

  async clearCache(key: string, reason: string, actor: AuthenticatedAdmin, ip: string | null) {
    const preset = CACHE_PRESETS[key];
    if (!preset) throw new AppException(ErrorCode.NOT_FOUND, 'No such cache', 404);
    const removed = await this.cache.delByPattern(preset.pattern);
    await this.record(actor, ip, 'ops.clear_cache', 'cache', key, { reason, removed });
    return { removed };
  }

  // ── Migrations and settings ────────────────────────────────────────────────

  migrations() {
    return new MigrationRunner(this.db, MIGRATIONS).status();
  }

  /**
   * What the server runs with — by an allow-list, so a setting added later is
   * hidden until someone decides it is safe to show. No secret is in here.
   */
  settings() {
    const c = <K extends keyof AppConfig>(k: K) => this.config.get(k, { infer: true });
    const app = c('app');
    const products = c('products');
    const notifications = c('notifications');
    const gifting = c('gifting');
    return {
      App: {
        Environment: app.env,
        'App link': app.appUrl,
        'Web link': app.webAppUrl,
        'Log level': app.logLevel,
        'API docs on': app.swaggerEnabled,
      },
      Delivery: {
        Email: c('delivery').mailerDriver,
        SMS: c('delivery').smsDriver,
        Push: c('delivery').pushDriver,
        'Sends email as': c('delivery').mailFrom,
      },
      Notifications: {
        'Quiet hours start': notifications.quietHoursStart,
        'Quiet hours end': notifications.quietHoursEnd,
        'Digest hour': notifications.digestHour,
        'Thank-you delay (hours)': notifications.thankYouDelayHours,
      },
      'Product search': {
        Provider: products.provider,
        Country: products.serpApiCountry,
        'Requests per minute': products.rateLimitPerMinute,
        Retries: products.maxRetries,
        'Timeout (ms)': products.timeoutMs,
        'Fresh for (s)': products.cacheTtlSeconds,
        'Kept for outages (s)': products.staleTtlSeconds,
        'Breaker trips after': products.breakerFailureThreshold,
        'Breaker resets after (ms)': products.breakerResetMs,
        Prewarm: products.prewarmEnabled ? products.prewarmCron : 'off',
      },
      Gifting: {
        'Reservation hold (hours)': gifting.reservationTtlHours,
        'Hold ends before event (hours)': gifting.reservationEventCutoffHours,
        'Warn before hold ends (hours)': gifting.reservationWarnHours,
      },
      'Group gifts': {
        'Smallest contribution (paise)': c('groupGifting').minContributionMinor,
        'Largest target (paise)': c('groupGifting').maxTargetMinor,
      },
      Storage: {
        Files: c('storage').driver,
        Video: c('video').driver,
        'Largest upload (bytes)': c('storage').maxBytes,
        'Memory allowance (bytes)': c('storage').memoryQuotaBytes,
      },
      Accounts: {
        'Deletion grace (days)': c('account').deletionGraceDays,
        'Admin session (hours)': c('admin').accessTtlHours,
      },
      Affiliate: { Network: c('affiliate').network },
      Monitoring: { 'Sentry on': Boolean(c('observability').sentryDsn) },
    };
  }

  private record(
    actor: AuthenticatedAdmin,
    ip: string | null,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({ actor, action, targetType, targetId, meta, ip });
  }
}
