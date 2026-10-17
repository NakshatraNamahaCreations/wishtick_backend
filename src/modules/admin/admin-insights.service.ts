import { paymentKindFilter, paymentStateFilter } from './group-gift-payments';
import { SENT_CHANNELS_ONLY, isShownChannel } from './notification-channels';
import { Injectable } from '@nestjs/common';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
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
  /** The people behind each figure, so it can be said as "3 of 13". */
  counts: { d1: BackCount; d7: BackCount; d30: BackCount; weeks: (number | null)[] };
}

/**
 * How many came back on a day after joining, of how many that day has
 * already come for — someone who joined yesterday cannot be back a week later yet.
 */
export interface BackCount {
  back: number;
  eligible: number;
}

/** Which number on the analytics desk to list the people behind, and its settings. */
export interface PeopleQuery {
  /** e.g. `funnel.onboarded`, `retention.d7`, `gifting.purchased`, `deliveries.failed`. */
  metric: string;
  from?: string;
  to?: string;
  /** The overview's snapshot day. */
  day?: string;
  /** Retention: how many weeks are shown, a cohort's week, and the week after joining. */
  weeks?: number;
  week?: string;
  k?: number;
  source?: string;
  type?: string;
  channel?: string;
  /** A search's words, for `searches.term`. */
  term?: string;
  page?: number;
  limit?: number;
}

