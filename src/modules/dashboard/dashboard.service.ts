import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { ChatService } from 'src/modules/chat/chat.service';
import { ChatType } from 'src/modules/chat/chat.types';
import { NotificationService } from 'src/modules/notifications/notification.service';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import { DashboardSection, type DashboardSummary, type SectionSummary } from './dashboard.types';

const CACHE_TTL_SECONDS = 60;

/**
 * Which sprint fills each section. Everything not listed here reports
 * `available: false` and zeroed counts — an honest "not built yet" rather than
 * an empty state that implies the user simply has no wishlists.
 *
 * As each sprint lands, its section moves to `available` and gains a $lookup
 * facet in the aggregation below.
 */
const SECTION_AVAILABILITY: Record<DashboardSection, boolean> = {
  [DashboardSection.MY_EVENTS]: false, // Sprint 5
  [DashboardSection.INVITED_EVENTS]: false, // Sprint 5
  [DashboardSection.GIFTS_GIVEN]: true, // Sprint 6
  [DashboardSection.GIFTS_RECEIVED]: true, // Sprint 6
  [DashboardSection.GIFTS_ON_HOLD]: true, // Sprint 6
  [DashboardSection.MY_WISHLISTS]: false, // Sprint 3
  [DashboardSection.EVENTS_AND_INVITES]: false, // Sprint 5
  [DashboardSection.WISHLIST_CHATS]: true, // Sprint 8
  [DashboardSection.GROUP_GIFT_CHATS]: true, // Sprint 8
  [DashboardSection.NOTIFICATIONS]: true, // Sprint 9
  [DashboardSection.REELS]: false, // Sprint 10
  [DashboardSection.PROFILE_SETTINGS]: true, // this sprint
};

interface AggregatedRow {
  displayName: string | null;
  userName: string | null;
  photoUrl: string | null;
  onboardingCompletedAt: Date | null;
  dateOfBirth: Date | null;
  interests: string[];
  giftCategories: string[];
  favouriteColors: string[];
  clothingSize: string | null;
  giftsGiven: number;
  giftsOnHold: number;
  giftsReceived: number;
}

