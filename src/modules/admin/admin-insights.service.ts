import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types, type mongo } from 'mongoose';
import type { AppConfig } from 'src/config/configuration';
import { CacheService } from 'src/infra/redis/cache.service';
import { GiftStatus, GiftType } from 'src/modules/gifting/gift.types';
import { GroupGiftStatus } from 'src/modules/group-gifts/group-gift.types';
import { ProductsService } from 'src/modules/products/products.service';
import { ProviderGuard } from 'src/modules/products/providers/provider-guard.service';
import { at, id, oid, str, type Doc } from './admin-explorer.util';
import { dayRange, escapeRegex, pageOf, type AdminPage } from './admin-query.util';
import { AdminUser360Service } from './admin-user360.service';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** a / b as a percentage with one decimal, or null when there is nothing to divide by. */
const pct = (a: number, b: number): number | null =>
  b > 0 ? Math.round((a / b) * 1000) / 10 : null;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const hours = (ms: number): number => Math.round((ms / HOUR_MS) * 10) / 10;
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const startOfDay = (d: Date): number => Date.parse(`${dayOf(d)}T00:00:00.000Z`);

/** Every day from [from] to [to] inclusive, at most [cap] of the latest. */
function daysBetween(from: string, to: string, cap = 92): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out.slice(-cap);
}

/** Monday 00:00 UTC of the week [d] falls in. */
function weekStart(d: Date): number {
  const day = startOfDay(d);
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - dow * DAY_MS;
}

export interface FunnelStep {
  key: string;
  label: string;
  users: number;
  /** Of everyone who signed up in the range. */
  ofStart: number | null;
  /** Of the step before. */
  ofPrevious: number | null;
  /** Median hours from signing up to reaching this step. */
  medianHours: number | null;
}

export interface RetentionCohort {
  week: string;
  size: number;
  /** Percent active in week 1, 2, … after signing up; null for weeks not over yet. */
  weeks: (number | null)[];
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

export interface RawEventQuery {
  name?: string;
  user?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

/**
 * The analytics desk's deeper reads: the signup funnel, retention by weekly
 * cohort, and how gifting, group gifts, events, notifications and product
 * search are doing over a range — plus the raw event stream for debugging.
 *
 * Everything but the raw stream is computed from the records themselves
 * (users, gifts, invites…) rather than from client events, so it is right for
 * the past too. Retention and the "shared" step are the exceptions: they need
 * the server's own `active` and `wishlist_link_opened` events, which start on
 * the day this shipped — each answer says from when it can count.
 *
 * Cached under `analytics:`, so the operations desk's "Analytics" cache clears
 * them with the rest.
 */
@Injectable()
export class AdminInsightsService {
  private readonly ttl: number;

  constructor(
    @InjectConnection() private readonly conn: Connection,
    private readonly cache: CacheService,
    private readonly products: ProductsService,
    private readonly guard: ProviderGuard,
    private readonly user360: AdminUser360Service,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.ttl = config.get('analytics.cacheTtlSeconds', { infer: true });
  }

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.cache.wrap(`analytics:insights:${key}`, this.ttl, fn);
  }

  /** When the server's own `name` events start — what an answer can count from. */
  private async firstEvent(name: string): Promise<Date | null> {
    const first = await this.db
      .collection('analytics_events')
      .find({ name })
      .sort({ ts: 1 })
      .limit(1)
      .project({ ts: 1 })
      .next();
    return at(first?.ts);
  }

  // ── Funnel ──────────────────────────────────────────────────────────────────

