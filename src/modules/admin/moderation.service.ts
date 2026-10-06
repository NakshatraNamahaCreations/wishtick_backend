import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { Message, type MessageDocument } from 'src/modules/chat/schemas/message.schema';
import { EventStatus } from 'src/modules/events/event.types';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { ModerationStatus } from 'src/modules/reels/reel.types';
import {
  ReelCollection,
  type ReelCollectionDocument,
} from 'src/modules/reels/schemas/reel-collection.schema';
import { Wish, type WishDocument } from 'src/modules/reels/schemas/wish.schema';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import { AdminTakedownService } from './admin-takedown.service';
import { AdminUser360Service } from './admin-user360.service';
import { AdminUsersService } from './admin-users.service';
import type { AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';
import {
  type ModerationTargetView,
  ModerationAction,
  ReportSource,
  ReportStatus,
  ReportTargetType,
  severityFor,
} from './moderation.types';
import { Report, type ReportDocument } from './schemas/report.schema';

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @InjectModel(Report.name) private readonly reportModel: Model<ReportDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Wish.name) private readonly wishModel: Model<WishDocument>,
    @InjectModel(ReelCollection.name) private readonly reelModel: Model<ReelCollectionDocument>,
    @InjectModel(Wishlist.name) private readonly wishlistModel: Model<WishlistDocument>,
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectConnection() private readonly conn: Connection,
    private readonly users: AdminUsersService,
    private readonly audit: AuditService,
    private readonly takedown: AdminTakedownService,
    private readonly user360: AdminUser360Service,
  ) {}

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  // ── Intake (user report + auto-flag) ────────────────────────────────────────

  async report(
    reporterId: string,
    input: { targetType: ReportTargetType; targetId: string; reason: string; detail?: string },
  ): Promise<ReportDocument> {
    return this.upsertReport({
      reporterId: new Types.ObjectId(reporterId),
      source: ReportSource.USER,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      detail: input.detail ?? null,
    });
  }

  /** An auto-flag hook (profanity, future media safety) raised something. */
  async autoFlag(input: {
    targetType: ReportTargetType;
    targetId: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.upsertReport({
        reporterId: null,
        source: ReportSource.AUTO,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        detail: null,
      });
    } catch (err) {
      this.logger.error(
        `Auto-flag failed for ${input.targetType} ${input.targetId}: ${String(err)}`,
      );
    }
  }

  private async upsertReport(input: {
    reporterId: Types.ObjectId | null;
    source: ReportSource;
    targetType: ReportTargetType;
    targetId: string;
    reason: string;
    detail: string | null;
  }): Promise<ReportDocument> {
    try {
      return await this.reportModel.create({
        ...input,
        severity: severityFor(input.targetType, input.source),
      });
    } catch (err) {
      // The unique (source, target, reporter) index collapses duplicate reports.
      if ((err as { code?: number })?.code === 11000) {
        const existing = await this.reportModel
          .findOne({
            source: input.source,
            targetType: input.targetType,
            targetId: input.targetId,
            reporterId: input.reporterId,
          })
          .exec();
        if (existing) return existing;
      }
      throw err;
    }
  }

  // ── Queue (admin) ────────────────────────────────────────────────────────────

  /** Shared lookup: an invalid id and a missing report are the same 404. */
  private async loadReport(reportId: string): Promise<ReportDocument> {
    if (!Types.ObjectId.isValid(reportId)) {
      throw new AppException(ErrorCode.REPORT_NOT_FOUND, 'Report not found', 404);
    }
    const report = await this.reportModel.findById(reportId).exec();
    if (!report) throw new AppException(ErrorCode.REPORT_NOT_FOUND, 'Report not found', 404);
    return report;
  }

  /** One report, for its own page — rather than finding it by paging the queue. */
  async getReport(reportId: string): Promise<ReportDocument> {
    return this.loadReport(reportId);
  }

  /**
   * The report queue, worst-first.
   *
   * Returns a paginated envelope matching `GET /admin/users`, not a bare array:
   * a backlog is exactly the situation where the operator needs to page, and
   * the previous fixed 50-item slice made anything beyond it unreachable.
   */
  async queue(filters: {
    targetType?: ReportTargetType;
    status?: ReportStatus;
    source?: string;
    /** `me`: claimed by [adminId]; `none`: unclaimed. */
    assigned?: 'me' | 'none';
    adminId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: ReportDocument[]; total: number; page: number; limit: number }> {
    const query: Record<string, unknown> = {};
    query.status = filters.status ?? ReportStatus.OPEN;
    if (filters.targetType) query.targetType = filters.targetType;
    if (filters.source) query.source = filters.source;
    if (filters.assigned === 'none') query.assignedAdminId = null;
    if (filters.assigned === 'me' && filters.adminId) {
      query.assignedAdminId = new Types.ObjectId(filters.adminId);
    }

    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);

    const [items, total] = await Promise.all([
      this.reportModel
        .find(query)
        // Severity first, then oldest — the longest-waiting serious report wins.
        .sort({ severity: -1, createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.reportModel.countDocuments(query).exec(),
    ]);

    return { items, total, page, limit };
  }

  /**
   * Resolve a report's target into something a human can judge.
   *
   * Without this the queue hands a moderator a type and an ObjectId and asks
   * them to decide — which is not a decision, it is a coin flip with an audit
   * trail. A missing target is NOT an error: content can be hard-deleted after
   * being reported, and the report still needs resolving.
   */
  async resolveTarget(reportId: string): Promise<ModerationTargetView> {
    const report = await this.loadReport(reportId);
    const view = await this.describeTarget(report);
    const removal =
      report.targetType === ReportTargetType.USER
        ? null
        : await this.takedown.activeFor(report.targetType, report.targetId);
    return { ...view, removal, state: removal && !view.state ? 'removed' : view.state };
  }

  private async describeTarget(report: ReportDocument): Promise<ModerationTargetView> {
    const id = report.targetId;

    const base = {
      targetType: report.targetType,
      targetId: id,
      exists: false,
      title: null,
      body: null,
      mediaUrl: null,
      authorId: null,
      state: null,
      createdAt: null,
      fields: {},
      removal: null,
    } satisfies ModerationTargetView;

    if (!Types.ObjectId.isValid(id)) return base;

    switch (report.targetType) {
      case ReportTargetType.MESSAGE: {
        const msg = await this.messageModel.findById(id).exec();
        if (!msg) return base;
        return {
          ...base,
          exists: true,
          title: 'Chat message',
          body: msg.body ?? null,
          authorId: msg.senderId?.toString() ?? null,
          state: msg.deletedAt ? 'deleted' : null,
          createdAt: msg.createdAt ?? null,
          fields: {
            kind: msg.kind ?? null,
            chatId: msg.chatId?.toString() ?? null,
            edited: msg.editedAt ? true : false,
            attachments: msg.attachments?.length ?? 0,
          },
        };
      }

      case ReportTargetType.WISH: {
        const wish = await this.wishModel.findById(id).exec();
        if (!wish) return base;
        return {
          ...base,
          exists: true,
          title: `${wish.kind ?? 'text'} wish`,
          body: wish.text ?? null,
          mediaUrl: wish.mediaId?.toString() ?? null,
          authorId: wish.authorId?.toString() ?? null,
          state:
            wish.moderationStatus === ModerationStatus.REJECTED
              ? 'rejected'
              : (wish.moderationStatus ?? null),
          createdAt: wish.createdAt ?? null,
          fields: {
            authorName: wish.authorName ?? null,
            collectionId: wish.collectionId?.toString() ?? null,
            durationMs: wish.durationMs ?? null,
          },
        };
      }

      case ReportTargetType.REEL: {
        const reel = await this.reelModel.findById(id).exec();
        if (!reel) return base;
        return {
          ...base,
          exists: true,
          title: 'Birthday reel',
          body: null,
          mediaUrl: reel.reelMediaUrl ?? null,
          authorId: reel.initiatorId?.toString() ?? null,
          state: reel.reelMediaUrl ? (reel.status ?? null) : 'media removed',
          createdAt: reel.createdAt ?? null,
          fields: {
            status: reel.status ?? null,
            recipientUserId: reel.recipientUserId?.toString() ?? null,
            releaseAt: reel.releaseAt ? reel.releaseAt.toISOString() : null,
          },
        };
      }

      case ReportTargetType.WISHLIST: {
        const wl = await this.wishlistModel.findById(id).exec();
        if (!wl) return base;
        return {
          ...base,
          exists: true,
          title: wl.title ?? 'Untitled wishlist',
          body: wl.description ?? null,
          mediaUrl: wl.coverUrl ?? null,
          authorId: wl.ownerId?.toString() ?? null,
          state: wl.archivedAt ? 'archived' : null,
          createdAt: wl.createdAt ?? null,
          fields: {
            visibility: wl.visibility ?? null,
            itemCount: wl.stats?.itemCount ?? null,
          },
        };
      }

      case ReportTargetType.EVENT: {
        const event = await this.eventModel.findById(id).exec();
        if (!event) return base;
        return {
          ...base,
          exists: true,
          title: event.title ?? 'Untitled event',
          body: event.description ?? null,
          mediaUrl: event.coverUrl ?? null,
          authorId: event.hostId?.toString() ?? null,
          state: event.status === EventStatus.CANCELLED ? 'cancelled' : (event.status ?? null),
          createdAt: event.createdAt ?? null,
          fields: {
            type: event.type ?? null,
            visibility: event.visibility ?? null,
            startsAt: event.startsAt ? event.startsAt.toISOString() : null,
          },
        };
      }

      case ReportTargetType.USER: {
        // Reuse the admin user projection so the moderator sees the same record
        // the Users screen would show, rather than a second, divergent view.
        try {
          const user = await this.users.getDetail(id);
          return {
            ...base,
            exists: true,
            title: user.name ?? user.email ?? user.phone ?? 'Anonymized account',
            body: null,
            authorId: user.id,
            state: user.status === 'active' ? null : user.status,
            createdAt: user.createdAt ?? null,
            fields: {
              email: user.email,
              phone: user.phone,
              status: user.status,
              suspendedReason: user.suspendedReason,
              wishlists: user.counts.wishlists,
              giftsGiven: user.counts.giftsGiven,
            },
          };
        } catch {
          return base;
        }
      }

      case ReportTargetType.MEMORY_WISH:
      case ReportTargetType.MEMORY_REPLY: {
        const isWish = report.targetType === ReportTargetType.MEMORY_WISH;
        const doc = await this.db
          .collection(isWish ? 'memory_wishes' : 'memory_replies')
          .findOne({ _id: new Types.ObjectId(id) });
        if (!doc) return base;
        return {
          ...base,
          exists: true,
          title: `${String(doc.kind ?? 'text')} ${isWish ? 'memory wish' : 'memory reply'}`,
          body: str(doc.text),
          mediaUrl: str(doc.mediaUrl),
          authorId: oidStr(isWish ? doc.contributorId : doc.authorId),
          createdAt: date(doc.createdAt),
          fields: {
            author: str(isWish ? doc.contributorName : doc.authorName),
            memoryId: isWish ? oidStr(doc.capsuleId) : null,
            contentType: str(doc.contentType),
          },
        };
      }

      case ReportTargetType.THANK_YOU: {
        const doc = await this.db
          .collection('thank_you_notes')
          .findOne({ _id: new Types.ObjectId(id) });
        if (!doc) return base;
        const ctx = (doc.context ?? {}) as Record<string, unknown>;
        return {
          ...base,
          exists: true,
          title: str(doc.subject) ?? 'Thank-you note',
          body: str(doc.body),
          mediaUrl: str(doc.mediaUrl),
          authorId: oidStr(doc.recipientId),
          state: str(doc.status),
          createdAt: date(doc.createdAt),
          fields: {
            to: str(ctx.gifterName),
            item: str(ctx.itemTitle),
            kind: str(doc.kind),
          },
        };
      }

      case ReportTargetType.PROFILE: {
        const doc = await this.db
          .collection('user_profiles')
          .findOne({ userId: new Types.ObjectId(id) });
        if (!doc) return base;
        return {
          ...base,
          exists: true,
          title: str(doc.displayName) ?? 'Profile',
          body: str(doc.bio),
          mediaUrl: str(doc.photoUrl),
          authorId: id,
          createdAt: date(doc.createdAt),
          fields: { username: str(doc.username), city: str(doc.city) },
        };
      }

      case ReportTargetType.GROUP_GIFT: {
        const doc = await this.db
          .collection('group_gifts')
          .findOne({ _id: new Types.ObjectId(id) });
        if (!doc) return base;
        return {
          ...base,
          exists: true,
          title: str(doc.title) ?? 'Group gift',
          body: null,
          authorId: oidStr(doc.initiatorId),
          state: str(doc.status),
          createdAt: date(doc.createdAt),
          fields: {
            forName: str(doc.forName),
            contributors: typeof doc.contributorCount === 'number' ? doc.contributorCount : null,
          },
        };
      }

      case ReportTargetType.MEDIA: {
        const doc = await this.db.collection('media').findOne({ _id: new Types.ObjectId(id) });
        if (!doc) return base;
        return {
          ...base,
          exists: true,
          title: `Uploaded file (${String(doc.purpose)})`,
          mediaUrl: str(doc.url),
          authorId: oidStr(doc.ownerId),
          state: doc.status === 'ready' ? null : str(doc.status),
          createdAt: date(doc.createdAt),
          fields: {
            contentType: str(doc.contentType),
            sizeBytes: typeof doc.sizeBytes === 'number' ? doc.sizeBytes : null,
          },
        };
      }
    }
  }

  // ── Claiming, context, bulk ──────────────────────────────────────────────────

  /**
   * Takes a report: it shows as theirs in the queue so nobody else works it.
   * Taking one someone else holds needs [takeOver] — it is said out loud.
   */
  async claim(
    reportId: string,
    actor: AuthenticatedAdmin,
    takeOver = false,
  ): Promise<ReportDocument> {
    const report = await this.loadReport(reportId);
    const holder = report.assignedAdminId?.toString();
    if (holder && holder !== actor.id && !takeOver) {
      throw new AppException(
        ErrorCode.REPORT_CLAIMED,
        'Another moderator is working on this report',
        409,
      );
    }
    report.assignedAdminId = new Types.ObjectId(actor.id);
    report.assignedAt = new Date();
    await report.save();
    return report;
  }

  async release(reportId: string, actor: AuthenticatedAdmin): Promise<ReportDocument> {
    const report = await this.loadReport(reportId);
    if (report.assignedAdminId && report.assignedAdminId.toString() !== actor.id) {
      throw new AppException(
        ErrorCode.REPORT_CLAIMED,
        'Only the moderator holding it can let it go',
        409,
      );
    }
    report.assignedAdminId = null;
    report.assignedAt = null;
    await report.save();
    return report;
  }

  /**
   * Who is involved, and their record: how often the reporter reports and how
   * often they are right, and what the author has had reported and removed.
   */
  async context(reportId: string): Promise<{
    reporter: {
      id: string;
      name: string | null;
      reports: number;
      upheld: number;
      dismissed: number;
    } | null;
    author: {
      id: string;
      name: string | null;
      status: string | null;
      reportsAboutContent: number;
      reportsAboutThem: number;
      removals: number;
    } | null;
    sameTarget: number;
    assignedTo: { id: string; email: string | null } | null;
  }> {
    const report = await this.loadReport(reportId);
    const target = await this.describeTarget(report);
    const authorId = target.authorId;

    const reporter = report.reporterId
      ? await (async () => {
          const rid = report.reporterId!;
          const [reports, upheld, dismissed] = await Promise.all([
            this.reportModel.countDocuments({ reporterId: rid }).exec(),
            this.reportModel
              .countDocuments({ reporterId: rid, status: ReportStatus.RESOLVED })
              .exec(),
            this.reportModel
              .countDocuments({ reporterId: rid, status: ReportStatus.DISMISSED })
              .exec(),
          ]);
          return { id: rid.toString(), reports, upheld, dismissed };
        })()
      : null;

    const author = authorId
      ? await (async () => {
          const authorOid = Types.ObjectId.isValid(authorId) ? new Types.ObjectId(authorId) : null;
          const [aboutThem, removals, user, aboutContent] = await Promise.all([
            this.reportModel
              .countDocuments({
                targetType: { $in: [ReportTargetType.USER, ReportTargetType.PROFILE] },
                targetId: authorId,
              })
              .exec(),
            this.takedown.countForOwner(authorId),
            authorOid
              ? this.db
                  .collection('users')
                  .findOne({ _id: authorOid }, { projection: { status: 1 } })
              : null,
            this.reportsAboutContentBy(authorId),
          ]);
          return {
            id: authorId,
            status: str(user?.status),
            reportsAboutContent: aboutContent,
            reportsAboutThem: aboutThem,
            removals,
          };
        })()
      : null;

    const ids = [reporter?.id, author?.id].filter((x): x is string => !!x);
    const names = await this.user360.namesFor(ids);
    const assigned = report.assignedAdminId
      ? await this.db
          .collection('admins')
          .findOne({ _id: report.assignedAdminId }, { projection: { email: 1 } })
      : null;

    return {
      reporter: reporter ? { ...reporter, name: names[reporter.id] ?? null } : null,
      author: author ? { ...author, name: names[author.id] ?? null } : null,
      sameTarget: await this.reportModel
        .countDocuments({ targetType: report.targetType, targetId: report.targetId })
        .exec(),
      assignedTo: report.assignedAdminId
        ? { id: report.assignedAdminId.toString(), email: str(assigned?.email) }
        : null,
    };
  }

  /**
   * Reports filed about things this person made. Takedown rows know the owner
   * of everything removed; for open reports, the content kinds that carry an
   * author on the reported document are checked directly.
   */
  private async reportsAboutContentBy(authorId: string): Promise<number> {
    if (!Types.ObjectId.isValid(authorId)) return 0;
    const uid = new Types.ObjectId(authorId);
    const owned = await Promise.all(
      (
        [
          ['messages', 'senderId', ReportTargetType.MESSAGE],
          ['wishlists', 'ownerId', ReportTargetType.WISHLIST],
          ['events', 'hostId', ReportTargetType.EVENT],
          ['wishes', 'authorId', ReportTargetType.WISH],
          ['memory_wishes', 'contributorId', ReportTargetType.MEMORY_WISH],
        ] as const
      ).map(async ([collection, field, type]) => {
        const reported = await this.reportModel.distinct('targetId', { targetType: type }).exec();
        const valid = reported
          .filter((t) => Types.ObjectId.isValid(t))
          .map((t) => new Types.ObjectId(t));
        if (valid.length === 0) return [] as string[];
        const mine = await this.db
          .collection(collection)
          .find({ _id: { $in: valid }, [field]: uid })
          .project({ _id: 1 })
          .toArray();
        return mine.map((m) => String(m._id));
      }),
    );
    const targetIds = owned.flat();
    if (targetIds.length === 0) return 0;
    return this.reportModel.countDocuments({ targetId: { $in: targetIds } }).exec();
  }

  /** The same action on many reports; each is handled (and audited) on its own. */
  async bulkAct(
    reportIds: string[],
    action: ModerationAction,
    actor: AuthenticatedAdmin,
    ip: string | null,
    reason: string | null,
  ): Promise<{ done: string[]; failed: { id: string; code: string; message: string }[] }> {
    const done: string[] = [];
    const failed: { id: string; code: string; message: string }[] = [];
    for (const reportId of [...new Set(reportIds)]) {
      try {
        await this.act(reportId, action, actor, ip, reason);
        done.push(reportId);
      } catch (err) {
        failed.push({
          id: reportId,
          code: err instanceof AppException ? err.errorCode : 'INTERNAL',
          message: err instanceof Error ? err.message : 'Failed',
        });
      }
    }
    return { done, failed };
  }

  /**
   * Undoes a report's removal — the content comes back exactly as it was (a
   * suspended person is reactivated) — and the report says so.
   */
  async restore(
    reportId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
    reason: string,
  ): Promise<ReportDocument> {
    const report = await this.loadReport(reportId);
    if (report.status !== ReportStatus.RESOLVED) {
      throw new AppException(ErrorCode.NOT_RESTORABLE, 'Nothing was removed for this report', 409);
    }
    if (report.targetType === ReportTargetType.USER) {
      await this.users.reactivate(report.targetId, actor, ip);
    } else {
      const removal = await this.takedown.activeFor(report.targetType, report.targetId);
      if (!removal) {
        throw new AppException(
          ErrorCode.NOT_RESTORABLE,
          'There is no removal in force to undo',
          409,
        );
      }
      await this.takedown.restore(removal.id, actor, ip, reason);
    }
    const before = { status: report.status, resolution: report.resolution };
    report.status = ReportStatus.DISMISSED;
    report.resolution = `Restored: ${reason}`;
    report.handledBy = new Types.ObjectId(actor.id);
    report.handledAt = new Date();
    await report.save();
    await this.audit.record({
      actor,
      action: 'moderation.restore',
      targetType: report.targetType,
      targetId: report.targetId,
      before,
      after: { status: report.status, resolution: report.resolution },
      meta: { reportId, reason },
      ip,
    });
    return report;
  }

  // ── Actions (admin, audited) ────────────────────────────────────────────────

  async act(
    reportId: string,
    action: ModerationAction,
    actor: AuthenticatedAdmin,
    ip: string | null,
    reason: string | null,
  ): Promise<ReportDocument> {
    const report = await this.loadReport(reportId);
    if (report.status === ReportStatus.RESOLVED || report.status === ReportStatus.DISMISSED) {
      throw new AppException(
        ErrorCode.REPORT_ALREADY_HANDLED,
        'This report is already handled',
        409,
      );
    }

    const before = { status: report.status, severity: report.severity };
    let resolution = reason;

    switch (action) {
      case ModerationAction.APPROVE:
        report.status = ReportStatus.DISMISSED;
        resolution = resolution ?? 'Report rejected — content left up';
        break;
      case ModerationAction.REMOVE:
        await this.removeTarget(report, actor, ip, reason);
        report.status = ReportStatus.RESOLVED;
        resolution = resolution ?? 'Content removed';
        break;
    }

    report.resolution = resolution;
    report.handledBy = new Types.ObjectId(actor.id);
    report.handledAt = new Date();
    await report.save();

    await this.audit.record({
      actor,
      action: `moderation.${action}`,
      targetType: report.targetType,
      targetId: report.targetId,
      before,
      after: { status: report.status, severity: report.severity, resolution },
      meta: { reportId, reason },
      ip,
    });
    return report;
  }

  /** Takes the target down in the way that fits its kind; the owner is told. */
  private async removeTarget(
    report: ReportDocument,
    actor: AuthenticatedAdmin,
    ip: string | null,
    reason: string | null,
  ): Promise<void> {
    if (report.targetType === ReportTargetType.USER) {
      // Removing a person = suspend (which audits + kills their sessions).
      await this.users.suspend(
        report.targetId,
        reason ?? 'Removed after moderation review',
        actor,
        ip,
      );
      return;
    }
    await this.takedown.remove(report.targetType, report.targetId, {
      actor,
      ip,
      reason,
      reportId: report._id.toString(),
    });
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const date = (v: unknown): Date | null => (v instanceof Date ? v : null);
const oidStr = (v: unknown): string | null =>
  v instanceof Types.ObjectId ? v.toString() : typeof v === 'string' && v ? v : null;
