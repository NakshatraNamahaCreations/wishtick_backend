import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { Message, type MessageDocument } from 'src/modules/chat/schemas/message.schema';
import { EventStatus } from 'src/modules/events/event.types';
import { Event, type EventDocument } from 'src/modules/events/schemas/event.schema';
import { NotificationService } from 'src/modules/notifications/notification.service';
import { NotificationType } from 'src/modules/notifications/notification.types';
import {
  REEL_COMPILE_JOB,
  compileJobId,
  type ReelCompileJobData,
} from 'src/modules/reels/reel.jobs';
import { ModerationStatus, ReelStatus } from 'src/modules/reels/reel.types';
import {
  ReelCollection,
  type ReelCollectionDocument,
} from 'src/modules/reels/schemas/reel-collection.schema';
import { Wish, type WishDocument } from 'src/modules/reels/schemas/wish.schema';
import { Wishlist, type WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
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
    @InjectQueue(QUEUE.REELS) private readonly reelsQueue: Queue,
    private readonly users: AdminUsersService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

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
    page?: number;
    limit?: number;
  }): Promise<{ items: ReportDocument[]; total: number; page: number; limit: number }> {
    const query: Record<string, unknown> = {};
    query.status = filters.status ?? ReportStatus.OPEN;
    if (filters.targetType) query.targetType = filters.targetType;

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
    }
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
        resolution = resolution ?? 'Content approved — no action';
        break;
      case ModerationAction.REMOVE:
        await this.removeTarget(report, actor, ip, reason);
        report.status = ReportStatus.RESOLVED;
        resolution = resolution ?? 'Content removed';
        break;
      case ModerationAction.FLAG:
        report.status = ReportStatus.REVIEWING;
        resolution = resolution ?? 'Flagged for a second look';
        break;
      case ModerationAction.ESCALATE:
        report.severity += 5;
        report.status = ReportStatus.REVIEWING;
        resolution = resolution ?? 'Escalated';
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

  /** Takes the target down in the way that fits its kind, and notifies the owner. */
  private async removeTarget(
    report: ReportDocument,
    actor: AuthenticatedAdmin,
    ip: string | null,
    reason: string | null,
  ): Promise<void> {
    const id = report.targetId;
    let ownerId: string | null = null;

    switch (report.targetType) {
      case ReportTargetType.MESSAGE: {
        const msg = await this.messageModel.findById(id).exec();
        if (msg && !msg.deletedAt) {
          msg.deletedAt = new Date();
          await msg.save();
          ownerId = msg.senderId?.toString() ?? null;
        }
        break;
      }
      case ReportTargetType.WISH: {
        const wish = await this.wishModel.findById(id).exec();
        if (wish) {
          wish.moderationStatus = ModerationStatus.REJECTED;
          await wish.save();
          ownerId = wish.authorId?.toString() ?? null;
          await this.regenerateIfReleased(wish.collectionId.toString());
        }
        break;
      }
      case ReportTargetType.REEL: {
        // Take the compiled video down; the initiator can regenerate after review.
        const reel = await this.reelModel.findById(id).exec();
        if (reel) {
          reel.reelMediaUrl = null;
          await reel.save();
          ownerId = reel.initiatorId.toString();
        }
        break;
      }
      case ReportTargetType.WISHLIST: {
        const wl = await this.wishlistModel.findById(id).exec();
        if (wl && !wl.archivedAt) {
          wl.archivedAt = new Date();
          await wl.save();
          ownerId = wl.ownerId.toString();
        }
        break;
      }
      case ReportTargetType.EVENT: {
        const event = await this.eventModel.findById(id).exec();
        if (event) {
          ownerId = event.hostId.toString();
          await this.eventModel.updateOne({ _id: event._id }, { $set: { status: 'cancelled' } });
        }
        break;
      }
      case ReportTargetType.USER: {
        // Removing a person = suspend (which audits + kills their sessions).
        await this.users.suspend(id, reason ?? 'Removed after moderation review', actor, ip);
        return; // suspend already notified/audited the account; no content-owner notice
      }
    }

    if (ownerId) {
      await this.notifications.enqueue({
        userId: ownerId,
        type: NotificationType.CONTENT_REMOVED,
        refId: report._id.toString(),
        payload: { targetType: report.targetType, reason: reason ?? 'community guidelines' },
      });
    }
  }

  private async regenerateIfReleased(collectionId: string): Promise<void> {
    const reel = await this.reelModel.findById(collectionId).exec();
    if (!reel || reel.status !== ReelStatus.RELEASED) return;
    reel.status = ReelStatus.RELEASING;
    await reel.save();
    await this.reelsQueue.add(REEL_COMPILE_JOB, { collectionId } satisfies ReelCompileJobData, {
      jobId: compileJobId(collectionId),
      removeOnComplete: true,
    });
  }
}