  /**
   * Of the people who signed up in the range, how many went on to finish
   * onboarding, make a wishlist, add an item, and have a shared list opened by
   * someone else. Each step counts everyone who reached it, in any order.
   */
  funnel(from: string, to: string): Promise<{ steps: FunnelStep[]; sharedSince: Date | null }> {
    return this.cached(`funnel:${from}:${to}`, async () => {
      const users = await this.db
        .collection('users')
        .find({ createdAt: dayRange(from, to), deletedAt: null })
        .project({ createdAt: 1 })
        .toArray();
      const joined = new Map(users.map((u) => [String(u._id), (u.createdAt as Date).getTime()]));
      const ids = users.map((u) => u._id as Types.ObjectId);

      const firstBy = async (collection: string, owner: string, field: string, match: Doc = {}) =>
        new Map(
          (
            await this.db
              .collection(collection)
              .aggregate<{ _id: unknown; first: Date }>([
                {
                  $match: {
                    [owner]: { $in: owner.startsWith('props.') ? [...joined.keys()] : ids },
                    ...match,
                  },
                },
                { $group: { _id: `$${owner}`, first: { $min: `$${field}` } } },
              ])
              .toArray()
          ).map((r) => [String(r._id), r.first.getTime()]),
        );

      const [onboarded, wishlist, item, shared, sharedSince] = await Promise.all([
        firstBy('user_profiles', 'userId', 'onboardingCompletedAt', {
          onboardingCompletedAt: { $ne: null },
        }),
        firstBy('wishlists', 'ownerId', 'createdAt'),
        firstBy('wishlist_items', 'ownerId', 'createdAt'),
        firstBy('analytics_events', 'props.ownerId', 'ts', { name: 'wishlist_link_opened' }),
        this.firstEvent('wishlist_link_opened'),
      ]);

      const step = (key: string, label: string, reached: Map<string, number> | null) => {
        if (!reached) return { key, label, users: users.length, medianHours: null };
        const delays = [...reached].map(([u, t]) => t - (joined.get(u) ?? t)).filter((d) => d >= 0);
        return { key, label, users: reached.size, medianHours: median(delays.map(hours)) };
      };
      const raw = [
        step('signed_up', 'Signed up', null),
        step('onboarded', 'Finished onboarding', onboarded),
        step('wishlist', 'Made a wishlist', wishlist),
        step('item', 'Added an item', item),
        step('shared', 'Shared a list someone opened', shared),
      ];
      const steps = raw.map((s, i) => ({
        ...s,
        ofStart: pct(s.users, users.length),
        ofPrevious: i === 0 ? null : pct(s.users, raw[i - 1].users),
      }));
      return { steps, sharedSince };
    });
  }

  // ── Retention ───────────────────────────────────────────────────────────────

