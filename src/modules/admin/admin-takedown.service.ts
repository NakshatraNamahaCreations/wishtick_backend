import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Connection, Model, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { EventRemindersService } from 'src/modules/events/event-reminders.service';
import { EventStatus } from 'src/modules/events/event.types';
import { EventsService } from 'src/modules/events/events.service';
import { MediaStatus } from 'src/modules/media/schemas/media.schema';
import { NotificationService } from 'src/modules/notifications/notification.service';
import { NotificationType } from 'src/modules/notifications/notification.types';
import {
  REEL_COMPILE_JOB,
  compileJobId,
  type ReelCompileJobData,
} from 'src/modules/reels/reel.jobs';
import { ModerationStatus, ReelStatus } from 'src/modules/reels/reel.types';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import type { AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';
import { Removal, type RemovalDocument } from './schemas/removal.schema';

type Doc = mongo.Document;

/** Everything an admin can take down, and put back. */
export const TAKEDOWN_KINDS = [
  'message',
  'wish',
  'reel',
  'wishlist',
  'item',
  'event',
  'memory_wish',
  'memory_reply',
  'thank_you',
  'profile',
  'group_gift',
  'media',
] as const;
export type TakedownKind = (typeof TAKEDOWN_KINDS)[number];

/** How the owner's notice names what was removed. */
const LABEL: Record<TakedownKind, string> = {
  message: 'a chat message',
  wish: 'a birthday reel wish',
  reel: 'a birthday reel',
  wishlist: 'a wishlist',
  item: 'a wishlist item',
  event: 'an event',
  memory_wish: 'a memory wish',
  memory_reply: 'a memory reply',
  thank_you: 'a thank-you note',
  profile: 'your profile photo and bio',
  group_gift: "a group gift's title",
  media: 'an uploaded file',
};

export interface RemovalView {
  id: string;
  kind: string;
  targetId: string;
  mode: 'soft' | 'hard';
  reason: string | null;
  reportId: string | null;
  removedBy: string;
  createdAt: Date;
  restoredAt: Date | null;
  restoredBy: string | null;
}

export interface TakedownInput {
  actor: AuthenticatedAdmin;
  ip: string | null;
  reason: string | null;
  /** Set when a report drove it; the report's own audit row then covers it. */
  reportId?: string | null;
}

/** What one kind's takedown changes, and where. */
interface Plan {
  collection: string;
  /** Hard: the document is deleted (and the whole of it kept). */
  mode: 'soft' | 'hard';
  /** Find the document; null when it does not exist. */
  find: (id: Types.ObjectId) => Doc;
  /** Soft only: the fields to set. */
  set?: () => Doc;
  /** True when the document is already down, so a second takedown is a no-op. */
  isDown?: (doc: Doc) => boolean;
  owner: (doc: Doc) => unknown;
}

const oid = (v: unknown): Types.ObjectId | null =>
  v instanceof Types.ObjectId
    ? v
    : typeof v === 'string' && Types.ObjectId.isValid(v)
      ? new Types.ObjectId(v)
      : null;

const REMOVED_TITLE = 'Removed by Wishtick';

const PLANS: Record<TakedownKind, Plan> = {
  message: {
    collection: 'messages',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    set: () => ({ deletedAt: new Date() }),
    isDown: (d) => d.deletedAt instanceof Date,
    owner: (d) => d.senderId as unknown,
  },
  wish: {
    collection: 'wishes',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    set: () => ({ moderationStatus: ModerationStatus.REJECTED }),
    isDown: (d) => d.moderationStatus === ModerationStatus.REJECTED,
    owner: (d) => d.authorId as unknown,
  },
  reel: {
    collection: 'reel_collections',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    set: () => ({ reelMediaUrl: null }),
    isDown: (d) => !d.reelMediaUrl,
    owner: (d) => d.initiatorId as unknown,
  },
  wishlist: {
    collection: 'wishlists',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    set: () => ({ archivedAt: new Date() }),
    isDown: (d) => d.archivedAt instanceof Date,
    owner: (d) => d.ownerId as unknown,
  },
  item: {
    collection: 'wishlist_items',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    set: () => ({ archivedAt: new Date() }),
    isDown: (d) => d.archivedAt instanceof Date,
    owner: (d) => d.ownerId as unknown,
  },
  event: {
    collection: 'events',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    // Applied through EventsService, so guests are told and reminders stop.
    isDown: (d) => d.status === EventStatus.CANCELLED,
    owner: (d) => d.hostId as unknown,
  },
  memory_wish: {
    collection: 'memory_wishes',
    mode: 'hard',
    find: (id) => ({ _id: id }),
    owner: (d) => d.contributorId as unknown,
  },
  memory_reply: {
    collection: 'memory_replies',
    mode: 'hard',
    find: (id) => ({ _id: id }),
    owner: (d) => d.authorId as unknown,
  },
  thank_you: {
    collection: 'thank_you_notes',
    mode: 'hard',
    find: (id) => ({ _id: id }),
    owner: (d) => d.recipientId as unknown,
  },
  profile: {
    // A profile is reported by its user id.
    collection: 'user_profiles',
    mode: 'soft',
    find: (id) => ({ userId: id }),
    set: () => ({ bio: null, photoUrl: null, photoMediaId: null }),
    isDown: (d) => !d.bio && !d.photoUrl,
    owner: (d) => d.userId as unknown,
  },
  group_gift: {
    collection: 'group_gifts',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    set: () => ({ title: REMOVED_TITLE }),
    isDown: (d) => d.title === REMOVED_TITLE,
    owner: (d) => d.initiatorId as unknown,
  },
  media: {
    // Orphaned: the sweeper reclaims the bytes after its grace period, so a
    // restore works until then and fails cleanly after.
    collection: 'media',
    mode: 'soft',
    find: (id) => ({ _id: id }),
    set: () => ({ status: MediaStatus.ORPHANED, url: null }),
    isDown: (d) => d.status === MediaStatus.ORPHANED,
    owner: (d) => d.ownerId as unknown,
  },
};

/**
 * Takes content down and puts it back — for the moderation queue and for the
 * content pages alike, so a removal made in either can be undone from either.
 *
 * Every takedown writes an `admin_removals` row holding what it changed, tells
 * the owner, and (unless a report's own audit row covers it) is audited.
 */
@Injectable()
export class AdminTakedownService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectModel(Removal.name) private readonly removals: Model<RemovalDocument>,
    @InjectQueue(QUEUE.REELS) private readonly reelsQueue: Queue,
    private readonly events: EventsService,
    private readonly reminders: EventRemindersService,
    private readonly wishlists: WishlistsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  /**
   * Takes [targetId] of [kind] down. Returns the owner it was taken from, and
   * the removal — null when it was already down or no longer exists.
   */
  async remove(
    kind: TakedownKind,
    targetId: string,
    input: TakedownInput,
  ): Promise<{ removal: RemovalView | null; ownerId: string | null }> {
    const plan = PLANS[kind];
    const id = oid(targetId);
    if (!id) return { removal: null, ownerId: null };
    const col = this.db.collection(plan.collection);
    const doc = await col.findOne(plan.find(id));
    if (!doc) return { removal: null, ownerId: null };
    const ownerId = oid(plan.owner(doc))?.toString() ?? null;
    if (plan.isDown?.(doc)) return { removal: null, ownerId };

    let before: Record<string, unknown>;
    if (plan.mode === 'hard') {
      before = doc;
      await col.deleteOne({ _id: doc._id });
      await this.afterHard(kind, doc, -1);
    } else if (kind === 'event') {
      before = { status: doc.status, cancelledAt: doc.cancelledAt ?? null };
      await this.events.cancelAsAdmin(targetId);
    } else {
      const set = plan.set!();
      before = Object.fromEntries(Object.keys(set).map((k) => [k, doc[k] ?? null]));
      await col.updateOne({ _id: doc._id }, { $set: set });
      await this.afterSoft(kind, doc);
    }

    const removal = await this.removals.create({
      kind,
      targetId,
      mode: plan.mode,
      collectionName: plan.collection,
      before,
      ownerId: ownerId ? new Types.ObjectId(ownerId) : null,
      reason: input.reason,
      reportId: input.reportId ?? null,
      removedBy: new Types.ObjectId(input.actor.id),
    });

    if (!input.reportId) {
      await this.audit.record({
        actor: input.actor,
        action: 'content.remove',
        targetType: kind,
        targetId,
        before: plan.mode === 'soft' ? before : { exists: true },
        after: plan.mode === 'soft' ? this.afterOf(kind, plan) : { exists: false },
        meta: { reason: input.reason, removalId: removal._id.toString() },
        ip: input.ip,
      });
    }

    if (ownerId) {
      await this.notifications.enqueue({
        userId: ownerId,
        type: NotificationType.CONTENT_REMOVED,
        refId: input.reportId ?? removal._id.toString(),
        payload: { targetType: LABEL[kind], reason: input.reason ?? 'community guidelines' },
      });
    }
    return { removal: toView(removal), ownerId };
  }

  /** Puts a removal back exactly as it was. */
  async restore(
    removalId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
    reason: string,
  ): Promise<RemovalView> {
    const removal = await this.load(removalId);
    if (removal.restoredAt) {
      throw new AppException(ErrorCode.REMOVAL_ALREADY_RESTORED, 'This was already put back', 409);
    }
    const kind = removal.kind as TakedownKind;
    const plan = PLANS[kind];
    const col = this.db.collection(removal.collectionName);
    const id = new Types.ObjectId(removal.targetId);

    if (removal.mode === 'hard') {
      const doc = removal.before as Doc;
      if (await col.findOne({ _id: doc._id as Types.ObjectId })) {
        throw new AppException(ErrorCode.NOT_RESTORABLE, 'It is already back', 409);
      }
      await col.insertOne(doc);
      await this.afterHard(kind, doc, +1);
    } else {
      const doc = await col.findOne(plan.find(id));
      if (!doc) {
        throw new AppException(
          ErrorCode.NOT_RESTORABLE,
          'It no longer exists, so it cannot be put back',
          409,
        );
      }
      await col.updateOne({ _id: doc._id }, { $set: removal.before });
      if (kind === 'event' && removal.before.status === EventStatus.PUBLISHED) {
        const event = await this.events.findOrFail(removal.targetId);
        await this.reminders.schedule(event);
      }
      await this.afterSoft(kind, doc);
    }

    removal.restoredAt = new Date();
    removal.restoredBy = new Types.ObjectId(actor.id);
    await removal.save();

    await this.audit.record({
      actor,
      action: 'content.restore',
      targetType: kind,
      targetId: removal.targetId,
      before: removal.mode === 'soft' ? this.afterOf(kind, plan) : { exists: false },
      after: removal.mode === 'soft' ? removal.before : { exists: true },
      meta: { reason, removalId },
      ip,
    });
    return toView(removal);
  }

  /** The latest removal of one thing that has not been put back, if any. */
  async activeFor(kind: string, targetId: string): Promise<RemovalView | null> {
    const removal = await this.removals
      .findOne({ kind, targetId, restoredAt: null })
      .sort({ createdAt: -1 })
      .exec();
    return removal ? toView(removal) : null;
  }

  /** Removals, newest first — every kind, or one. */
  async list(
    filter: { kind?: string; targetId?: string; ownerId?: string },
    page: number,
    limit: number,
  ) {
    const query: Record<string, unknown> = {};
    if (filter.kind) query.kind = filter.kind;
    if (filter.targetId) query.targetId = filter.targetId;
    if (filter.ownerId && Types.ObjectId.isValid(filter.ownerId)) {
      query.ownerId = new Types.ObjectId(filter.ownerId);
    }
    const [docs, total] = await Promise.all([
      this.removals
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.removals.countDocuments(query).exec(),
    ]);
    return { items: docs.map(toView), total, page, limit };
  }

  /** How many takedowns an account has had — for the offender history panel. */
  countForOwner(ownerId: string): Promise<number> {
    if (!Types.ObjectId.isValid(ownerId)) return Promise.resolve(0);
    return this.removals.countDocuments({ ownerId: new Types.ObjectId(ownerId) }).exec();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private afterOf(kind: TakedownKind, plan: Plan): Record<string, unknown> {
    if (kind === 'event') return { status: EventStatus.CANCELLED };
    const set = plan.set?.() ?? {};
    // Dates are "now" at removal — the diff only needs to say it was set.
    return Object.fromEntries(
      Object.entries(set).map(([k, v]) => [k, v instanceof Date ? 'set' : v]),
    );
  }

  /** Keeps counters right when a hard-removed document leaves or comes back. */
  private async afterHard(kind: TakedownKind, doc: Doc, delta: 1 | -1): Promise<void> {
    if (kind === 'memory_wish' && doc.capsuleId) {
      await this.db
        .collection('memory_capsules')
        .updateOne({ _id: doc.capsuleId as Types.ObjectId }, { $inc: { wishCount: delta } });
    }
  }

  private async afterSoft(kind: TakedownKind, doc: Doc): Promise<void> {
    // An item that leaves or rejoins a list changes the list's counts.
    if (kind === 'item' && doc.wishlistId) {
      await this.wishlists.recount(doc.wishlistId as Types.ObjectId);
    }
    // A released reel was compiled with the wish in (or out); compile again.
    if (kind === 'wish' && doc.collectionId) {
      await this.recompileIfReleased(String(doc.collectionId));
    }
  }

  async recompileIfReleased(collectionId: string): Promise<void> {
    const reels = this.db.collection('reel_collections');
    const res = await reels.updateOne(
      { _id: new Types.ObjectId(collectionId), status: ReelStatus.RELEASED },
      { $set: { status: ReelStatus.RELEASING } },
    );
    if (res.modifiedCount === 0) return;
    await this.enqueueCompile(collectionId);
  }

  async enqueueCompile(collectionId: string): Promise<void> {
    await this.reelsQueue.add(REEL_COMPILE_JOB, { collectionId } satisfies ReelCompileJobData, {
      jobId: compileJobId(collectionId),
      removeOnComplete: true,
    });
  }

  private async load(removalId: string): Promise<RemovalDocument> {
    const removal = Types.ObjectId.isValid(removalId)
      ? await this.removals.findById(removalId).exec()
      : null;
    if (!removal) throw new AppException(ErrorCode.NOT_FOUND, 'Removal not found', 404);
    return removal;
  }
}

function toView(r: RemovalDocument): RemovalView {
  return {
    id: r._id.toString(),
    kind: r.kind,
    targetId: r.targetId,
    mode: r.mode,
    reason: r.reason,
    reportId: r.reportId,
    removedBy: r.removedBy.toString(),
    createdAt: r.createdAt,
    restoredAt: r.restoredAt,
    restoredBy: r.restoredBy?.toString() ?? null,
  };
}
