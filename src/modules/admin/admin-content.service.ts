import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { customAlphabet } from 'nanoid';
import { Connection, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { EventStatus } from 'src/modules/events/event.types';
import { EventsService } from 'src/modules/events/events.service';
import { InvitePreviewService } from 'src/modules/events/invite-preview.service';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { MediaService } from 'src/modules/media/media.service';
import { MemoriesService } from 'src/modules/memories/memories.service';
import { ModerationStatus, ReelStatus } from 'src/modules/reels/reel.types';
import { WishlistItemStatus, WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import type { AdminPage } from './admin-query.util';
import {
  at,
  id,
  ids,
  listAll,
  listPage,
  loadDoc,
  loadSection,
  num,
  oid,
  refsIn,
  str,
  toCsv,
  yesNo,
  type Doc,
  type ExplorerRow,
  type ListSpec,
  type SectionSpec,
} from './admin-explorer.util';
import {
  AdminTakedownService,
  type RemovalView,
  type TakedownKind,
} from './admin-takedown.service';
import { AdminUser360Service, maskValue } from './admin-user360.service';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

/** The content areas, as they appear in URLs. */
export const CONTENT_KINDS = [
  'wishlists',
  'items',
  'events',
  'memories',
  'reels',
  'chats',
  'thank-you',
  'media',
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Every filter any list understands; each kind reads the ones it has. */
export interface ContentQuery {
  q?: string;
  status?: string;
  owner?: string;
  from?: string;
  to?: string;
  visibility?: string;
  type?: string;
  archived?: 'yes' | 'no';
  hasEvent?: 'yes' | 'no';
  hasGift?: 'yes' | 'no';
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  /** Bytes, for media. */
  minSize?: number;
  maxSize?: number;
  purpose?: string;
  kind?: string;
  refId?: string;
  participant?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export type ContentRow = ExplorerRow;

export interface ContentListPage extends AdminPage<ContentRow> {
  /** Display names for every user id the rows mention. */
  names: Record<string, string>;
}

export interface ContentSection {
  key: string;
  title: string;
  items: ContentRow[];
  total: number;
  /** True when the rows' private parts were held back pending a reveal. */
  locked?: boolean;
  page?: number;
  limit?: number;
}

export interface ContentDetail {
  kind: ContentKind;
  id: string;
  row: ContentRow;
  fields: Record<string, unknown>;
  sections: ContentSection[];
  /** Private parts were withheld; a reveal with a reason shows them. */
  locked: boolean;
  /** Set once revealed, so the panel can say it was. */
  revealed: boolean;
  removal: RemovalView | null;
  names: Record<string, string>;
  raw?: Doc;
}

/** The actions each kind offers, and what each needs besides a reason. */
export const CONTENT_ACTIONS: Record<ContentKind, string[]> = {
  wishlists: ['archive', 'unarchive', 'rotate-share', 'remove-item'],
  items: ['hide', 'unhide', 'reset-status'],
  events: ['cancel', 'unpublish', 'remove-cover', 'remove-invite-media'],
  memories: ['unlock', 'relock', 'remove-wish', 'remove-reply'],
  reels: ['approve-wish', 'reject-wish', 'recompile', 'release-now'],
  chats: ['delete-message', 'restore-message'],
  'thank-you': ['remove'],
  media: ['remove', 'delete-now', 'retry-processing'],
};

export interface ContentActionInput {
  reason: string;
  itemId?: string;
  wishId?: string;
  replyId?: string;
  messageId?: string;
  unlockAt?: string;
}

const PRIVATE_MEDIA = new Set<string>([
  MediaPurpose.MEMORY_WISH,
  MediaPurpose.MEMORY_REPLY,
  MediaPurpose.THANK_YOU,
]);

const generateSlug = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 16);

/** A content list: a [ListSpec], and the takedown kind its records are. */
interface KindSpec extends ListSpec<ContentQuery> {
  takedown: TakedownKind | null;
}

const SPECS: Record<ContentKind, KindSpec> = {
  wishlists: {
    collection: 'wishlists',
    takedown: 'wishlist',
    search: ['title', 'occasionLabel', 'forName', 'share.slug'],
    owner: 'ownerId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt', updated: 'updatedAt', items: 'stats.itemCount', title: 'title' },
    filter: (q) => ({
      ...(q.visibility ? { visibility: q.visibility } : {}),
      ...yesNo(q.archived, 'archivedAt'),
      ...yesNo(q.hasEvent, 'eventId'),
      ...(q.type === 'for-name' ? { forName: { $ne: null } } : {}),
      ...(q.type === 'for-user' ? { forUserId: { $ne: null } } : {}),
      ...(q.type === 'own' ? { forName: null, forUserId: null } : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      title: d.title,
      ownerId: id(d.ownerId),
      visibility: d.visibility,
      occasion: str(d.occasionLabel),
      forName: str(d.forName),
      forUserId: id(d.forUserId),
      eventId: id(d.eventId),
      items: (d.stats as { itemCount?: number } | undefined)?.itemCount ?? 0,
      fulfilled: (d.stats as { fulfilledCount?: number } | undefined)?.fulfilledCount ?? 0,
      archivedAt: at(d.archivedAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['ownerId', 'forUserId'],
  },
  items: {
    collection: 'wishlist_items',
    takedown: 'item',
    search: ['title', 'category'],
    owner: 'ownerId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt', price: 'price.amountMinor', title: 'title' },
    filter: (q) => {
      const price: Doc = {};
      if (q.minPrice !== undefined) price.$gte = q.minPrice;
      if (q.maxPrice !== undefined) price.$lte = q.maxPrice;
      return {
        ...(q.status ? { status: q.status } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(Object.keys(price).length ? { 'price.amountMinor': price } : {}),
        ...yesNo(q.hasGift, 'activeGiftId'),
        ...yesNo(q.archived, 'archivedAt'),
      };
    },
    row: (d) => ({
      id: id(d._id)!,
      title: d.title,
      wishlistId: id(d.wishlistId),
      ownerId: id(d.ownerId),
      status: d.status,
      category: str(d.category),
      amountMinor: num((d.price as { amountMinor?: unknown } | undefined)?.amountMinor),
      currency: (d.price as { currency?: string } | undefined)?.currency ?? 'INR',
      imageUrl: Array.isArray(d.imageUrls) ? (str(d.imageUrls[0]) ?? null) : null,
      activeGiftId: id(d.activeGiftId),
      alert: alertOf(d),
      archivedAt: at(d.archivedAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['ownerId'],
  },
  events: {
    collection: 'events',
    takedown: 'event',
    search: ['title', 'personName', 'venue', 'shareSlug'],
    owner: 'hostId',
    dateField: 'startsAt',
    sorts: { starts: 'startsAt', created: 'createdAt', title: 'title' },
    filter: (q) => ({
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.visibility ? { visibility: q.visibility } : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      title: d.title,
      hostId: id(d.hostId),
      type: d.type,
      status: d.status,
      visibility: d.visibility,
      startsAt: at(d.startsAt),
      personName: str(d.personName),
      wishlists: Array.isArray(d.wishlistIds) ? d.wishlistIds.length : 0,
      createdAt: at(d.createdAt),
    }),
    userRefs: ['hostId'],
  },
  memories: {
    collection: 'memory_capsules',
    takedown: null,
    search: ['title', 'personName', 'occasion'],
    owner: 'hostId',
    dateField: 'unlockAt',
    sorts: { unlock: 'unlockAt', created: 'createdAt', wishes: 'wishCount' },
    filter: (q) => ({ ...(q.status ? { status: q.status } : {}) }),
    row: (d) => ({
      id: id(d._id)!,
      title: d.title,
      hostId: id(d.hostId),
      recipientUserId: id(d.recipientUserId),
      personName: str(d.personName),
      occasion: str(d.occasion),
      status: d.status,
      unlockAt: at(d.unlockAt),
      unlockedAt: at(d.unlockedAt),
      wishes: num(d.wishCount) ?? 0,
      createdAt: at(d.createdAt),
    }),
    userRefs: ['hostId', 'recipientUserId'],
  },
  reels: {
    collection: 'reel_collections',
    takedown: 'reel',
    search: ['title'],
    owner: 'initiatorId',
    dateField: 'releaseAt',
    sorts: { release: 'releaseAt', created: 'createdAt', wishes: 'wishCount' },
    filter: (q) => ({ ...(q.status ? { status: q.status } : {}) }),
    row: (d) => ({
      id: id(d._id)!,
      title: d.title,
      initiatorId: id(d.initiatorId),
      recipientUserId: id(d.recipientUserId),
      status: d.status,
      releaseAt: at(d.releaseAt),
      wishes: num(d.wishCount) ?? 0,
      compileAttempts: num(d.compileAttempts) ?? 0,
      failureReason: str(d.failureReason),
      hasVideo: Boolean(d.reelMediaUrl),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['initiatorId', 'recipientUserId'],
  },
  chats: {
    collection: 'chats',
    takedown: null,
    search: [],
    owner: 'participantIds',
    dateField: 'lastMessageAt',
    sorts: { last: 'lastMessageAt', created: 'createdAt' },
    filter: (q) => ({
      ...(q.type ? { type: q.type } : {}),
      ...(q.refId && oid(q.refId) ? { refId: oid(q.refId) } : {}),
      ...(q.participant && oid(q.participant) ? { participantIds: oid(q.participant) } : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      type: d.type,
      refId: id(d.refId),
      participants: Array.isArray(d.participantIds) ? d.participantIds.length : 0,
      participantIds: ids(d.participantIds).slice(0, 4),
      lastMessageAt: at(d.lastMessageAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['participantIds'],
  },
  'thank-you': {
    collection: 'thank_you_notes',
    takedown: 'thank_you',
    search: ['context.gifterName', 'context.recipientName', 'context.itemTitle'],
    owner: 'recipientId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt', sent: 'sentAt' },
    filter: (q) => ({
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    }),
    // The words are private between two people; the list never carries them.
    row: (d) => ({
      id: id(d._id)!,
      recipientId: id(d.recipientId),
      gifterId: id(d.gifterId),
      itemTitle: str((d.context as { itemTitle?: unknown } | undefined)?.itemTitle),
      kind: d.kind,
      status: d.status,
      scheduledFor: at(d.scheduledFor),
      sentAt: at(d.sentAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['recipientId', 'gifterId'],
  },
  media: {
    collection: 'media',
    takedown: 'media',
    search: ['storageKey', 'contentType'],
    owner: 'ownerId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt', size: 'sizeBytes' },
    filter: (q) => ({
      ...(q.status ? { status: q.status } : {}),
      ...(q.purpose ? { purpose: q.purpose } : {}),
      ...(q.minSize !== undefined || q.maxSize !== undefined
        ? {
            sizeBytes: {
              ...(q.minSize !== undefined ? { $gte: q.minSize } : {}),
              ...(q.maxSize !== undefined ? { $lte: q.maxSize } : {}),
            },
          }
        : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      ownerId: id(d.ownerId),
      purpose: d.purpose,
      status: d.status,
      contentType: str(d.contentType) ?? str(d.declaredContentType),
      sizeBytes: num(d.sizeBytes) ?? num(d.declaredSizeBytes),
      durationSeconds: num(d.durationSeconds),
      // A private file's address is never in a list.
      url: PRIVATE_MEDIA.has(String(d.purpose)) ? null : str(d.url),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['ownerId'],
  },
};

const isPrivateList = (d: Doc): boolean => d.visibility === WishlistVisibility.PRIVATE;

/** What a person sent — words and a file — only when it may be shown. */
const sent = (r: Doc, show: boolean): Record<string, unknown> =>
  show
    ? { text: str(r.text), mediaUrl: str(r.mediaUrl), contentType: str(r.contentType) }
    : { text: null, mediaUrl: null, contentType: str(r.contentType) };

/** The price alert on an item, when there is anything to say. */
function alertOf(d: Doc): Record<string, unknown> | null {
  const a = d.sourceAlert as Doc | null | undefined;
  if (!a) return null;
  const current = num(a.currentAmountMinor);
  const was = num((d.price as Doc | undefined)?.amountMinor);
  if (a.outOfStock !== true && (current === null || current === was)) return null;
  return {
    outOfStock: a.outOfStock === true,
    currentAmountMinor: current,
    wasAmountMinor: was,
    changedAt: at(a.priceChangedAt),
  };
}

const SECTIONS: Record<ContentKind, Record<string, SectionSpec>> = {
  wishlists: {
    items: {
      title: 'Items',
      collection: 'wishlist_items',
      filter: (p) => ({ wishlistId: p._id as Types.ObjectId }),
      sort: { position: 1 },
      view: (r, show) => ({
        ...SPECS.items.row(r),
        ...(show ? {} : { title: null, imageUrl: null }),
      }),
      locked: isPrivateList,
      userRefs: [],
    },
    participants: {
      title: 'People it is shared with',
      collection: 'wishlist_participants',
      filter: (p) => ({ wishlistId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        userId: id(r.userId),
        role: str(r.role),
        state: str(r.state),
        invitedBy: id(r.invitedBy),
        acceptedAt: at(r.acceptedAt),
        revokedAt: at(r.revokedAt),
      }),
      userRefs: ['userId', 'invitedBy'],
    },
    submissions: {
      title: 'Event submissions',
      collection: 'event_wishlist_submissions',
      filter: (p) => ({ wishlistId: p._id as Types.ObjectId }),
      view: (r) => submissionRow(r),
      userRefs: ['requestedById'],
    },
  },
  items: {
    gifts: {
      title: 'Gift history',
      collection: 'gifts',
      filter: (p) => ({ itemId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        status: str(r.status),
        type: str(r.type),
        mode: str(r.mode),
        gifterId: id(r.gifterId),
        amountMinor: num(r.amountMinor),
        active: r.active === true,
        expiresAt: at(r.expiresAt),
        createdAt: at(r.createdAt),
      }),
      userRefs: ['gifterId'],
    },
  },
  events: {
    invites: {
      title: 'Invites',
      collection: 'event_invites',
      filter: (p) => ({ eventId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        invitedUserId: id(r.invitedUserId),
        invitedPhone: r.invitedPhone ? maskValue(String(r.invitedPhone)) : null,
        rsvp: str(r.rsvp),
        plusOnes: num(r.plusOnes) ?? 0,
        respondedAt: at(r.respondedAt),
        revokedAt: at(r.revokedAt),
        createdAt: at(r.createdAt),
      }),
      userRefs: ['invitedUserId'],
    },
    'join-requests': {
      title: 'Asked to join',
      collection: 'event_join_requests',
      filter: (p) => ({ eventId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        userId: id(r.userId),
        status: str(r.status),
        decidedAt: at(r.decidedAt),
        createdAt: at(r.createdAt),
      }),
      userRefs: ['userId'],
    },
    submissions: {
      title: 'Wishlists offered',
      collection: 'event_wishlist_submissions',
      filter: (p) => ({ eventId: p._id as Types.ObjectId }),
      view: (r) => submissionRow(r),
      userRefs: ['requestedById'],
    },
    wishlists: {
      title: 'Connected wishlists',
      collection: 'wishlists',
      filter: (p) => ({ _id: { $in: (p.wishlistIds ?? []) as Types.ObjectId[] } }),
      view: (r) => SPECS.wishlists.row(r),
      userRefs: ['ownerId'],
    },
    memories: {
      title: 'Memories',
      collection: 'memory_capsules',
      filter: (p) => ({ eventId: p._id as Types.ObjectId }),
      view: (r) => SPECS.memories.row(r),
      userRefs: ['hostId'],
    },
    'group-gifts': {
      title: 'Group gifts',
      collection: 'group_gifts',
      filter: (p) => ({ eventId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        title: str(r.title),
        status: str(r.status),
        initiatorId: id(r.initiatorId),
        targetAmountMinor: num(r.targetAmountMinor),
        collectedAmountMinor: num(r.collectedAmountMinor) ?? 0,
        createdAt: at(r.createdAt),
      }),
      userRefs: ['initiatorId'],
    },
  },
  memories: {
    wishes: {
      title: 'Wishes',
      collection: 'memory_wishes',
      filter: (p) => ({ capsuleId: p._id as Types.ObjectId }),
      sort: { order: 1, createdAt: 1 },
      view: (r, show) => ({
        id: id(r._id)!,
        contributorId: id(r.contributorId),
        contributorName: str(r.contributorName),
        kind: str(r.kind),
        ...sent(r, show),
        durationMs: num(r.durationMs),
        reactions: num(r.reactionCount) ?? 0,
        createdAt: at(r.createdAt),
      }),
      locked: () => true,
      userRefs: ['contributorId'],
    },
    replies: {
      title: 'Replies',
      collection: 'memory_replies',
      filter: (p) => ({ capsuleIds: p._id as Types.ObjectId }),
      view: (r, show) => ({
        id: id(r._id)!,
        authorId: id(r.authorId),
        authorName: str(r.authorName),
        kind: str(r.kind),
        ...sent(r, show),
        createdAt: at(r.createdAt),
      }),
      locked: () => true,
      userRefs: ['authorId'],
    },
  },
  reels: {
    wishes: {
      title: 'Wishes',
      collection: 'wishes',
      filter: (p) => ({ collectionId: p._id as Types.ObjectId }),
      sort: { order: 1 },
      view: (r) => ({
        id: id(r._id)!,
        authorId: id(r.authorId),
        authorName: str(r.authorName),
        kind: str(r.kind),
        text: str(r.text),
        mediaUrl: null,
        contentType: str(r.contentType),
        durationMs: num(r.durationMs),
        moderationStatus: str(r.moderationStatus),
        createdAt: at(r.createdAt),
      }),
      // A reel wish keeps its file by id; its address lives on the media row.
      enrich: async (db, docs, rows) => {
        const mediaIds = docs
          .map((w) => w.mediaId as Types.ObjectId | null)
          .filter((x): x is Types.ObjectId => !!x);
        if (mediaIds.length === 0) return rows;
        const media = await db
          .collection('media')
          .find({ _id: { $in: mediaIds } })
          .project({ url: 1 })
          .toArray();
        const urlOf = new Map(media.map((m) => [String(m._id), str(m.url)]));
        return rows.map((row, i) => ({
          ...row,
          mediaUrl: docs[i].mediaId ? (urlOf.get(String(docs[i].mediaId)) ?? null) : null,
        }));
      },
      userRefs: ['authorId'],
    },
  },
  chats: {
    messages: {
      title: 'Messages',
      collection: 'messages',
      filter: (p) => ({ chatId: p._id as Types.ObjectId }),
      sort: { _id: -1 },
      pageSize: 50,
      view: (r, show) => ({
        id: id(r._id)!,
        senderId: id(r.senderId),
        kind: str(r.kind),
        body: show ? str(r.body) : null,
        systemType: str(r.systemType),
        attachments:
          show && Array.isArray(r.attachments)
            ? (r.attachments as Doc[]).map((a) => ({
                url: str(a.url),
                contentType: str(a.contentType),
              }))
            : Array.isArray(r.attachments)
              ? r.attachments.length
              : 0,
        editedAt: at(r.editedAt),
        deletedAt: at(r.deletedAt),
        createdAt: at(r.createdAt),
      }),
      locked: () => true,
      userRefs: ['senderId'],
    },
  },
  'thank-you': {},
  media: {
    references: {
      title: 'Used by',
      load: (db, parent) => mediaReferences(db, parent._id as Types.ObjectId),
      userRefs: [],
    },
  },
};

/** Filters whose choices come from the data (distinct values). */
const FACETS: Partial<Record<ContentKind, string[]>> = {
  items: ['category'],
};

function submissionRow(r: Doc): ContentRow {
  return {
    id: id(r._id)!,
    eventId: id(r.eventId),
    wishlistId: id(r.wishlistId),
    requestedById: id(r.requestedById),
    status: str(r.status),
    respondedAt: at(r.respondedAt),
    createdAt: at(r.createdAt),
  };
}

/** Where one file is used, across everything that can hold one. */
async function mediaReferences(db: mongo.Db, mediaId: Types.ObjectId): Promise<ContentRow[]> {
  const where: [string, string, string, Doc, (d: Doc) => string][] = [
    ['wishlists', 'wishlists', 'Wishlist cover', { coverMediaId: mediaId }, (d) => String(d.title)],
    ['wishlist_items', 'items', 'Wishlist item', { mediaIds: mediaId }, (d) => String(d.title)],
    ['events', 'events', 'Event cover', { coverMediaId: mediaId }, (d) => String(d.title)],
    ['events', 'events', 'Event invitation', { inviteMediaId: mediaId }, (d) => String(d.title)],
    [
      'memory_capsules',
      'memories',
      'Memory cover',
      { coverMediaId: mediaId },
      (d) => String(d.title),
    ],
    ['memory_wishes', '', 'Memory wish', { mediaId }, (d) => String(d.contributorName ?? 'Wish')],
    ['memory_replies', '', 'Memory reply', { mediaId }, (d) => String(d.authorName ?? 'Reply')],
    ['wishes', '', 'Reel wish', { mediaId }, (d) => String(d.authorName ?? 'Wish')],
    ['thank_you_notes', 'thank-you', 'Thank-you note', { mediaId }, () => 'Thank-you note'],
    ['messages', '', 'Chat attachment', { 'attachments.mediaId': mediaId }, () => 'Message'],
    [
      'user_profiles',
      '',
      'Profile photo',
      { photoMediaId: mediaId },
      (d) => String(d.displayName ?? 'Profile'),
    ],
  ];
  const found = await Promise.all(
    where.map(async ([collection, area, label, filter, name]) =>
      (await db.collection(collection).find(filter).limit(10).toArray()).map((d) => ({
        id: id(d._id)!,
        area: area || null,
        // A reel wish, memory wish or chat message opens on its parent's page.
        parentId:
          collection === 'wishes'
            ? id(d.collectionId)
            : collection === 'memory_wishes'
              ? id(d.capsuleId)
              : collection === 'messages'
                ? id(d.chatId)
                : collection === 'user_profiles'
                  ? id(d.userId)
                  : null,
        parentArea:
          collection === 'wishes'
            ? 'reels'
            : collection === 'memory_wishes'
              ? 'memories'
              : collection === 'messages'
                ? 'chats'
                : collection === 'user_profiles'
                  ? 'user'
                  : null,
        label,
        name: name(d),
      })),
    ),
  );
  return found.flat();
}

/**
 * The content explorer: every wishlist, item, event, memory, reel, chat,
 * thank-you note and uploaded file — listed, opened with what hangs off it,
 * and acted on.
 *
 * Private things (chat messages, memory wishes and replies, thank-you notes,
 * private wishlists and their items, private files) are held back until an
 * admin with `sensitive:view` reveals them with a reason, and every reveal is
 * audited.
 */
@Injectable()
export class AdminContentService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    private readonly user360: AdminUser360Service,
    private readonly takedown: AdminTakedownService,
    private readonly wishlists: WishlistsService,
    private readonly memories: MemoriesService,
    private readonly media: MediaService,
    private readonly events: EventsService,
    private readonly invites: InvitePreviewService,
    private readonly audit: AuditService,
  ) {}

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  // ── Lists ──────────────────────────────────────────────────────────────────

  async list(kind: ContentKind, q: ContentQuery): Promise<ContentListPage> {
    const spec = SPECS[kind];
    const page = await listPage(this.db, spec, q);
    let items = page.items;
    if (kind === 'items') items = await this.maskPrivateItems(items);
    return { ...page, items, names: await this.namesOf(items, spec.userRefs) };
  }

  /** Titles of items on private lists are withheld from the list. */
  private async maskPrivateItems(rows: ContentRow[]): Promise<ContentRow[]> {
    const listIds = [...new Set(rows.map((r) => r.wishlistId).filter((x): x is string => !!x))];
    const lists = await this.db
      .collection('wishlists')
      .find({ _id: { $in: listIds.map((x) => new Types.ObjectId(x)) } })
      .project({ title: 1, visibility: 1 })
      .toArray();
    const byId = new Map(lists.map((l) => [String(l._id), l]));
    return rows.map((r) => {
      const list = byId.get(String(r.wishlistId));
      const isPrivate = list?.visibility === WishlistVisibility.PRIVATE;
      return {
        ...r,
        wishlistTitle: str(list?.title),
        private: isPrivate,
        ...(isPrivate ? { title: null, imageUrl: null } : {}),
      };
    });
  }

  /** The whole list as CSV rows (up to 50,000) — same filters, private parts left out. */
  async exportRows(
    kind: ContentKind,
    q: ContentQuery,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<string> {
    let rows = await listAll(this.db, SPECS[kind], q);
    if (kind === 'items') rows = await this.maskPrivateItems(rows);
    await this.audit.record({
      actor,
      action: 'content.export',
      targetType: kind,
      targetId: null,
      meta: { rows: rows.length, filters: q },
      ip,
    });
    return toCsv(rows);
  }

  // ── Detail ─────────────────────────────────────────────────────────────────

  /**
   * One thing with what hangs off it: its own fields, and the first page of
   * each section. With [reveal] (a reason) and the permission, private parts
   * are included and the look is audited.
   */
  async detail(
    kind: ContentKind,
    rowId: string,
    admin: AuthenticatedAdmin,
    reveal?: { reason: string; ip: string | null },
  ): Promise<ContentDetail> {
    const spec = SPECS[kind];
    const doc = await loadDoc(this.db, spec.collection, rowId);
    this.assertCanReveal(admin, reveal);
    const open = Boolean(reveal);

    const fields = await this.fieldsOf(kind, doc, open);
    const sectionSpecs = Object.entries(SECTIONS[kind]);
    const sections = await Promise.all(
      sectionSpecs.map(([key, s]) => loadSection(this.db, key, s, doc, open, 1)),
    );
    const locked = fields.locked || sections.some((s) => s.privateParts);

    let row = spec.row(doc);
    if (kind === 'items') {
      const [masked] = await this.maskPrivateItems([row]);
      row = open
        ? { ...row, wishlistTitle: masked.wishlistTitle, private: masked.private }
        : masked;
    }
    if (locked && open) await this.auditReveal(admin, kind, rowId, reveal!, null);

    const refs = [
      ...refsIn([row], spec.userRefs),
      ...sections.flatMap((s) =>
        refsIn(s.items, sectionSpecs.find(([k]) => k === s.key)![1].userRefs),
      ),
      ...fields.userIds,
    ];
    const removal = spec.takedown ? await this.takedown.activeFor(spec.takedown, rowId) : null;
    return {
      kind,
      id: rowId,
      row,
      fields: fields.values,
      sections: sections.map(({ privateParts, ...s }) => ({ ...s, locked: privateParts && !open })),
      locked: locked && !open,
      revealed: locked && open,
      removal,
      names: await this.user360.namesFor([...new Set(refs)]),
      ...(admin.permissions.includes(AdminPermission.DEBUG_VIEW) && (open || !locked)
        ? { raw: doc }
        : {}),
    };
  }

  /** One more page of one section — revealed when a reason comes with it. */
  async section(
    kind: ContentKind,
    rowId: string,
    key: string,
    page: number,
    admin: AuthenticatedAdmin,
    reveal?: { reason: string; ip: string | null },
  ): Promise<ContentSection & { page: number; limit: number; names: Record<string, string> }> {
    const spec = SECTIONS[kind][key];
    if (!spec) throw new AppException(ErrorCode.NOT_FOUND, 'No such section', 404);
    const doc = await loadDoc(this.db, SPECS[kind].collection, rowId);
    this.assertCanReveal(admin, reveal);
    const open = Boolean(reveal);
    const s = await loadSection(this.db, key, spec, doc, open, Math.max(1, page));
    if (s.privateParts && open)
      await this.auditReveal(admin, kind, rowId, reveal!, { section: key, page });
    const { privateParts, ...rest } = s;
    return {
      ...rest,
      locked: privateParts && !open,
      names: await this.user360.namesFor([...new Set(refsIn(s.items, spec.userRefs))]),
    };
  }

  /** Distinct values of a field, for a filter's choices. */
  async facets(kind: ContentKind, field: string): Promise<string[]> {
    if (!FACETS[kind]?.includes(field)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such filter', 404);
    }
    const values = await this.db.collection(SPECS[kind].collection).distinct(field);
    return values
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 200);
  }

  private assertCanReveal(admin: AuthenticatedAdmin, reveal?: unknown): void {
    if (reveal && !admin.permissions.includes(AdminPermission.SENSITIVE_VIEW)) {
      throw new AppException(
        ErrorCode.ADMIN_FORBIDDEN,
        'Revealing private content needs sensitive:view',
        403,
      );
    }
  }

  private auditReveal(
    admin: AuthenticatedAdmin,
    kind: ContentKind,
    rowId: string,
    reveal: { reason: string; ip: string | null },
    extra: Record<string, unknown> | null,
  ): Promise<void> {
    return this.audit.record({
      actor: admin,
      action: 'content.reveal',
      targetType: kind,
      targetId: rowId,
      meta: { reason: reveal.reason, ...(extra ?? {}) },
      ip: reveal.ip,
    });
  }

  /** A record's own fields — what is not a list of other things. */
  private async fieldsOf(
    kind: ContentKind,
    d: Doc,
    open: boolean,
  ): Promise<{ values: Record<string, unknown>; locked: boolean; userIds: string[] }> {
    const _id = d._id as Types.ObjectId;
    switch (kind) {
      case 'wishlists': {
        const isPrivate = d.visibility === WishlistVisibility.PRIVATE;
        const show = !isPrivate || open;
        const share = (d.share ?? {}) as Doc;
        const [chat, event] = await Promise.all([
          this.chatSummary('wishlist', _id),
          d.eventId
            ? this.db.collection('events').findOne({ _id: d.eventId as Types.ObjectId })
            : null,
        ]);
        return {
          values: {
            description: show ? str(d.description) : null,
            coverUrl: show ? str(d.coverUrl) : null,
            chatEnabled: d.chatEnabled === true,
            deliveryAddressSet: d.addressId != null,
            share: {
              slug: str(share.slug),
              hasPasscode: Boolean(share.passcodeHash),
              expiresAt: at(share.expiresAt),
              rotatedAt: at(share.rotatedAt),
            },
            event: event ? SPECS.events.row(event) : null,
            chat,
          },
          locked: isPrivate,
          userIds: event ? [String(event.hostId)] : [],
        };
      }

      case 'items': {
        const list = await this.db
          .collection('wishlists')
          .findOne({ _id: d.wishlistId as Types.ObjectId });
        const isPrivate = list?.visibility === WishlistVisibility.PRIVATE;
        const show = !isPrivate || open;
        const product = d.sourceProductId
          ? await this.db
              .collection('products')
              .findOne({ _id: d.sourceProductId as Types.ObjectId })
          : null;
        return {
          values: {
            notes: show ? str(d.notes) : null,
            productLink: show ? str(d.productLink) : null,
            recipientName: show ? str(d.recipientName) : null,
            importance: str(d.importance),
            quantity: num(d.quantity),
            priority: num(d.priority),
            price: d.price ?? null,
            giftPreferences: show ? (d.giftPreferences ?? null) : null,
            priceAlert: alertOf(d),
            images: show && Array.isArray(d.imageUrls) ? d.imageUrls : [],
            product: product
              ? {
                  id: id(product._id),
                  title: str(product.title),
                  merchant: str(product.merchant),
                  provider: str(product.provider),
                  amountMinor: num(product.amountMinor),
                  productUrl: str(product.productUrl),
                  updatedAt: at(product.updatedAt),
                }
              : null,
          },
          locked: isPrivate,
          userIds: [],
        };
      }

      case 'events': {
        const [rsvp, reel, invite] = await Promise.all([
          this.db
            .collection('event_invites')
            .aggregate<{ _id: string; n: number }>([
              { $match: { eventId: _id, revokedAt: null } },
              { $group: { _id: '$rsvp', n: { $sum: 1 } } },
            ])
            .toArray(),
          d.reelCollectionId
            ? this.db
                .collection('reel_collections')
                .findOne({ _id: d.reelCollectionId as Types.ObjectId })
            : null,
          this.invitePreview(_id),
        ]);
        return {
          values: {
            description: str(d.description),
            venue: str(d.venue),
            timezone: str(d.timezone),
            endsAt: at(d.endsAt),
            relation: str(d.relation),
            forSelf: d.forSelf === true,
            coverUrl: str(d.coverUrl),
            inviteMediaUrl: str(d.inviteMediaUrl),
            invitation: invite,
            shareSlug: str(d.shareSlug),
            publishedAt: at(d.publishedAt),
            cancelledAt: at(d.cancelledAt),
            rsvp: Object.fromEntries(rsvp.map((r) => [r._id, r.n])),
            reel: reel ? SPECS.reels.row(reel) : null,
          },
          locked: false,
          userIds: [],
        };
      }

      case 'memories': {
        const share = (d.share ?? {}) as Doc;
        return {
          values: {
            relation: str(d.relation),
            occasionDate: at(d.occasionDate),
            timezone: str(d.timezone),
            eventId: id(d.eventId),
            coverUrl: str(d.coverUrl),
            shareSlug: str(share.slug),
            sharedWith: ids(d.sharedWith),
          },
          locked: false,
          userIds: ids(d.sharedWith),
        };
      }

      case 'reels': {
        const share = (d.share ?? {}) as Doc;
        return {
          values: {
            reelMediaUrl: str(d.reelMediaUrl),
            durationMs: num(d.durationMs),
            failureReason: str(d.failureReason),
            submissionDeadline: at(d.submissionDeadline),
            birthday: `${String(d.birthdayDay)}/${String(d.birthdayMonth)}`,
            eventId: id(d.eventId),
            shareSlug: str(share.slug),
            shareCount: num(d.shareCount) ?? 0,
            ogImageUrl: str(d.ogImageUrl),
          },
          locked: false,
          userIds: [],
        };
      }

      case 'chats':
        return {
          values: {
            participantIds: ids(d.participantIds),
            settings: d.settings ?? null,
            ref: await this.refOfChat(String(d.type), d.refId as Types.ObjectId),
          },
          locked: false,
          userIds: ids(d.participantIds),
        };

      case 'thank-you': {
        const ctx = (d.context ?? {}) as Doc;
        return {
          values: {
            giftId: id(d.giftId),
            gifterName: str(ctx.gifterName),
            recipientName: str(ctx.recipientName),
            itemTitle: str(ctx.itemTitle),
            eventTitle: str(ctx.eventTitle),
            subject: open ? str(d.subject) : null,
            body: open ? str(d.body) : null,
            mediaUrl: open ? str(d.mediaUrl) : null,
            editedAt: at(d.editedAt),
          },
          locked: true,
          userIds: [],
        };
      }

      case 'media': {
        const isPrivate = PRIVATE_MEDIA.has(String(d.purpose));
        const show = !isPrivate || open;
        return {
          values: {
            url: show ? str(d.url) : null,
            storageKey: str(d.storageKey),
            declaredContentType: str(d.declaredContentType),
            declaredSizeBytes: num(d.declaredSizeBytes),
            confirmedAt: at(d.confirmedAt),
            videoId: str(d.videoId),
            thumbnailFileName: str(d.thumbnailFileName),
            updatedAt: at(d.updatedAt),
          },
          locked: isPrivate,
          userIds: [],
        };
      }
    }
  }

  /** The invitation card as guests see it, drawn from the event's chosen design. */
  private async invitePreview(eventId: Types.ObjectId): Promise<Doc | null> {
    const event = await this.events.findOrFail(eventId.toString());
    if (!event.inviteTemplate) return null;
    try {
      const preview = await this.invites.build(event);
      return {
        imageUrl: preview.imageUrl,
        templateId: preview.templateId,
        colorVariant: preview.colorVariant,
        text: preview.resolved,
      };
    } catch {
      // A design the templates no longer know is shown as missing, not a 500.
      return {
        imageUrl: null,
        templateId: event.inviteTemplate.templateId,
        colorVariant: null,
        text: null,
      };
    }
  }

  /** What a chat belongs to — a wishlist, a group gift or a person. */
  private async refOfChat(type: string, refId: Types.ObjectId): Promise<Doc | null> {
    const collection =
      type === 'wishlist' ? 'wishlists' : type === 'group_gift' ? 'group_gifts' : null;
    if (!collection || !refId) return { type, id: id(refId) };
    const ref = await this.db
      .collection(collection)
      .findOne({ _id: refId }, { projection: { title: 1 } });
    return { type, id: id(refId), title: str(ref?.title) };
  }

  private async chatSummary(type: string, refId: Types.ObjectId): Promise<Doc | null> {
    const chat = await this.db.collection('chats').findOne({ type, refId });
    if (!chat) return null;
    const messages = await this.db.collection('messages').countDocuments({ chatId: chat._id });
    return { id: id(chat._id), messages, lastMessageAt: at(chat.lastMessageAt) };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async act(
    kind: ContentKind,
    rowId: string,
    action: string,
    input: ContentActionInput,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ ok: true; removal?: RemovalView | null }> {
    if (!CONTENT_ACTIONS[kind].includes(action)) {
      throw new AppException(
        ErrorCode.CONTENT_ACTION_INVALID,
        `“${action}” is not something you can do to ${kind}`,
        400,
      );
    }
    const spec = SPECS[kind];
    const doc = await loadDoc(this.db, spec.collection, rowId);
    const _id = doc._id as Types.ObjectId;
    const col = this.db.collection(spec.collection);
    const takedownInput = { actor, ip, reason: input.reason };
    const record = (name: string, before: Doc, after: Doc, meta: Doc = {}) =>
      this.audit.record({
        actor,
        action: `content.${name}`,
        targetType: kind,
        targetId: rowId,
        before,
        after,
        meta: { reason: input.reason, ...meta },
        ip,
      });
    const childId = (v: string | undefined, what: string): string => {
      if (!v || !Types.ObjectId.isValid(v)) {
        throw new AppException(ErrorCode.VALIDATION_FAILED, `${what} is required`, 400);
      }
      return v;
    };
    const removed = async (k: TakedownKind, target: string) => {
      const { removal } = await this.takedown.remove(k, target, takedownInput);
      if (!removal)
        throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'It is already down', 409);
      return { ok: true as const, removal };
    };
    const restored = async (k: TakedownKind, target: string, fallback: () => Promise<void>) => {
      const removal = await this.takedown.activeFor(k, target);
      if (removal) await this.takedown.restore(removal.id, actor, ip, input.reason);
      else await fallback();
      return { ok: true as const };
    };

    switch (`${kind}:${action}`) {
      case 'wishlists:archive':
        return removed('wishlist', rowId);
      case 'wishlists:unarchive':
        return restored('wishlist', rowId, async () => {
          if (!doc.archivedAt)
            throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'It is not archived', 409);
          await col.updateOne({ _id }, { $set: { archivedAt: null } });
          await record('unarchive', { archivedAt: 'set' }, { archivedAt: null });
        });
      case 'wishlists:rotate-share': {
        const before = String((doc.share as Doc | undefined)?.slug ?? '');
        const slug = generateSlug();
        await col.updateOne(
          { _id },
          { $set: { 'share.slug': slug, 'share.rotatedAt': new Date() } },
        );
        await record('rotate_share', { slug: before }, { slug });
        return { ok: true };
      }
      case 'wishlists:remove-item': {
        const itemId = childId(input.itemId, 'itemId');
        const item = await this.db
          .collection('wishlist_items')
          .findOne({ _id: new Types.ObjectId(itemId), wishlistId: _id });
        if (!item)
          throw new AppException(ErrorCode.NOT_FOUND, 'That item is not on this wishlist', 404);
        return removed('item', itemId);
      }

      case 'items:hide':
        return removed('item', rowId);
      case 'items:unhide':
        return restored('item', rowId, async () => {
          if (!doc.archivedAt)
            throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'It is not hidden', 409);
          await col.updateOne({ _id }, { $set: { archivedAt: null } });
          await this.wishlists.recount(doc.wishlistId as Types.ObjectId);
          await record('unhide', { archivedAt: 'set' }, { archivedAt: null });
        });
      case 'items:reset-status': {
        // Only an item held by a gift that no longer holds it is stuck.
        const live = await this.db.collection('gifts').findOne({ itemId: _id, active: true });
        if (live) {
          throw new AppException(
            ErrorCode.CONTENT_ACTION_INVALID,
            'A gift still holds this item — cancel the gift instead',
            409,
          );
        }
        if (doc.status === WishlistItemStatus.AVAILABLE) {
          throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'It is already available', 409);
        }
        const before = { status: str(doc.status), activeGiftId: id(doc.activeGiftId) };
        await col.updateOne(
          { _id },
          {
            $set: {
              status: WishlistItemStatus.AVAILABLE,
              activeGiftId: null,
              activeGiftBuyerId: null,
              activeGiftVisibility: null,
              activeGiftShowName: false,
              activeGiftByOwner: false,
            },
          },
        );
        await this.wishlists.recount(doc.wishlistId as Types.ObjectId);
        await record('reset_status', before, {
          status: WishlistItemStatus.AVAILABLE,
          activeGiftId: null,
        });
        return { ok: true };
      }

      case 'events:cancel':
        return removed('event', rowId);
      case 'events:unpublish': {
        if (doc.status !== EventStatus.PUBLISHED) {
          throw new AppException(
            ErrorCode.CONTENT_ACTION_INVALID,
            'Only a published event can be unpublished',
            409,
          );
        }
        await col.updateOne({ _id }, { $set: { status: EventStatus.DRAFT, publishedAt: null } });
        await record('unpublish', { status: str(doc.status) }, { status: EventStatus.DRAFT });
        return { ok: true };
      }
      case 'events:remove-cover':
      case 'events:remove-invite-media': {
        const [urlField, mediaField] =
          action === 'remove-cover'
            ? ['coverUrl', 'coverMediaId']
            : ['inviteMediaUrl', 'inviteMediaId'];
        if (!doc[urlField] && !doc[mediaField]) {
          throw new AppException(
            ErrorCode.CONTENT_ACTION_INVALID,
            'There is nothing to remove',
            409,
          );
        }
        await col.updateOne({ _id }, { $set: { [urlField]: null, [mediaField]: null } });
        if (doc[mediaField]) await this.media.markOrphaned(doc[mediaField] as Types.ObjectId);
        await record(
          action.replace(/-/g, '_'),
          { [urlField]: str(doc[urlField]) },
          { [urlField]: null },
        );
        return { ok: true };
      }

      case 'memories:unlock':
        await this.memories.unlockAsAdmin(rowId);
        await record('unlock', { status: str(doc.status) }, { status: 'unlocked' });
        return { ok: true };
      case 'memories:relock': {
        const when = new Date(input.unlockAt ?? '');
        await this.memories.relockAsAdmin(rowId, when);
        await record(
          'relock',
          { status: str(doc.status), unlockAt: at(doc.unlockAt) },
          { status: 'locked', unlockAt: when },
        );
        return { ok: true };
      }
      case 'memories:remove-wish': {
        const wishId = childId(input.wishId, 'wishId');
        const wish = await this.db
          .collection('memory_wishes')
          .findOne({ _id: new Types.ObjectId(wishId), capsuleId: _id });
        if (!wish)
          throw new AppException(ErrorCode.NOT_FOUND, 'That wish is not in this memory', 404);
        return removed('memory_wish', wishId);
      }
      case 'memories:remove-reply': {
        const replyId = childId(input.replyId, 'replyId');
        const reply = await this.db
          .collection('memory_replies')
          .findOne({ _id: new Types.ObjectId(replyId), capsuleIds: _id });
        if (!reply)
          throw new AppException(ErrorCode.NOT_FOUND, 'That reply is not on this memory', 404);
        return removed('memory_reply', replyId);
      }

      case 'reels:approve-wish':
      case 'reels:reject-wish': {
        const wishId = childId(input.wishId, 'wishId');
        const wishes = this.db.collection('wishes');
        const wish = await wishes.findOne({ _id: new Types.ObjectId(wishId), collectionId: _id });
        if (!wish)
          throw new AppException(ErrorCode.NOT_FOUND, 'That wish is not in this reel', 404);
        if (action === 'reject-wish') return removed('wish', wishId);
        // Approving a wish an admin rejected is putting it back.
        const removal = await this.takedown.activeFor('wish', wishId);
        if (removal) await this.takedown.restore(removal.id, actor, ip, input.reason);
        else {
          await wishes.updateOne(
            { _id: wish._id },
            { $set: { moderationStatus: ModerationStatus.APPROVED } },
          );
          await record(
            'approve_wish',
            { moderationStatus: str(wish.moderationStatus) },
            { moderationStatus: ModerationStatus.APPROVED },
            { wishId },
          );
          await this.takedown.recompileIfReleased(rowId);
        }
        return { ok: true };
      }
      case 'reels:recompile':
      case 'reels:release-now': {
        const allowed =
          action === 'recompile'
            ? [ReelStatus.RELEASED, ReelStatus.FAILED]
            : [ReelStatus.COLLECTING, ReelStatus.LOCKED];
        if (!allowed.includes(doc.status as ReelStatus)) {
          throw new AppException(
            ErrorCode.CONTENT_ACTION_INVALID,
            action === 'recompile'
              ? 'A reel can be compiled again only after it released or failed'
              : 'Only a reel still collecting wishes can be released early',
            409,
          );
        }
        await col.updateOne(
          { _id },
          { $set: { status: ReelStatus.RELEASING, failureReason: null } },
        );
        await this.takedown.enqueueCompile(rowId);
        await record(
          action.replace(/-/g, '_'),
          { status: str(doc.status) },
          { status: ReelStatus.RELEASING },
        );
        return { ok: true };
      }

      case 'chats:delete-message':
      case 'chats:restore-message': {
        const messageId = childId(input.messageId, 'messageId');
        const message = await this.db
          .collection('messages')
          .findOne({ _id: new Types.ObjectId(messageId), chatId: _id });
        if (!message)
          throw new AppException(ErrorCode.NOT_FOUND, 'That message is not in this chat', 404);
        if (action === 'delete-message') return removed('message', messageId);
        return restored('message', messageId, async () => {
          if (!message.deletedAt)
            throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'It is not deleted', 409);
          // Deleted by its sender: an admin can put it back, on the record.
          await this.db
            .collection('messages')
            .updateOne({ _id: message._id }, { $set: { deletedAt: null } });
          await record('restore_message', { deletedAt: 'set' }, { deletedAt: null }, { messageId });
        });
      }

      case 'thank-you:remove':
        return removed('thank_you', rowId);

      case 'media:remove':
        return removed('media', rowId);
      case 'media:delete-now': {
        // For good: the bytes, the transcoded copy and the record. Anything
        // that pointed at it shows a missing file from now on.
        await this.media.deleteNowAsAdmin(rowId);
        await record('delete_now', { exists: true, purpose: str(doc.purpose) }, { exists: false });
        return { ok: true };
      }
      case 'media:retry-processing': {
        const before = str(doc.status);
        const after = await this.media.reprocessAsAdmin(rowId);
        await record('retry_processing', { status: before }, { status: after.status });
        return { ok: true };
      }
    }
    throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'Unknown action', 400);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private namesOf(rows: ContentRow[], fields: string[]): Promise<Record<string, string>> {
    return this.user360.namesFor([...new Set(refsIn(rows, fields))]);
  }
}
