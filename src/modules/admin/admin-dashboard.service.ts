import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import type { Aggregate, Model, PipelineStage } from 'mongoose';
import { UserStatus } from 'src/common/enums/user-role.enum';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { CacheService } from 'src/infra/redis/cache.service';
import { AnalyticsService } from 'src/modules/analytics/analytics.service';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { Gift, type GiftDocument } from 'src/modules/gifting/schemas/gift.schema';
import {
  WebhookEvent,
  WebhookEventStatus,
  type WebhookEventDocument,
} from 'src/modules/gifting/schemas/webhook-event.schema';
import {
  GroupGift,
  type GroupGiftDocument,
} from 'src/modules/group-gifts/schemas/group-gift.schema';
import { Media, MediaStatus, type MediaDocument } from 'src/modules/media/schemas/media.schema';
import {
  MemoryCapsule,
  type MemoryCapsuleDocument,
} from 'src/modules/memories/schemas/memory-capsule.schema';
import {
  DeliveryLog,
  type DeliveryLogDocument,
} from 'src/modules/notifications/schemas/delivery-log.schema';
import {
  ClickEvent,
  type ClickEventDocument,
} from 'src/modules/products/schemas/click-event.schema';
import {
  Conversion,
  type ConversionDocument,
} from 'src/modules/products/schemas/conversion.schema';
import {
  ReelCollection,
  type ReelCollectionDocument,
} from 'src/modules/reels/schemas/reel-collection.schema';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import { AdminPermission } from './admin.types';
import { ReportStatus } from './moderation.types';
import { Report, type ReportDocument } from './schemas/report.schema';

const DAY_MS = 86_400_000;

/** Any collection that can run an aggregation — what the daily helpers need. */
interface Aggregates {
  aggregate<R>(pipeline: PipelineStage[]): Aggregate<R[]>;
}
/** One cached snapshot for every admin; each sees only their sections of it. */
const CACHE_KEY = 'admin:dashboard:v1';
const CACHE_TTL_SECONDS = 60;
/** How far back the trend charts reach. */
const SERIES_DAYS = 30;
/** A report this serious or worse is called out on its own. */
const HIGH_SEVERITY = 5;

export interface AttentionItem {
  /** Stable key the panel maps to a page. */
  key: string;
  label: string;
  count: number;
  tone: 'crit' | 'warn' | 'info';
}

export interface DayPoint {
  day: string;
  [series: string]: number | string;
}

export interface DashboardView {
  generatedAt: string;
  users?: {
    total: number;
    newToday: number;
    new7d: number;
    suspended: number;
    dau: number;
    mau: number;
  };
  content?: {
    wishlists: number;
    items: number;
    eventsNext7d: number;
    memoriesUnlockingNext7d: number;
  };
  money?: {
    giftsReserved: number;
    giftsPurchased7d: number;
    giftsFulfilled7d: number;
    gmvMinor30d: number;
    groupGiftsOpen: number;
    groupGiftsFunded: number;
    groupGiftCollectedMinorOpen: number;
    clicks30d: number;
    conversions30d: number;
    commissionMinor30d: number;
  };
  attention: AttentionItem[];
  series: {
    signups?: DayPoint[];
    gifts?: DayPoint[];
    money?: DayPoint[];
  };
}

/** Everything, before it is cut down to what one admin may see. */
interface Snapshot {
  generatedAt: string;
  users: NonNullable<DashboardView['users']>;
  content: NonNullable<DashboardView['content']>;
  money: NonNullable<DashboardView['money']>;
  attention: (AttentionItem & { permission: AdminPermission })[];
  series: Required<DashboardView['series']>;
}

/**
 * The admin home page: how the platform is doing, and what needs someone now.
 *
 * Counted live from the collections (cached for a minute), not from the
 * nightly rollup — a dashboard that shows yesterday's numbers when the rollup
 * has not run looks broken. DAU/MAU are the exception: they need the rollup's
 * distinct-user counting.
 */
