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
import { AdminUser360Service } from './admin-user360.service';
import type { AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

/** The job states an admin can list. */
export const JOB_STATES = ['failed', 'waiting', 'active', 'delayed', 'completed'] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * Caches an admin may clear, by name. Only caches: never the counters,
 * budgets, rate limits or session denylist that share the same Redis.
 */
/** Where SerpApi's account numbers are kept between looks (five minutes). */
const SERPAPI_ACCOUNT_KEY = 'admin:ops:serpapi-account:v2';

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
    private readonly user360: AdminUser360Service,
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

  /**
   * Drops every failed job in a queue without running it — for failures that
   * are stale, such as runs of a repeating job the next run has already done.
   */
  async clearFailed(name: string, actor: AuthenticatedAdmin, ip: string | null) {
    const q = this.queue(name);
    const removed = (await q.clean(0, 10_000, 'failed')).length;
    await this.record(actor, ip, 'ops.clear_failed', 'queue', name, { jobs: removed });
    return { removed };
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
   *
   * SerpApi's numbers are kept for five minutes; [fresh] asks it again now
   * (its account lookup is free — it uses none of the plan's searches).
   */
  async productSearch(fresh = false) {
    const cfg = this.config.get('products', { infer: true });
    if (fresh) await this.cache.del(SERPAPI_ACCOUNT_KEY);
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
    /** When SerpApi was asked — the panel says how old the numbers are. */
    checkedAt: string;
  } | null> {
    const cfg = this.config.get('products', { infer: true });
    if (cfg.provider !== 'serpapi' || !cfg.serpApiKey) return null;
    return this.cache.wrap(SERPAPI_ACCOUNT_KEY, 300, async () => {
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
          checkedAt: new Date().toISOString(),
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

  // ── One day of product search ──────────────────────────────────────────────
  //
  // The chart's days are UTC, because its counters are; these read the same
  // days so a bar and its breakdown always agree.

  private dayBounds(day: string): { start: Date; end: Date } {
    const start = new Date(`${day}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(start.getTime())) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'A day is YYYY-MM-DD', 400);
    }
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }

  /** When lookups were first recorded with names on them — null if never. */
  private async lookupsSince(): Promise<Date | null> {
    const first = await this.db
      .collection('search_lookups')
      .find()
      .sort({ createdAt: 1 })
      .limit(1)
      .project({ createdAt: 1 })
      .next();
    return first?.createdAt instanceof Date ? first.createdAt : null;
  }

  /**
   * One day of product search: the chart's numbers for it, what the store
   * was paid for, why the lookups happened, who they were for and what was
   * typed. Lookups carry names from the day they were first recorded; before
   * that only typed searches are known by person.
   */
  async searchDay(day: string) {
    const { start, end } = this.dayBounds(day);
    const range = { createdAt: { $gte: start, $lt: end } };
    const provider = this.config.get('products', { infer: true }).provider;
    const lookups = this.db.collection('search_lookups');
    const logs = this.db.collection('search_logs');
    const empty = { $sum: { $cond: [{ $eq: ['$results', 0] }, 1, 0] } };

    const [stats, requests, lookupRows, typedRows, topRows, nothingRows, since] = await Promise.all(
      [
        this.products.searchStatsOn([day]),
        this.guard.requestsOnDays(provider, [day]),
        lookups
          .aggregate<{
            _id: { userId: Types.ObjectId | null; origin: string; answer: string };
            n: number;
            lastAt: Date;
          }>([
            { $match: range },
            {
              $group: {
                _id: { userId: '$userId', origin: '$origin', answer: '$answer' },
                n: { $sum: 1 },
                lastAt: { $max: '$createdAt' },
              },
            },
          ])
          .toArray(),
        logs
          .aggregate<{
            _id: { userId: Types.ObjectId; freshness: string };
            n: number;
            empty: number;
            lastAt: Date;
          }>([
            { $match: range },
            {
              $group: {
                _id: { userId: '$userId', freshness: '$freshness' },
                n: { $sum: 1 },
                empty,
                lastAt: { $max: '$createdAt' },
              },
            },
          ])
          .toArray(),
        logs
          .aggregate<{ _id: string; query: string; n: number; people: unknown[]; empty: number }>([
            { $match: { ...range, normalized: { $ne: '' } } },
            {
              $group: {
                _id: '$normalized',
                query: { $last: '$query' },
                n: { $sum: 1 },
                people: { $addToSet: '$userId' },
                empty,
              },
            },
            { $sort: { n: -1, _id: 1 } },
            { $limit: 10 },
          ])
          .toArray(),
        logs
          .aggregate<{ _id: string; query: string; n: number }>([
            { $match: { ...range, normalized: { $ne: '' }, results: 0 } },
            { $group: { _id: '$normalized', query: { $last: '$query' }, n: { $sum: 1 } } },
            { $sort: { n: -1, _id: 1 } },
            { $limit: 10 },
          ])
          .toArray(),
        this.lookupsSince(),
      ],
    );

    type Answers = Record<'cache' | 'store' | 'shared' | 'unavailable' | 'failed', number>;
    const none = (): Answers => ({ cache: 0, store: 0, shared: 0, unavailable: 0, failed: 0 });
    const add = (a: Answers, answer: string, n: number) => {
      if (answer in a) a[answer as keyof Answers] += n;
    };
    const total = (a: Answers) => Object.values(a).reduce((s, n) => s + n, 0);

    const answers = none();
    const origins = new Map<string, Answers>();
    const guests = none();
    type Person = {
      typed: number;
      typedAnswers: Answers;
      foundNothing: number;
      lookups: Answers;
      why: Record<string, number>;
      lastAt: Date | null;
    };
    const people = new Map<string, Person>();
    const personOf = (uid: string): Person => {
      let p = people.get(uid);
      if (!p) {
        p = {
          typed: 0,
          typedAnswers: none(),
          foundNothing: 0,
          lookups: none(),
          why: {},
          lastAt: null,
        };
        people.set(uid, p);
      }
      return p;
    };
    const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

    for (const r of lookupRows) {
      add(answers, r._id.answer, r.n);
      const o = origins.get(r._id.origin) ?? none();
      add(o, r._id.answer, r.n);
      origins.set(r._id.origin, o);
      if (!r._id.userId) {
        add(guests, r._id.answer, r.n);
        continue;
      }
      const p = personOf(String(r._id.userId));
      add(p.lookups, r._id.answer, r.n);
      p.why[r._id.origin] = (p.why[r._id.origin] ?? 0) + r.n;
      p.lastAt = later(p.lastAt, r.lastAt);
    }
    // The search log's own words for how a typed search was answered.
    const FROM_FRESHNESS: Record<string, keyof Answers> = {
      cached: 'cache',
      live: 'store',
      stale: 'unavailable',
    };
    for (const r of typedRows) {
      const p = personOf(String(r._id.userId));
      p.typed += r.n;
      p.foundNothing += r.empty;
      add(p.typedAnswers, FROM_FRESHNESS[r._id.freshness] ?? 'store', r.n);
      p.lastAt = later(p.lastAt, r.lastAt);
    }

    const names = await this.user360.namesFor([...people.keys()]);
    const counters = stats[0];
    return {
      day,
      counters: {
        fromCache: counters.hits,
        sentToStore: counters.misses,
        foundNothing: counters.empty,
        platforms: counters.platforms,
      },
      /** Requests SerpApi was sent that day — retries, details and links included. */
      storeRequests: requests[0] ?? 0,
      /** Null: no lookup that day was recorded with a name. */
      recordedSince: since && since < end ? since : null,
      lookups: { total: total(answers), ...answers },
      byReason: [...origins]
        .map(([origin, a]) => ({ origin, total: total(a), ...a }))
        .sort((x, y) => y.total - x.total),
      guests: { total: total(guests), ...guests },
      people: [...people]
        .map(([userId, p]) => ({
          userId,
          name: names[userId] ?? null,
          typed: p.typed,
          typedAnswers: p.typedAnswers,
          foundNothing: p.foundNothing,
          lookups: { total: total(p.lookups), ...p.lookups },
          why: p.why,
          lastAt: p.lastAt,
        }))
        .sort(
          (a, b) =>
            b.lookups.store - a.lookups.store ||
            b.lookups.total - a.lookups.total ||
            b.typed - a.typed,
        ),
      topSearches: topRows.map((t) => ({
        query: t.query || t._id,
        searches: t.n,
        people: t.people.length,
        foundNothing: t.empty,
      })),
      foundNothing: nothingRows.map((t) => ({ query: t.query || t._id, searches: t.n })),
    };
  }

  /**
   * One person's product search on one day: every lookup made for them, in
   * order, with how it was answered; what they typed; and what they then
   * saved from search to their wishlists.
   */
  async searchPersonDay(day: string, userId: string) {
    const { start, end } = this.dayBounds(day);
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such person', 404);
    }
    const uid = new Types.ObjectId(userId);
    const range = { createdAt: { $gte: start, $lt: end } };
    const today = new Date().toISOString().slice(0, 10) === day;
    const [lookupDocs, typedDocs, addedDocs, since, spent, allowance] = await Promise.all([
      this.db
        .collection('search_lookups')
        .find({ userId: uid, ...range })
        .sort({ createdAt: 1 })
        .limit(1000)
        .toArray(),
      this.db
        .collection('search_logs')
        .find({ userId: uid, ...range })
        .sort({ createdAt: 1 })
        .limit(500)
        .toArray(),
      this.db
        .collection('wishlist_items')
        .find({ ownerId: uid, sourceProductId: { $ne: null }, ...range })
        .sort({ createdAt: 1 })
        .limit(100)
        .project({ title: 1, wishlistId: 1, createdAt: 1 })
        .toArray(),
      this.lookupsSince(),
      today ? this.budget.spentToday(userId) : Promise.resolve(null),
      today ? this.budget.allowanceFor(userId) : Promise.resolve(null),
    ]);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    const idOf = (v: unknown) => (v instanceof Types.ObjectId ? String(v) : null);
    const forIds = lookupDocs.map((d) => idOf(d.forUserId)).filter((x): x is string => !!x);
    const names = await this.user360.namesFor([userId, ...new Set(forIds)]);
    return {
      day,
      userId,
      name: names[userId] ?? null,
      recordedSince: since && since < end ? since : null,
      lookups: lookupDocs.map((d) => ({
        id: String(d._id),
        at: d.createdAt instanceof Date ? d.createdAt : null,
        origin: str(d.origin) ?? 'other',
        forUserId: idOf(d.forUserId),
        query: str(d.query) ?? '',
        category: str(d.category),
        minPriceMinor: num(d.minPriceMinor),
        maxPriceMinor: num(d.maxPriceMinor),
        platform: str(d.platform),
        answer: str(d.answer) ?? 'failed',
        reason: str(d.reason),
        fallback: str(d.fallback),
        results: num(d.results) ?? 0,
      })),
      typed: typedDocs.map((d) => ({
        id: String(d._id),
        at: d.createdAt instanceof Date ? d.createdAt : null,
        query: str(d.query) ?? '',
        category: str(d.category),
        platform: str(d.platform),
        freshness: str(d.freshness) ?? 'live',
        results: num(d.results) ?? 0,
      })),
      added: addedDocs.map((d) => ({
        id: String(d._id),
        title: str(d.title),
        wishlistId: idOf(d.wishlistId),
        at: d.createdAt instanceof Date ? d.createdAt : null,
      })),
      /** Only today's is known: the allowance resets each UTC day. */
      allowance:
        spent === null
          ? null
          : {
              spent,
              budget: DAILY_SEARCH_BUDGET,
              hardCap: DAILY_SEARCH_HARD_CAP,
              level: allowance,
            },
      names,
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
