import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';

/** Per-collection ceiling — generous for MVP scale, bounded so one export cannot OOM. */
const EXPORT_CAP = 5_000;

/** Fields never included in an export (secrets / internal auth state). */
const USER_REDACT = ['passwordHash', 'tokensInvalidBefore', '__v'] as const;

export interface UserDataExport {
  meta: { userId: string; exportedAt: string; truncatedSections: string[] };
  account: Record<string, unknown> | null;
  profile: Record<string, unknown> | null;
  wishlists: unknown[];
  wishlistItems: unknown[];
  wishlistParticipations: unknown[];
  eventsHosted: unknown[];
  eventInvites: unknown[];
  giftsGiven: unknown[];
  giftsReceived: unknown[];
  groupGiftsInitiated: unknown[];
  contributions: unknown[];
  reelsInitiated: unknown[];
  wishesAuthored: unknown[];
  chatMessages: unknown[];
  notifications: unknown[];
  analyticsEvents: unknown[];
  reportsFiled: unknown[];
}

/**
 * Assembles a GDPR-style "everything we hold about you" export for the
 * authenticated user, in one pass across every domain collection.
 *
 * It reads the raw collections (not the domain services) on purpose: a data
 * export must reflect exactly what is stored, not a service's curated view, and
 * a new field added to a schema should appear here automatically rather than
 * silently going unexported. Only the caller's own rows are returned — every
 * query is filtered by their id on that collection's owner field — and the user
 * document is redacted of secrets.
 */
@Injectable()
export class DataExportService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async exportForUser(userId: string, exportedAt: Date): Promise<UserDataExport> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    }
    const uid = new Types.ObjectId(userId);
    const truncated: string[] = [];

    // Read a collection filtered to this user, tracking whether the cap clipped it.
    const gather = async (
      section: string,
      collection: string,
      filter: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      const rows = await this.connection
        .collection<Record<string, unknown>>(collection)
        .find(filter)
        .limit(EXPORT_CAP + 1)
        .toArray();
      if (rows.length > EXPORT_CAP) {
        truncated.push(section);
        rows.length = EXPORT_CAP;
      }
      return rows;
    };

    const [
      userRows,
      profileRows,
      wishlists,
      wishlistItems,
      wishlistParticipations,
      eventsHosted,
      eventInvites,
      giftsGiven,
      giftsReceived,
      groupGiftsInitiated,
      contributions,
      reelsInitiated,
      wishesAuthored,
      chatMessages,
      notifications,
      analyticsEvents,
      reportsFiled,
    ] = await Promise.all([
      gather('account', 'users', { _id: uid }),
      gather('profile', 'user_profiles', { userId: uid }),
      gather('wishlists', 'wishlists', { ownerId: uid }),
      gather('wishlistItems', 'wishlist_items', { ownerId: uid }),
      gather('wishlistParticipations', 'wishlist_participants', { userId: uid }),
      gather('eventsHosted', 'events', { hostId: uid }),
      gather('eventInvites', 'event_invites', { invitedUserId: uid }),
      gather('giftsGiven', 'gifts', { gifterId: uid }),
      gather('giftsReceived', 'gifts', { recipientId: uid }),
      gather('groupGiftsInitiated', 'group_gifts', { initiatorId: uid }),
      gather('contributions', 'contributions', { userId: uid }),
      gather('reelsInitiated', 'reel_collections', { initiatorId: uid }),
      gather('wishesAuthored', 'wishes', { authorId: uid }),
      gather('chatMessages', 'messages', { senderId: uid }),
      gather('notifications', 'notifications', { userId: uid }),
      gather('analyticsEvents', 'analytics_events', { userId: uid }),
      gather('reportsFiled', 'reports', { reporterId: uid }),
    ]);

    const account = userRows[0] ?? null;
    if (account) for (const field of USER_REDACT) delete account[field];

    return {
      meta: { userId, exportedAt: exportedAt.toISOString(), truncatedSections: truncated },
      account,
      profile: profileRows[0] ?? null,
      wishlists,
      wishlistItems,
      wishlistParticipations,
      eventsHosted,
      eventInvites,
      giftsGiven,
      giftsReceived,
      groupGiftsInitiated,
      contributions,
      reelsInitiated,
      wishesAuthored,
      chatMessages,
      notifications,
      analyticsEvents,
      reportsFiled,
    };
  }
}