@Injectable()
export class AdminDashboardService {
  private readonly queues: Queue[];

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Wishlist.name) private readonly wishlists: Model<WishlistDocument>,
    @InjectModel(WishlistItem.name) private readonly items: Model<WishlistItemDocument>,
    @InjectModel(Event.name) private readonly events: Model<EventDocument>,
    @InjectModel(MemoryCapsule.name) private readonly memories: Model<MemoryCapsuleDocument>,
    @InjectModel(Gift.name) private readonly gifts: Model<GiftDocument>,
    @InjectModel(GroupGift.name) private readonly groupGifts: Model<GroupGiftDocument>,
    @InjectModel(ClickEvent.name) private readonly clicks: Model<ClickEventDocument>,
    @InjectModel(Conversion.name) private readonly conversions: Model<ConversionDocument>,
    @InjectModel(Report.name) private readonly reports: Model<ReportDocument>,
    @InjectModel(WebhookEvent.name) private readonly webhooks: Model<WebhookEventDocument>,
    @InjectModel(DeliveryLog.name) private readonly deliveries: Model<DeliveryLogDocument>,
    @InjectModel(ReelCollection.name) private readonly reels: Model<ReelCollectionDocument>,
    @InjectModel(Media.name) private readonly media: Model<MediaDocument>,
    @InjectQueue(QUEUE.HEALTH) health: Queue,
    @InjectQueue(QUEUE.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(QUEUE.REELS) reelsQueue: Queue,
    @InjectQueue(QUEUE.AFFILIATE_SYNC) affiliate: Queue,
    @InjectQueue(QUEUE.ANALYTICS_ROLLUP) rollup: Queue,
    @InjectQueue(QUEUE.SCHEDULER) scheduler: Queue,
    private readonly analytics: AnalyticsService,
    private readonly cache: CacheService,
  ) {
    this.queues = [health, notifications, reelsQueue, affiliate, rollup, scheduler];
  }

  async forAdmin(permissions: AdminPermission[]): Promise<DashboardView> {
    const snap = await this.cache.wrap(CACHE_KEY, CACHE_TTL_SECONDS, () => this.snapshot());
    const can = (p: AdminPermission) => permissions.includes(p);
    return {
      generatedAt: snap.generatedAt,
      ...(can(AdminPermission.USERS_VIEW) ? { users: snap.users } : {}),
      ...(can(AdminPermission.CONTENT_VIEW) ? { content: snap.content } : {}),
      ...(can(AdminPermission.MONEY_VIEW) ? { money: snap.money } : {}),
      attention: snap.attention
        .filter((a) => can(a.permission))
        .map(({ key, label, count, tone }) => ({ key, label, count, tone })),
      series: {
        ...(can(AdminPermission.USERS_VIEW) ? { signups: snap.series.signups } : {}),
        ...(can(AdminPermission.MONEY_VIEW)
          ? { gifts: snap.series.gifts, money: snap.series.money }
          : {}),
      },
    };
  }

  private async snapshot(): Promise<Snapshot> {
    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const ahead = (days: number) => new Date(now.getTime() + days * DAY_MS);
    const seriesStart = new Date(startOfToday.getTime() - (SERIES_DAYS - 1) * DAY_MS);

    const [users, content, money, attention, signups, gifts, moneySeries] = await Promise.all([
      this.userCounts(startOfToday, ago),
      this.contentCounts(now, ahead),
      this.moneyCounts(ago),
      this.attention(now, ago),
      this.dailyCounts(this.users, 'createdAt', {}, seriesStart),
      this.giftSeries(seriesStart),
      this.moneySeries(seriesStart),
    ]);

    return {
      generatedAt: now.toISOString(),
      users,
      content,
      money,
      attention,
      series: {
        signups: AdminDashboardService.fillDays(seriesStart, { signups: signups }),
        gifts,
        money: moneySeries,
      },
    };
  }

  private async userCounts(
    startOfToday: Date,
    ago: (days: number) => Date,
  ): Promise<Snapshot['users']> {
    const [total, newToday, new7d, suspended, overview] = await Promise.all([
      this.users.countDocuments({ status: { $ne: UserStatus.DELETED } }).exec(),
      this.users.countDocuments({ createdAt: { $gte: startOfToday } }).exec(),
      this.users.countDocuments({ createdAt: { $gte: ago(7) } }).exec(),
      this.users.countDocuments({ status: UserStatus.SUSPENDED }).exec(),
      // Yesterday's: the rollup counts distinct users over a finished day.
      this.analytics.overview(new Date(startOfToday.getTime() - DAY_MS).toISOString().slice(0, 10)),
    ]);
    return { total, newToday, new7d, suspended, dau: overview.dau, mau: overview.mau };
  }

  private async contentCounts(
    now: Date,
    ahead: (days: number) => Date,
  ): Promise<Snapshot['content']> {
    const [wishlists, items, eventsNext7d, memoriesUnlockingNext7d] = await Promise.all([
      this.wishlists.countDocuments({ archivedAt: null }).exec(),
      this.items.countDocuments({ archivedAt: null }).exec(),
      this.events
        .countDocuments({ status: 'published', startsAt: { $gte: now, $lt: ahead(7) } })
        .exec(),
      this.memories
        .countDocuments({ status: { $ne: 'unlocked' }, unlockAt: { $gte: now, $lt: ahead(7) } })
        .exec(),
    ]);
    return { wishlists, items, eventsNext7d, memoriesUnlockingNext7d };
  }

  private async moneyCounts(ago: (days: number) => Date): Promise<Snapshot['money']> {
    const purchasedStatuses = ['purchased', 'fulfilled', 'completed'];
    const [
      giftsReserved,
      giftsPurchased7d,
      giftsFulfilled7d,
      gmv,
      groupGiftsOpen,
      groupGiftsFunded,
      collected,
      clicks30d,
      conv,
    ] = await Promise.all([
      this.gifts.countDocuments({ status: 'reserved', active: true }).exec(),
      this.gifts.countDocuments({ purchasedAt: { $gte: ago(7) } }).exec(),
      this.gifts.countDocuments({ fulfilledAt: { $gte: ago(7) } }).exec(),
      this.sum(this.gifts, 'amountMinor', {
        status: { $in: purchasedStatuses },
        purchasedAt: { $gte: ago(30) },
      }),
      this.groupGifts.countDocuments({ status: 'open' }).exec(),
      this.groupGifts.countDocuments({ status: 'funded' }).exec(),
      this.sum(this.groupGifts, 'collectedAmountMinor', { status: 'open' }),
      this.clicks.countDocuments({ createdAt: { $gte: ago(30) } }).exec(),
      this.conversions
        .aggregate<{ n: number; commission: number }>([
          { $match: { transactionAt: { $gte: ago(30) } } },
          {
            $group: {
              _id: null,
              n: { $sum: 1 },
              commission: { $sum: { $ifNull: ['$commissionMinor', 0] } },
            },
          },
        ])
        .exec(),
    ]);
    return {
      giftsReserved,
      giftsPurchased7d,
      giftsFulfilled7d,
      gmvMinor30d: gmv,
      groupGiftsOpen,
      groupGiftsFunded,
      groupGiftCollectedMinorOpen: collected,
      clicks30d,
      conversions30d: conv[0]?.n ?? 0,
      commissionMinor30d: conv[0]?.commission ?? 0,
    };
  }

  /** What someone should look at now — each only for the admins who could act on it. */
  private async attention(now: Date, ago: (days: number) => Date): Promise<Snapshot['attention']> {
    const [
      openReports,
      severeReports,
      stuck,
      deadLetters,
      failedDeliveries,
      failedReels,
      failedMedia,
      failedJobs,
    ] = await Promise.all([
      this.reports.countDocuments({ status: ReportStatus.OPEN }).exec(),
      this.reports
        .countDocuments({ status: ReportStatus.OPEN, severity: { $gte: HIGH_SEVERITY } })
        .exec(),
      // Past their hold but still holding the item: the expiry job missed them.
      this.gifts
        .countDocuments({ status: 'reserved', active: true, expiresAt: { $lt: now } })
        .exec(),
      this.webhooks.countDocuments({ status: WebhookEventStatus.UNMATCHED }).exec(),
      this.deliveries.countDocuments({ status: 'failed', createdAt: { $gte: ago(1) } }).exec(),
      this.reels.countDocuments({ status: 'failed' }).exec(),
      this.media.countDocuments({ status: MediaStatus.FAILED, createdAt: { $gte: ago(7) } }).exec(),
      this.failedJobs(),
    ]);

    const items: Snapshot['attention'] = [
      {
        key: 'reports-severe',
        label: 'Serious reports waiting',
        count: severeReports,
        tone: 'crit',
        permission: AdminPermission.MODERATION_VIEW,
      },
      {
        key: 'reports-open',
        label: 'Open reports',
        count: openReports,
        tone: 'warn',
        permission: AdminPermission.MODERATION_VIEW,
      },
      {
        key: 'reservations-stuck',
        label: 'Gift holds past their expiry',
        count: stuck,
        tone: 'warn',
        permission: AdminPermission.MONEY_VIEW,
      },
      {
        key: 'webhooks-unmatched',
        label: 'Sales webhooks that matched no gift',
        count: deadLetters,
        tone: 'warn',
        permission: AdminPermission.MONEY_VIEW,
      },
      {
        key: 'deliveries-failed',
        label: 'Notifications that failed (24h)',
        count: failedDeliveries,
        tone: 'warn',
        permission: AdminPermission.NOTIFICATIONS_VIEW,
      },
      {
        key: 'jobs-failed',
        label: 'Background jobs that failed',
        count: failedJobs,
        tone: 'crit',
        permission: AdminPermission.OPS_VIEW,
      },
      {
        key: 'reels-failed',
        label: 'Reels that failed to compile',
        count: failedReels,
        tone: 'warn',
        permission: AdminPermission.CONTENT_VIEW,
      },
      {
        key: 'media-failed',
        label: 'Uploads that failed (7d)',
        count: failedMedia,
        tone: 'info',
        permission: AdminPermission.CONTENT_VIEW,
      },
    ];
    // Nothing to do is not news: only what has something in it.
    return items.filter((i) => i.count > 0);
  }

  /** Failed jobs across every queue — zero, not an error, if Redis is unreachable. */
  private async failedJobs(): Promise<number> {
    const counts = await Promise.all(
      this.queues.map((q) =>
        q
          .getJobCounts('failed')
          .then((c) => c.failed ?? 0)
          .catch(() => 0),
      ),
    );
    return counts.reduce((a, b) => a + b, 0);
  }

  /** Gifts reserved and purchased, per day. */
  private async giftSeries(start: Date): Promise<DayPoint[]> {
    const [reserved, purchased] = await Promise.all([
      this.dailyCounts(this.gifts, 'reservedAt', {}, start),
      this.dailyCounts(this.gifts, 'purchasedAt', {}, start),
    ]);
    return AdminDashboardService.fillDays(start, { reserved, purchased });
  }

  /** Money bought through gifts, and affiliate commission earned, per day (minor units). */
  private async moneySeries(start: Date): Promise<DayPoint[]> {
    const [gmv, commission] = await Promise.all([
      this.dailySums(this.gifts, 'purchasedAt', 'amountMinor', {}, start),
      this.dailySums(this.conversions, 'transactionAt', 'commissionMinor', {}, start),
    ]);
    return AdminDashboardService.fillDays(start, { gmvMinor: gmv, commissionMinor: commission });
  }

  private async dailyCounts(
    model: Aggregates,
    dateField: string,
    match: Record<string, unknown>,
    start: Date,
  ): Promise<Map<string, number>> {
    return this.dailyAggregate(model, dateField, match, start, { $sum: 1 });
  }

  private async dailySums(
    model: Aggregates,
    dateField: string,
    valueField: string,
    match: Record<string, unknown>,
    start: Date,
  ): Promise<Map<string, number>> {
    return this.dailyAggregate(model, dateField, match, start, {
      $sum: { $ifNull: [`$${valueField}`, 0] },
    });
  }

  private async dailyAggregate(
    model: Aggregates,
    dateField: string,
    match: Record<string, unknown>,
    start: Date,
    accumulator: Record<string, unknown>,
  ): Promise<Map<string, number>> {
    const rows = await model
      .aggregate<{ _id: string; v: number }>([
        { $match: { ...match, [dateField]: { $gte: start } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } },
            v: accumulator,
          },
        },
      ] as PipelineStage[])
      .exec();
    return new Map(rows.map((r) => [r._id, r.v]));
  }

  private async sum(
    model: Aggregates,
    field: string,
    match: Record<string, unknown>,
  ): Promise<number> {
    const rows = await model
      .aggregate<{ total: number }>([
        { $match: match },
        { $group: { _id: null, total: { $sum: { $ifNull: [`$${field}`, 0] } } } },
      ])
      .exec();
    return rows[0]?.total ?? 0;
  }

  /** One point per day from [start] to today, zero where nothing happened. */
  static fillDays(start: Date, series: Record<string, Map<string, number>>): DayPoint[] {
    const out: DayPoint[] = [];
    for (let i = 0; i < SERIES_DAYS; i++) {
      const day = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
      const point: DayPoint = { day };
      for (const [name, values] of Object.entries(series)) point[name] = values.get(day) ?? 0;
      out.push(point);
    }
    return out;
  }
}