/** Fields that make gifting suggestions work. Weighted equally, deliberately. */
const COMPLETENESS_FIELDS = [
  'displayName',
  'photoUrl',
  'dateOfBirth',
  'interests',
  'giftCategories',
  'favouriteColors',
  'clothingSize',
] as const;

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly cache: CacheService,
    private readonly chat: ChatService,
    private readonly notifications: NotificationService,
  ) {}

  static cacheKey(userId: string): string {
    return `dashboard:summary:${userId}`;
  }

  /**
   * Cached 60s per user. Short on purpose: this is the first screen after
   * login, so a stale count for a minute is fine, but a user who just created
   * something must not stare at a stale dashboard for long. Writes that change
   * a count should call invalidate().
   */
  async getSummary(userId: string): Promise<DashboardSummary> {
    return this.cache.wrap(DashboardService.cacheKey(userId), CACHE_TTL_SECONDS, () =>
      this.build(userId),
    );
  }

  async invalidate(userId: string): Promise<void> {
    await this.cache.del(DashboardService.cacheKey(userId));
  }

  private async build(userId: string): Promise<DashboardSummary> {
    // The gift/profile aggregation, plus a second read for chat unread counts —
    // the unread rule lives in ChatService and does not translate cleanly into a
    // nested $lookup, so it is deliberately its own round trip.
    const [row, chatCounts, notifCounts] = await Promise.all([
      this.aggregate(userId),
      this.chat.sectionCounts(userId),
      this.notifications.sectionCounts(userId),
    ]);

    const sections = Object.values(DashboardSection).reduce<
      Record<DashboardSection, SectionSummary>
    >(
      (acc, section) => {
        acc[section] = { count: 0, badge: 0, available: SECTION_AVAILABILITY[section] };
        return acc;
      },
      {} as Record<DashboardSection, SectionSummary>,
    );

    // Gift sections, from the same single aggregation.
    sections[DashboardSection.GIFTS_GIVEN].count = row.giftsGiven;
    sections[DashboardSection.GIFTS_ON_HOLD].count = row.giftsOnHold;
    sections[DashboardSection.GIFTS_ON_HOLD].badge = row.giftsOnHold;
    sections[DashboardSection.GIFTS_RECEIVED].count = row.giftsReceived;

    // Chat sections: count of chats, badge = chats with unread messages.
    sections[DashboardSection.WISHLIST_CHATS].count = chatCounts[ChatType.WISHLIST].count;
    sections[DashboardSection.WISHLIST_CHATS].badge = chatCounts[ChatType.WISHLIST].badge;
    sections[DashboardSection.GROUP_GIFT_CHATS].count = chatCounts[ChatType.GROUP_GIFT].count;
    sections[DashboardSection.GROUP_GIFT_CHATS].badge = chatCounts[ChatType.GROUP_GIFT].badge;

    // Notifications: total + unread badge.
    sections[DashboardSection.NOTIFICATIONS].count = notifCounts.count;
    sections[DashboardSection.NOTIFICATIONS].badge = notifCounts.badge;

    const { completeness, missingFields } = DashboardService.scoreCompleteness(row);

    return {
      sections,
      profile: {
        displayName: row.displayName ?? row.userName,
        photoUrl: row.photoUrl,
        onboardingCompleted: row.onboardingCompletedAt !== null,
        completeness,
        missingFields,
      },
      generatedAt: new Date(),
    };
  }

  /**
   * One round trip.
   *
   * A single aggregation rather than a query per section: the dashboard opens on
   * every app launch, and a section-per-query design becomes 12 round trips that
   * grows with the product. Later sprints add their counts as $lookup stages
   * inside a $facet here, so the trip count stays at one.
   */
  private async aggregate(userId: string): Promise<AggregatedRow> {
    const rows = await this.userModel
      .aggregate<AggregatedRow>([
        { $match: { _id: new Types.ObjectId(userId), deletedAt: null } },
        {
          $lookup: {
            from: 'user_profiles',
            localField: '_id',
            foreignField: 'userId',
            as: 'profile',
          },
        },
        // preserveNull: the profile is created lazily, so a brand-new user has
        // no profile row yet and must still get a dashboard.
        { $unwind: { path: '$profile', preserveNullAndEmptyArrays: true } },
        // Gifts I'm giving. A pipeline $lookup so the counts are computed in the
        // same round trip rather than as separate queries.
        {
          $lookup: {
            from: 'gifts',
            let: { uid: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$gifterId', '$$uid'] } } },
              {
                $group: {
                  _id: null,
                  given: { $sum: 1 },
                  onHold: {
                    $sum: {
                      $cond: [{ $in: ['$status', ['reserved', 'purchased', 'fulfilled']] }, 1, 0],
                    },
                  },
                },
              },
            ],
            as: 'giftsGivenAgg',
          },
        },
        // Gifts I've received — surprises in progress excluded, matching
        // GiftingService.listReceived.
        {
          $lookup: {
            from: 'gifts',
            let: { uid: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$recipientId', '$$uid'] },
                      {
                        $or: [
                          { $eq: ['$visibility', 'visible'] },
                          { $in: ['$status', ['fulfilled', 'completed']] },
                        ],
                      },
                    ],
                  },
                },
              },
              { $count: 'received' },
            ],
            as: 'giftsReceivedAgg',
          },
        },
        {
          $project: {
            _id: 0,
            userName: { $ifNull: ['$name', null] },
            displayName: { $ifNull: ['$profile.displayName', null] },
            photoUrl: { $ifNull: ['$profile.photoUrl', null] },
            onboardingCompletedAt: { $ifNull: ['$profile.onboardingCompletedAt', null] },
            dateOfBirth: { $ifNull: ['$profile.dateOfBirth', null] },
            interests: { $ifNull: ['$profile.preferences.interests', []] },
            giftCategories: { $ifNull: ['$profile.preferences.giftCategories', []] },
            favouriteColors: { $ifNull: ['$profile.preferences.favouriteColors', []] },
            clothingSize: { $ifNull: ['$profile.preferences.clothingSize', null] },
            giftsGiven: { $ifNull: [{ $arrayElemAt: ['$giftsGivenAgg.given', 0] }, 0] },
            giftsOnHold: { $ifNull: [{ $arrayElemAt: ['$giftsGivenAgg.onHold', 0] }, 0] },
            giftsReceived: { $ifNull: [{ $arrayElemAt: ['$giftsReceivedAgg.received', 0] }, 0] },
          },
        },
      ])
      .exec();

    const row = rows[0];
    if (!row) throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    return row;
  }

  private static scoreCompleteness(row: AggregatedRow): {
    completeness: number;
    missingFields: string[];
  } {
    const filled = (field: (typeof COMPLETENESS_FIELDS)[number]): boolean => {
      const value =
        field === 'displayName' ? (row.displayName ?? row.userName) : (row[field] as unknown);
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined && value !== '';
    };

    const missingFields = COMPLETENESS_FIELDS.filter((f) => !filled(f));
    const completeness = Math.round(
      ((COMPLETENESS_FIELDS.length - missingFields.length) / COMPLETENESS_FIELDS.length) * 100,
    );
    return { completeness, missingFields: [...missingFields] };
  }
}