/**
 * The analytics desk's deeper reads: the signup funnel, retention by weekly
 * cohort, and how gifting, group gifts, events, notifications and product
 * search are doing over a range, what people searched for, and the people
 * behind each of those numbers.
 *
 * It is computed from the records themselves
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
    overall: {
      d1: number | null;
      d7: number | null;
      d30: number | null;
      /** Everyone who joined in the weeks shown. */
      joined: number;
      counts: { d1: BackCount; d7: BackCount; d30: BackCount };
    };
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
        const weekBack: (number | null)[] = [];
        for (let k = 1; k < weeks - w; k++) {
          // Week k after joining is over for the whole cohort only once the
          // cohort's last day plus k weeks has passed.
          if (ws + (k + 1) * 7 * DAY_MS > now) {
            weekRates.push(null);
            weekBack.push(null);
            continue;
          }
          const back = members.filter((u) => offsets(u).some((o) => o >= 7 * k && o < 7 * (k + 1)));
          weekRates.push(pct(back.length, members.length));
          weekBack.push(back.length);
        }
        const days = [1, 7, 30].map((d) => rate(members, d));
        const [d1, d7, d30] = days.map((r) => pct(r.back, r.eligible));
        cohorts.push({
          week: dayOf(new Date(ws)),
          size: members.length,
          weeks: weekRates,
          d1,
          d7,
          d30,
          counts: {
            d1: days[0],
            d7: days[1],
            d30: days[2],
            weeks: weekBack,
          },
        });
      }

      const all = ([1, 7, 30] as const).map((d) => rate(users, d));
      const overall = {
        d1: pct(all[0].back, all[0].eligible),
        d7: pct(all[1].back, all[1].eligible),
        d30: pct(all[2].back, all[2].eligible),
        joined: users.length,
        counts: { d1: all[0], d7: all[1], d30: all[2] },
      };
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
    /** Confirmed money, after refunds handed back. */
    collectedMinor: number;
    targetMinor: number;
    /** Money members say they sent that the host has not confirmed. */
    awaitingMinor: number;
    /** Gifts the host finished by paying what was left. */
    settledByHost: number;
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
        ...(await this.paymentTotals(
          rows.map((r) => r._id as Types.ObjectId),
          // A cancelled gift is frozen: its host can no longer confirm what is waiting.
          rows
            .filter(
              (r) =>
                r.status !== GroupGiftStatus.CANCELLED && r.status !== GroupGiftStatus.REFUNDING,
            )
            .map((r) => r._id as Types.ObjectId),
        )),
      };
    });
  }

  /** Money still awaiting a host across [liveIds], and host settle-ups across [giftIds]. */
  private async paymentTotals(
    giftIds: Types.ObjectId[],
    liveIds: Types.ObjectId[],
  ): Promise<{ awaitingMinor: number; settledByHost: number }> {
    if (giftIds.length === 0) return { awaitingMinor: 0, settledByHost: 0 };
    const [awaiting, settled] = await Promise.all([
      this.db
        .collection('contributions')
        .aggregate<{ minor: number }>([
          { $match: { groupGiftId: { $in: liveIds }, ...paymentStateFilter('awaiting') } },
          {
            $group: { _id: null, minor: { $sum: { $ifNull: ['$claimedMinor', '$amountMinor'] } } },
          },
        ])
        .toArray(),
      this.db.collection('contributions').distinct('groupGiftId', {
        groupGiftId: { $in: giftIds },
        status: 'confirmed',
        ...paymentKindFilter('settle_up'),
      }),
    ]);
    return { awaitingMinor: awaiting[0]?.minor ?? 0, settledByHost: settled.length };
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
          { $match: { createdAt: dayRange(from, to), ...SENT_CHANNELS_ONLY } },
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

  // ── What people search for ──────────────────────────────────────────────────

  /**
   * The searches people typed in the range, from the search log: how many, by
   * how many people, how many the cache answered, and what was searched most
   * and by whom. The log starts on the day it shipped and keeps 180 days.
   */
  searchActivity(
    from: string,
    to: string,
  ): Promise<{
    searches: number;
    people: number;
    fromCache: number;
    live: number;
    stale: number;
    foundNothing: number;
    topSearches: {
      query: string;
      searches: number;
      people: number;
      foundNothing: number;
      lastAt: Date | null;
    }[];
    topSearchers: { id: string; name: string | null; searches: number; lastAt: Date | null }[];
    loggingSince: Date | null;
  }> {
    return this.cached(`search-activity:${from}:${to}`, async () => {
      const logs = this.db.collection('search_logs');
      const match = { createdAt: dayRange(from, to) };
      const [totals, byFreshness, topSearches, topSearchers, first] = await Promise.all([
        logs
          .aggregate<{ searches: number; people: string[]; empty: number }>([
            { $match: match },
            {
              $group: {
                _id: null,
                searches: { $sum: 1 },
                people: { $addToSet: '$userId' },
                empty: { $sum: { $cond: [{ $eq: ['$results', 0] }, 1, 0] } },
              },
            },
          ])
          .toArray(),
        logs
          .aggregate<{ _id: string; n: number }>([
            { $match: match },
            { $group: { _id: '$freshness', n: { $sum: 1 } } },
          ])
          .toArray(),
        logs
          .aggregate<{
            _id: string;
            query: string;
            searches: number;
            people: unknown[];
            empty: number;
            lastAt: Date;
          }>([
            { $match: { ...match, normalized: { $ne: '' } } },
            {
              $group: {
                _id: '$normalized',
                query: { $last: '$query' },
                searches: { $sum: 1 },
                people: { $addToSet: '$userId' },
                empty: { $sum: { $cond: [{ $eq: ['$results', 0] }, 1, 0] } },
                lastAt: { $max: '$createdAt' },
              },
            },
            { $sort: { searches: -1, lastAt: -1 } },
            { $limit: 25 },
          ])
          .toArray(),
        logs
          .aggregate<{ _id: Types.ObjectId; searches: number; lastAt: Date }>([
            { $match: match },
            { $group: { _id: '$userId', searches: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
            { $sort: { searches: -1, lastAt: -1 } },
            { $limit: 25 },
          ])
          .toArray(),
        logs.find().sort({ createdAt: 1 }).limit(1).project({ createdAt: 1 }).next(),
      ]);
      const names = await this.user360.namesFor(topSearchers.map((s) => String(s._id)));
      const fresh = (k: string) => byFreshness.find((r) => r._id === k)?.n ?? 0;
      return {
        searches: totals[0]?.searches ?? 0,
        people: totals[0]?.people.length ?? 0,
        fromCache: fresh('cached'),
        live: fresh('live'),
        stale: fresh('stale'),
        foundNothing: totals[0]?.empty ?? 0,
        topSearches: topSearches.map((t) => ({
          query: t.query || t._id,
          searches: t.searches,
          people: t.people.length,
          foundNothing: t.empty,
          lastAt: t.lastAt,
        })),
        topSearchers: topSearchers.map((s) => ({
          id: String(s._id),
          name: names[String(s._id)] ?? null,
          searches: s.searches,
          lastAt: s.lastAt,
        })),
        loggingSince: at(first?.createdAt),
      };
    });
  }

  /** Every search in the log, newest first, filtered by words, person or source. Not cached. */
  async searchLog(q: {
    q?: string;
    user?: string;
    freshness?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<
    AdminPage<{
      id: string;
      userId: string | null;
      query: string;
      category: string | null;
      platform: string | null;
      freshness: string;
      results: number;
      createdAt: Date | null;
    }> & { names: Record<string, string> }
  > {
    const { page, limit } = pageOf(q.page, q.limit);
    const filter: Doc = {};
    const range = dayRange(q.from, q.to);
    if (range) filter.createdAt = range;
    if (q.q?.trim()) {
      filter.normalized = { $regex: escapeRegex(q.q.trim().toLowerCase()), $options: 'i' };
    }
    if (q.user) filter.userId = oid(q.user) ?? new Types.ObjectId('000000000000000000000000');
    if (q.freshness) filter.freshness = q.freshness;
    const col = this.db.collection('search_logs');
    const [docs, total] = await Promise.all([
      col
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      col.countDocuments(filter),
    ]);
    const items = docs.map((d) => ({
      id: id(d._id)!,
      userId: id(d.userId),
      query: str(d.query) ?? '',
      category: str(d.category),
      platform: str(d.platform),
      freshness: str(d.freshness) ?? 'live',
      results: typeof d.results === 'number' ? d.results : 0,
      createdAt: at(d.createdAt),
    }));
    const users = [...new Set(items.map((i) => i.userId).filter((x): x is string => !!x))];
    return { items, total, page, limit, names: await this.user360.namesFor(users) };
  }

  // ── The people behind a number ──────────────────────────────────────────────

  /**
   * Everyone a number on the analytics desk counts, newest first: the people
   * behind a funnel step, a retention figure, a gifting outcome, an event
   * reply or a delivery outcome. Each list is drawn from the same records, by
   * the same rules, as its number — so the two always agree.
   */
  async people(q: PeopleQuery): Promise<
    AdminPage<{
      id: string;
      name: string | null;
      /** When they did the thing counted. */
      at: Date | null;
      /** How many times, where one person can be counted more than once. */
      times: number;
      joinedAt: Date | null;
    }> & { metric: string; withoutAccount: number }
  > {
    const { page, limit } = pageOf(q.page, q.limit, 25);
    const { hits, withoutAccount } = await this.peopleBehind(q);
    const byPerson = new Map<string, { at: Date | null; times: number }>();
    for (const h of hits) {
      if (!h.userId) continue;
      const key = h.userId;
      const seen = byPerson.get(key);
      if (!seen) byPerson.set(key, { at: h.at, times: 1 });
      else {
        seen.times += 1;
        if (h.at && (!seen.at || h.at > seen.at)) seen.at = h.at;
      }
    }
    const ordered = [...byPerson].sort(
      ([, a], [, b]) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0),
    );
    const slice = ordered.slice((page - 1) * limit, page * limit);
    const ids = slice.map(([k]) => k);
    const [names, users] = await Promise.all([
      this.user360.namesFor(ids),
      this.db
        .collection('users')
        .find({ _id: { $in: ids.map((k) => new Types.ObjectId(k)) } })
        .project({ createdAt: 1 })
        .toArray(),
    ]);
    const joined = new Map(users.map((u) => [String(u._id), at(u.createdAt)]));
    return {
      metric: q.metric,
      items: slice.map(([k, v]) => ({
        id: k,
        name: names[k] ?? null,
        at: v.at,
        times: v.times,
        joinedAt: joined.get(k) ?? null,
      })),
      total: ordered.length,
      page,
      limit,
      withoutAccount,
    };
  }

  /** Who [q.metric] counts, one hit per record. */
  private async peopleBehind(
    q: PeopleQuery,
  ): Promise<{ hits: { userId: string | null; at: Date | null }[]; withoutAccount: number }> {
    const from = q.from ?? dayOf(new Date(Date.now() - 30 * DAY_MS));
    const to = q.to ?? dayOf(new Date());
    const range = dayRange(from, to);
    const hitsOf = async (
      collection: string,
      filter: Doc,
      who: string,
      when: string,
    ): Promise<{ userId: string | null; at: Date | null }[]> =>
      (
        await this.db
          .collection(collection)
          .find(filter)
          .project({ [who]: 1, [when]: 1 })
          .toArray()
      ).map((d) => ({
        userId: id(who.split('.').reduce<unknown>((o, k) => (o as Doc | undefined)?.[k], d)),
        at: at(d[when]),
      }));
    const none = { withoutAccount: 0 };
    const [group, part] = q.metric.split('.') as [string, string | undefined];

    switch (group) {
      case 'active': {
        // The rollup's windows: the day, or the 7 or 30 days ending with it.
        const day = q.day ?? dayOf(new Date());
        const end = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
        const span = part === 'month' ? 30 : part === 'week' ? 7 : 1;
        const rows = await this.db
          .collection('analytics_events')
          .aggregate<{ _id: Types.ObjectId; last: Date }>([
            {
              $match: {
                ts: { $gte: new Date(end - span * DAY_MS), $lt: new Date(end) },
                userId: { $ne: null },
              },
            },
            { $group: { _id: '$userId', last: { $max: '$ts' } } },
          ])
          .toArray();
        return { hits: rows.map((r) => ({ userId: id(r._id), at: r.last })), ...none };
      }

      case 'signups': {
        // As the rollup counts them: the signup event, by its source.
        const source = q.source ?? 'organic';
        return {
          hits: await hitsOf(
            'analytics_events',
            {
              name: 'signup',
              ts: range,
              source: source === 'organic' ? { $in: [null, 'organic'] } : source,
            },
            'userId',
            'ts',
          ),
          ...none,
        };
      }

      case 'created': {
        const made: Record<string, [string, Doc, string]> = {
          wishlistsCreated: ['wishlists', {}, 'ownerId'],
          eventsCreated: ['events', {}, 'hostId'],
          giftsCreated: ['gifts', {}, 'gifterId'],
          giftsFulfilled: ['gifts', { status: 'fulfilled' }, 'gifterId'],
          groupGiftsCreated: ['group_gifts', {}, 'initiatorId'],
          reelsCreated: ['reel_collections', {}, 'initiatorId'],
          reelsReleased: ['reel_collections', { status: 'released' }, 'initiatorId'],
        };
        const spec = made[part ?? ''];
        if (!spec) break;
        const [collection, filter, who] = spec;
        return {
          hits: await hitsOf(collection, { ...filter, createdAt: range }, who, 'createdAt'),
          ...none,
        };
      }

      case 'funnel': {
        const users = await this.db
          .collection('users')
          .find({ createdAt: range, deletedAt: null })
          .project({ createdAt: 1 })
          .toArray();
        const ids = users.map((u) => u._id as Types.ObjectId);
        const firstBy = async (collection: string, owner: string, field: string, match: Doc = {}) =>
          (
            await this.db
              .collection(collection)
              .aggregate<{ _id: unknown; first: Date }>([
                {
                  $match: {
                    [owner]: { $in: owner.startsWith('props.') ? ids.map(String) : ids },
                    ...match,
                  },
                },
                { $group: { _id: `$${owner}`, first: { $min: `$${field}` } } },
              ])
              .toArray()
          ).map((r) => ({ userId: id(r._id), at: r.first }));
        switch (part) {
          case 'signed_up':
            return {
              hits: users.map((u) => ({ userId: id(u._id), at: at(u.createdAt) })),
              ...none,
            };
          case 'onboarded':
            return {
              hits: await firstBy('user_profiles', 'userId', 'onboardingCompletedAt', {
                onboardingCompletedAt: { $ne: null },
              }),
              ...none,
            };
          case 'wishlist':
            return { hits: await firstBy('wishlists', 'ownerId', 'createdAt'), ...none };
          case 'item':
            return { hits: await firstBy('wishlist_items', 'ownerId', 'createdAt'), ...none };
          case 'shared':
            return {
              hits: await firstBy('analytics_events', 'props.ownerId', 'ts', {
                name: 'wishlist_link_opened',
              }),
              ...none,
            };
        }
        break;
      }

      case 'retention':
        return { hits: await this.retentionPeople(q), ...none };

      case 'gifting': {
        const single = { createdAt: range, type: GiftType.SINGLE };
        const gifts = await this.db
          .collection('gifts')
          .find(part === 'self' ? { createdAt: range, type: GiftType.SELF } : single)
          .project({ gifterId: 1, status: 1, createdAt: 1, purchasedAt: 1, 'history.by': 1 })
          .toArray();
        const expired = (g: Doc) =>
          Array.isArray(g.history) && (g.history as Doc[]).some((h) => h.by === 'system:expiry');
        const pick: Record<string, (g: Doc) => boolean> = {
          reserved: () => true,
          self: () => true,
          purchased: (g) => g.purchasedAt instanceof Date,
          expired,
          cancelled: (g) => g.status === GiftStatus.CANCELLED && !expired(g),
          held: (g) => g.status === GiftStatus.RESERVED,
        };
        const keep = pick[part ?? ''];
        if (!keep) break;
        return {
          hits: gifts.filter(keep).map((g) => ({
            userId: id(g.gifterId),
            at: at(part === 'purchased' ? g.purchasedAt : g.createdAt),
          })),
          ...none,
        };
      }

      case 'groupGifts': {
        const gifts = await this.db
          .collection('group_gifts')
          .find({ createdAt: range })
          .project({ initiatorId: 1, status: 1, createdAt: 1 })
          .toArray();
        if (part === 'contributors') {
          return {
            hits: await hitsOf(
              'contributions',
              {
                groupGiftId: { $in: gifts.map((g) => g._id as Types.ObjectId) },
                ...paymentKindFilter('member'),
              },
              'userId',
              'createdAt',
            ),
            ...none,
          };
        }
        const funded: string[] = [
          GroupGiftStatus.FUNDED,
          GroupGiftStatus.PURCHASING,
          GroupGiftStatus.PURCHASED,
          GroupGiftStatus.FULFILLED,
        ];
        const pick: Record<string, (s: string) => boolean> = {
          started: () => true,
          funded: (s) => funded.includes(s),
          open: (s) => s === String(GroupGiftStatus.OPEN),
          cancelled: (s) =>
            s === String(GroupGiftStatus.CANCELLED) || s === String(GroupGiftStatus.REFUNDING),
        };
        const keep = pick[part ?? ''];
        if (!keep) break;
        return {
          hits: gifts
            .filter((g) => keep(String(g.status)))
            .map((g) => ({ userId: id(g.initiatorId), at: at(g.createdAt) })),
          ...none,
        };
      }

      case 'events': {
        const events = await this.db
          .collection('events')
          .find({ createdAt: range, ...(q.type ? { type: q.type } : {}) })
          .project({ hostId: 1, createdAt: 1 })
          .toArray();
        if (part === 'created') {
          return {
            hits: events.map((e) => ({ userId: id(e.hostId), at: at(e.createdAt) })),
            ...none,
          };
        }
        const rsvp: Record<string, Doc> = {
          invited: {},
          yes: { rsvp: 'yes' },
          no: { rsvp: 'no' },
          maybe: { rsvp: 'maybe' },
          pending: { rsvp: { $in: [null, 'pending'] } },
        };
        const which = rsvp[part ?? ''];
        if (!which) break;
        const invites = await this.db
          .collection('event_invites')
          .find({ eventId: { $in: events.map((e) => e._id as Types.ObjectId) }, ...which })
          .project({ invitedUserId: 1, respondedAt: 1, createdAt: 1 })
          .toArray();
        return {
          hits: invites.map((i) => ({
            userId: id(i.invitedUserId),
            at: at(i.respondedAt ?? i.createdAt),
          })),
          // Guests invited by phone number who have no account to open.
          withoutAccount: invites.filter((i) => !i.invitedUserId).length,
        };
      }

      case 'searches': {
        // `searches.all` — everyone who searched; `searches.term` — who searched [q.term].
        const filter: Doc = { createdAt: range };
        if (part === 'term') filter.normalized = (q.term ?? '').trim().toLowerCase();
        else if (part === 'cached') filter.freshness = 'cached';
        else if (part === 'empty') filter.results = 0;
        else if (part !== 'all') break;
        return { hits: await hitsOf('search_logs', filter, 'userId', 'createdAt'), ...none };
      }

      case 'deliveries': {
        const channel = q.channel ?? 'push';
        if (!isShownChannel(channel)) return { hits: [], ...none };
        const status = part === 'sent' || part === 'failed' ? part : { $nin: ['sent', 'failed'] };
        return {
          hits: await hitsOf(
            'delivery_logs',
            { createdAt: range, channel, status },
            'userId',
            'createdAt',
          ),
          ...none,
        };
      }
    }
    throw new AppException(ErrorCode.VALIDATION_FAILED, `Nothing to list for ${q.metric}`, 400);
  }

  /**
   * The people behind a retention figure, by the same rules as [retention]:
   * `retention.d1|d7|d30` — back on that day after joining; `retention.cohort`
   * with [week] and [k] — the cohort itself (k = 0), or those back in week k.
   */
  private async retentionPeople(
    q: PeopleQuery,
  ): Promise<{ userId: string | null; at: Date | null }[]> {
    const weeks = q.weeks ?? 8;
    const thisWeek = weekStart(new Date());
    const start = thisWeek - (weeks - 1) * 7 * DAY_MS;
    let users = await this.db
      .collection('users')
      .find({ createdAt: { $gte: new Date(start) }, deletedAt: null })
      .project({ createdAt: 1 })
      .toArray();
    const part = q.metric.split('.')[1];
    // A cohort's week narrows any of these to the people who joined that week.
    if (q.week) {
      const ws = Date.parse(`${q.week}T00:00:00.000Z`);
      users = users.filter((u) => weekStart(u.createdAt as Date) === ws);
    }
    if (part === 'cohort' && (q.k ?? 0) === 0) {
      return users.map((u) => ({ userId: id(u._id), at: at(u.createdAt) }));
    }
    const rows = await this.db
      .collection('analytics_events')
      .aggregate<{ _id: { u: Types.ObjectId; d: string }; last: Date }>([
        {
          $match: {
            userId: { $in: users.map((u) => u._id as Types.ObjectId) },
            ts: { $gte: new Date(start) },
          },
        },
        {
          $group: {
            _id: { u: '$userId', d: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } } },
            last: { $max: '$ts' },
          },
        },
      ])
      .toArray();
    const days = new Map<string, Map<number, Date>>();
    const joinedDay = new Map(users.map((u) => [String(u._id), startOfDay(u.createdAt as Date)]));
    for (const r of rows) {
      const key = String(r._id.u);
      const offset = Math.round(
        (Date.parse(`${r._id.d}T00:00:00Z`) - (joinedDay.get(key) ?? 0)) / DAY_MS,
      );
      if (!days.has(key)) days.set(key, new Map());
      days.get(key)!.set(offset, r.last);
    }
    const today = startOfDay(new Date());
    const backOn = (pick: (offset: number) => boolean) =>
      users.flatMap((u) => {
        const seen = [...(days.get(String(u._id)) ?? new Map<number, Date>())].filter(([o]) =>
          pick(o),
        );
        if (seen.length === 0) return [];
        const last = seen.reduce((a, [, d]) => (d > a ? d : a), seen[0][1]);
        return [{ userId: id(u._id), at: last }];
      });
    if (part === 'cohort') {
      const k = q.k ?? 0;
      return backOn((o) => o >= 7 * k && o < 7 * (k + 1));
    }
    const n = Number(part?.replace(/^d/, ''));
    if (![1, 7, 30].includes(n)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, `Nothing to list for ${q.metric}`, 400);
    }
    // Only people for whom that day has been and gone, as the rate counts them.
    users = users.filter((u) => startOfDay(u.createdAt as Date) + n * DAY_MS < today);
    return backOn((o) => o === n);
  }
}