  /**
   * Weekly signup cohorts for the last [weeks] weeks, and the share of each
   * that came back: in each week after joining, and on day 1, 7 and 30.
   * "Came back" is any analytics event from them — chiefly the server's daily
   * `active`, recorded on sign-in and while the app is open.
   */
  retention(weeks: number): Promise<{
    cohorts: RetentionCohort[];
    overall: { d1: number | null; d7: number | null; d30: number | null };
    activeSince: Date | null;
  }> {
    return this.cached(`retention:${weeks}:${dayOf(new Date())}`, async () => {
      const now = Date.now();
      const thisWeek = weekStart(new Date());
      const start = thisWeek - (weeks - 1) * 7 * DAY_MS;
      const users = await this.db
        .collection('users')
        .find({ createdAt: { $gte: new Date(start) }, deletedAt: null })
        .project({ createdAt: 1 })
        .toArray();
      const ids = users.map((u) => u._id as Types.ObjectId);

      const activeDays = new Map<string, Set<string>>();
      const rows = await this.db
        .collection('analytics_events')
        .aggregate<{ _id: { u: Types.ObjectId; d: string } }>([
          { $match: { userId: { $in: ids }, ts: { $gte: new Date(start) } } },
          {
            $group: {
              _id: { u: '$userId', d: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } } },
            },
          },
        ])
        .toArray();
      for (const r of rows) {
        const key = String(r._id.u);
        if (!activeDays.has(key)) activeDays.set(key, new Set());
        activeDays.get(key)!.add(r._id.d);
      }

      // Days after signing up on which each person was active.
      const offsets = (u: Doc): number[] => {
        const joinedDay = startOfDay(u.createdAt as Date);
        return [...(activeDays.get(String(u._id)) ?? [])].map((d) =>
          Math.round((Date.parse(`${d}T00:00:00Z`) - joinedDay) / DAY_MS),
        );
      };
      const today = startOfDay(new Date());
      const rate = (members: Doc[], day: number) => {
        // Only people for whom that day has already been and gone.
        const eligible = members.filter(
          (u) => startOfDay(u.createdAt as Date) + day * DAY_MS < today,
        );
        const back = eligible.filter((u) => offsets(u).includes(day)).length;
        return { back, eligible: eligible.length };
      };

      const cohorts: RetentionCohort[] = [];
      for (let w = 0; w < weeks; w++) {
        const ws = start + w * 7 * DAY_MS;
        const members = users.filter((u) => weekStart(u.createdAt as Date) === ws);
        const weekRates: (number | null)[] = [];
        for (let k = 1; k < weeks - w; k++) {
          // Week k after joining is over for the whole cohort only once the
          // cohort's last day plus k weeks has passed.
          if (ws + (k + 1) * 7 * DAY_MS > now) {
            weekRates.push(null);
            continue;
          }
          const back = members.filter((u) => offsets(u).some((o) => o >= 7 * k && o < 7 * (k + 1)));
          weekRates.push(pct(back.length, members.length));
        }
        const [d1, d7, d30] = [1, 7, 30].map((d) => {
          const r = rate(members, d);
          return pct(r.back, r.eligible);
        });
        cohorts.push({
          week: dayOf(new Date(ws)),
          size: members.length,
          weeks: weekRates,
          d1,
          d7,
          d30,
        });
      }

      const overall = Object.fromEntries(
        ([1, 7, 30] as const).map((d) => {
          const r = rate(users, d);
          return [`d${d}`, pct(r.back, r.eligible)];
        }),
      ) as { d1: number | null; d7: number | null; d30: number | null };
      return { cohorts, overall, activeSince: await this.firstEvent('active') };
    });
  }

  // ── Gifting ─────────────────────────────────────────────────────────────────

  /** Reservations made in the range, and what became of them. */
  gifting(
    from: string,
    to: string,
  ): Promise<{
    reserved: number;
    purchased: number;
    purchaseRate: number | null;
    medianHoursToPurchase: number | null;
    expired: number;
    expiryRate: number | null;
    cancelled: number;
    stillHeld: number;
    boughtForThemselves: number;
    days: { day: string; reserved: number; purchased: number }[];
  }> {
    return this.cached(`gifting:${from}:${to}`, async () => {
      const range = dayRange(from, to);
      const gifts = await this.db
        .collection('gifts')
        .find({ createdAt: range, type: GiftType.SINGLE })
        .project({ status: 1, createdAt: 1, reservedAt: 1, purchasedAt: 1, 'history.by': 1 })
        .toArray();
      const self = await this.db
        .collection('gifts')
        .countDocuments({ createdAt: range, type: GiftType.SELF });
      const expired = gifts.filter(
        (g) =>
          Array.isArray(g.history) && (g.history as Doc[]).some((h) => h.by === 'system:expiry'),
      );
      const purchased = gifts.filter((g) => g.purchasedAt instanceof Date);
      const toPurchase = purchased.map((g) =>
        hours(
          (g.purchasedAt as Date).getTime() - ((g.reservedAt ?? g.createdAt) as Date).getTime(),
        ),
      );
      const days = daysBetween(from, to).map((day) => ({
        day,
        reserved: gifts.filter((g) => dayOf(g.createdAt as Date) === day).length,
        purchased: purchased.filter((g) => dayOf(g.purchasedAt as Date) === day).length,
      }));
      return {
        reserved: gifts.length,
        purchased: purchased.length,
        purchaseRate: pct(purchased.length, gifts.length),
        medianHoursToPurchase: median(toPurchase),
        expired: expired.length,
        expiryRate: pct(expired.length, gifts.length),
        cancelled: gifts.filter((g) => g.status === GiftStatus.CANCELLED).length - expired.length,
        stillHeld: gifts.filter((g) => g.status === GiftStatus.RESERVED).length,
        boughtForThemselves: self,
        days,
      };
    });
  }

  // ── Group gifts ─────────────────────────────────────────────────────────────

  /** Group gifts started in the range: how many got funded, by how many people. */
  groupGifts(
    from: string,
    to: string,
  ): Promise<{
    started: number;
    funded: number;
    fundedRate: number | null;
    stillOpen: number;
    cancelled: number;
    avgContributors: number | null;
    avgPercentOfTarget: number | null;
    collectedMinor: number;
    targetMinor: number;
  }> {
    return this.cached(`group-gifts:${from}:${to}`, async () => {
      const rows = await this.db
        .collection('group_gifts')
        .find({ createdAt: dayRange(from, to) })
        .project({ status: 1, contributorCount: 1, collectedAmountMinor: 1, targetAmountMinor: 1 })
        .toArray();
      const fundedStatuses: string[] = [
        GroupGiftStatus.FUNDED,
        GroupGiftStatus.PURCHASING,
        GroupGiftStatus.PURCHASED,
        GroupGiftStatus.FULFILLED,
      ];
      const funded = rows.filter((r) => fundedStatuses.includes(String(r.status))).length;
      const open = rows.filter((r) => r.status === GroupGiftStatus.OPEN).length;
      const sum = (f: string) => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
      const ofTarget = rows
        .filter((r) => Number(r.targetAmountMinor) > 0)
        .map((r) => (Number(r.collectedAmountMinor) || 0) / Number(r.targetAmountMinor));
      return {
        started: rows.length,
        funded,
        // Of the ones that have finished collecting either way.
        fundedRate: pct(funded, rows.length - open),
        stillOpen: open,
        cancelled: rows.filter(
          (r) => r.status === GroupGiftStatus.CANCELLED || r.status === GroupGiftStatus.REFUNDING,
        ).length,
        avgContributors: rows.length
          ? Math.round((sum('contributorCount') / rows.length) * 10) / 10
          : null,
        avgPercentOfTarget: ofTarget.length
          ? Math.round((ofTarget.reduce((a, b) => a + b, 0) / ofTarget.length) * 1000) / 10
          : null,
        collectedMinor: sum('collectedAmountMinor'),
        targetMinor: sum('targetAmountMinor'),
      };
    });
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  /** Events created in the range: their kinds, their invites and the replies. */
  events(
    from: string,
    to: string,
  ): Promise<{
    created: number;
    byType: Record<string, number>;
    invites: number;
    invitesPerEvent: number | null;
    replies: Record<string, number>;
    replyRate: number | null;
    yesRate: number | null;
  }> {
    return this.cached(`events:${from}:${to}`, async () => {
      const events = await this.db
        .collection('events')
        .find({ createdAt: dayRange(from, to) })
        .project({ type: 1 })
        .toArray();
      const byType: Record<string, number> = {};
      for (const e of events) byType[String(e.type)] = (byType[String(e.type)] ?? 0) + 1;
      const rsvp = await this.db
        .collection('event_invites')
        .aggregate<{ _id: string; n: number }>([
          { $match: { eventId: { $in: events.map((e) => e._id as Types.ObjectId) } } },
          { $group: { _id: '$rsvp', n: { $sum: 1 } } },
        ])
        .toArray();
      const replies: Record<string, number> = { yes: 0, no: 0, maybe: 0, pending: 0 };
      for (const r of rsvp) replies[String(r._id ?? 'pending')] = r.n;
      const invites = Object.values(replies).reduce((a, b) => a + b, 0);
      const answered = replies.yes + replies.no + replies.maybe;
      return {
        created: events.length,
        byType,
        invites,
        invitesPerEvent: events.length ? Math.round((invites / events.length) * 10) / 10 : null,
        replies,
        replyRate: pct(answered, invites),
        yesRate: pct(replies.yes, answered),
      };
    });
  }

  // ── Notifications ───────────────────────────────────────────────────────────

  /** Delivery outcomes by channel over the range. */
  notifications(
    from: string,
    to: string,
  ): Promise<
    { channel: string; sent: number; failed: number; other: number; failureRate: number | null }[]
  > {
    return this.cached(`notifications:${from}:${to}`, async () => {
      const rows = await this.db
        .collection('delivery_logs')
        .aggregate<{ _id: { c: string; s: string }; n: number }>([
          { $match: { createdAt: dayRange(from, to) } },
          { $group: { _id: { c: '$channel', s: '$status' }, n: { $sum: 1 } } },
        ])
        .toArray();
      const by = new Map<string, { sent: number; failed: number; other: number }>();
      for (const r of rows) {
        const c = by.get(r._id.c) ?? { sent: 0, failed: 0, other: 0 };
        if (r._id.s === 'sent') c.sent += r.n;
        else if (r._id.s === 'failed') c.failed += r.n;
        else c.other += r.n;
        by.set(r._id.c, c);
      }
      return [...by].map(([channel, c]) => ({
        channel,
        ...c,
        failureRate: pct(c.failed, c.sent + c.failed),
      }));
    });
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Product search per day: searches (answered from cache or sent to the
   * store), the share that found nothing, searches on each store tab, and the
   * paid calls the provider was sent. Counters, so they start on the day the
   * counter shipped and reach back at most 92 days.
   */
  search(
    from: string,
    to: string,
  ): Promise<{
    provider: string;
    days: {
      day: string;
      searches: number;
      fromCache: number;
      empty: number;
      providerCalls: number;
    }[];
    totals: {
      searches: number;
      empty: number;
      emptyRate: number | null;
      providerCalls: number;
      cacheRate: number | null;
    };
    platforms: { platform: string; searches: number }[];
  }> {
    return this.cached(`search:${from}:${to}`, async () => {
      const provider = this.config.get('products', { infer: true }).provider;
      const days = daysBetween(from, to);
      const [stats, calls] = await Promise.all([
        this.products.searchStatsOn(days),
        this.guard.requestsOnDays(provider, days),
      ]);
      const platforms: Record<string, number> = {};
      for (const s of stats) {
        for (const [k, v] of Object.entries(s.platforms)) platforms[k] = (platforms[k] ?? 0) + v;
      }
      const rows = stats.map((s, i) => ({
        day: s.day,
        searches: s.hits + s.misses,
        fromCache: s.hits,
        empty: s.empty,
        providerCalls: calls[i] ?? 0,
      }));
      const total = (k: 'searches' | 'fromCache' | 'empty' | 'providerCalls') =>
        rows.reduce((a, r) => a + r[k], 0);
      return {
        provider,
        days: rows,
        totals: {
          searches: total('searches'),
          empty: total('empty'),
          emptyRate: pct(total('empty'), total('searches')),
          providerCalls: total('providerCalls'),
          cacheRate: pct(total('fromCache'), total('searches')),
        },
        platforms: Object.entries(platforms)
          .map(([platform, searches]) => ({ platform, searches }))
          .sort((a, b) => b.searches - a.searches),
      };
    });
  }

  // ── Raw events ──────────────────────────────────────────────────────────────

  /** The raw event stream, newest first — for checking what the apps send. Not cached. */
  async rawEvents(q: RawEventQuery): Promise<
    AdminPage<{
      id: string;
      name: string;
      userId: string | null;
      anonymousId: string | null;
      source: string | null;
      props: unknown;
      ts: Date | null;
    }> & { names: Record<string, string> }
  > {
    const { page, limit } = pageOf(q.page, q.limit);
    const filter: Doc = {};
    if (q.name) filter.name = q.name;
    if (q.user) filter.userId = oid(q.user) ?? new Types.ObjectId('000000000000000000000000');
    if (q.q?.trim()) filter.anonymousId = { $regex: escapeRegex(q.q.trim()), $options: 'i' };
    const range = dayRange(q.from, q.to);
    if (range) filter.ts = range;
    const col = this.db.collection('analytics_events');
    const [docs, total] = await Promise.all([
      col
        .find(filter)
        .sort({ ts: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      col.countDocuments(filter),
    ]);
    const items = docs.map((d) => ({
      id: id(d._id)!,
      name: String(d.name),
      userId: id(d.userId),
      anonymousId: str(d.anonymousId),
      source: str(d.source),
      props: (d.props ?? {}) as unknown,
      ts: at(d.ts),
    }));
    const users = [...new Set(items.map((i) => i.userId).filter((x): x is string => !!x))];
    return { items, total, page, limit, names: await this.user360.namesFor(users) };
  }

  /** The event names the stream holds, for the raw view's filter. */
  eventNames(): Promise<string[]> {
    return this.cached('event-names', async () => {
      const names = await this.db.collection('analytics_events').distinct('name');
      return names.filter((n): n is string => typeof n === 'string').sort();
    });
  }
}
