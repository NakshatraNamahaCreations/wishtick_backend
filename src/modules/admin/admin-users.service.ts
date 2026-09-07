import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import {
  USER_FORCE_DISCONNECT,
  type UserForceDisconnectEvent,
} from 'src/common/events/domain-events';
import { UserStatus } from 'src/common/enums/user-role.enum';
import { TokenService } from 'src/modules/auth/services/token.service';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import type { AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

export interface UserAdminView {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  status: string;
  roles: string[];
  suspendedReason: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  acquisition: { source: string; ref: string | null; capturedAt: Date } | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly emitter: EventEmitter2,
  ) {}

  async list(query: {
    search?: string;
    status?: UserStatus;
    page?: number;
    limit?: number;
  }): Promise<{ items: UserAdminView[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(query.limit ?? 25, 100);
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.search) {
      const rx = new RegExp(AdminUsersService.escapeRegex(query.search), 'i');
      filter.$or = [{ email: rx }, { phone: rx }, { name: rx }];
    }
    const [rows, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return { items: rows.map((r) => AdminUsersService.toView(r)), total, page, limit };
  }

  /** Full profile + cross-collection counts + a recent-activity timeline. */
  async getDetail(userId: string): Promise<
    UserAdminView & {
      counts: Record<string, number>;
      activity: { type: string; at: Date; summary: string }[];
    }
  > {
    const user = await this.loadUser(userId);
    const uid = user._id;
    const db = this.userModel.db;
    const [wishlists, events, giftsGiven, giftsReceived, reels] = await Promise.all([
      db.collection('wishlists').countDocuments({ ownerId: uid }),
      db.collection('events').countDocuments({ hostId: uid }),
      db.collection('gifts').countDocuments({ gifterId: uid }),
      db.collection('gifts').countDocuments({ recipientId: uid }),
      db.collection('reel_collections').countDocuments({ initiatorId: uid }),
    ]);

    // A small, recent, cross-domain activity list for support triage.
    const recentGifts = await db
      .collection('gifts')
      .find({ gifterId: uid })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    const recentWishlists = await db
      .collection('wishlists')
      .find({ ownerId: uid })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    const activity = [
      ...recentGifts.map((g) => ({
        type: 'gift',
        at: g.createdAt as Date,
        summary: `Gift ${String(g.status)}`,
      })),
      ...recentWishlists.map((w) => ({
        type: 'wishlist',
        at: w.createdAt as Date,
        summary: `Wishlist "${String(w.title)}"`,
      })),
    ]
      .filter((a) => a.at)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 10);

    return {
      ...AdminUsersService.toView(user),
      counts: { wishlists, events, giftsGiven, giftsReceived, reels },
      activity,
    };
  }

  // ── Mutations (each audited) ─────────────────────────────────────────────────

  async suspend(
    userId: string,
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<UserAdminView> {
    const user = await this.loadUser(userId);
    const before = { status: user.status, suspendedReason: user.suspendedReason };
    user.status = UserStatus.SUSPENDED;
    user.suspendedReason = reason;
    user.tokensInvalidBefore = new Date();
    await user.save();
    await this.killSessions(user._id, reason, 'admin_suspend');
    await this.audit.record({
      actor,
      action: 'user.suspend',
      targetType: 'user',
      targetId: userId,
      before,
      after: { status: UserStatus.SUSPENDED, suspendedReason: reason },
      meta: { reason },
      ip,
    });
    return AdminUsersService.toView(user);
  }

  async reactivate(
    userId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<UserAdminView> {
    const user = await this.loadUser(userId);
    const before = { status: user.status, suspendedReason: user.suspendedReason };
    user.status = UserStatus.ACTIVE;
    user.suspendedReason = null;
    await user.save();
    await this.audit.record({
      actor,
      action: 'user.reactivate',
      targetType: 'user',
      targetId: userId,
      before,
      after: { status: UserStatus.ACTIVE, suspendedReason: null },
      ip,
    });
    return AdminUsersService.toView(user);
  }

  async forceLogout(
    userId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<UserAdminView> {
    const user = await this.loadUser(userId);
    const before = { tokensInvalidBefore: user.tokensInvalidBefore };
    user.tokensInvalidBefore = new Date();
    await user.save();
    await this.killSessions(user._id, 'Forced logout by an administrator', 'admin_force_logout');
    await this.audit.record({
      actor,
      action: 'user.force_logout',
      targetType: 'user',
      targetId: userId,
      before,
      after: { tokensInvalidBefore: user.tokensInvalidBefore },
      ip,
    });
    return AdminUsersService.toView(user);
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async killSessions(
    userId: Types.ObjectId,
    reason: string,
    revokeReason: string,
  ): Promise<void> {
    await this.tokens.revokeAllForUser(userId, revokeReason);
    // Drop live sockets so a websocket cannot outlive the revocation.
    this.emitter.emit(USER_FORCE_DISCONNECT, {
      userId: userId.toString(),
      reason,
    } satisfies UserForceDisconnectEvent);
  }

  private async loadUser(userId: string): Promise<UserDocument> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    }
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    return user;
  }

  private static toView(user: UserDocument): UserAdminView {
    return {
      id: user._id.toString(),
      email: user.email ?? null,
      phone: user.phone ?? null,
      name: user.name ?? null,
      status: user.status,
      roles: user.roles,
      suspendedReason: user.suspendedReason,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      acquisition: user.acquisition
        ? {
            source: user.acquisition.source,
            ref: user.acquisition.ref,
            capturedAt: user.acquisition.capturedAt,
          }
        : null,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  private static escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
