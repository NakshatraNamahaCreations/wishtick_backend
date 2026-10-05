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
import { dayRange, escapeRegex } from './admin-query.util';
import { maskValue } from './admin-user360.service';
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

export interface UserListQuery {
  search?: string;
  status?: UserStatus;
  verified?: 'email' | 'phone' | 'any' | 'none';
  source?: string;
  from?: string;
  to?: string;
  sort?: 'joined' | 'lastLogin' | 'name';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/** The most rows one export carries. */
const EXPORT_CAP = 50_000;

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly emitter: EventEmitter2,
  ) {}

  async list(query: UserListQuery): Promise<{
    items: UserAdminView[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(query.limit ?? 25, 100);
    const filter = await this.filterFor(query);
    const [rows, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort(AdminUsersService.sortFor(query))
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return { items: rows.map((r) => AdminUsersService.toView(r)), total, page, limit };
  }

  /**
   * The same filtered list as CSV, for spreadsheets — up to [EXPORT_CAP] rows,
   * contact details masked as on screen, and every export audited.
   */
  async exportCsv(
    query: UserListQuery,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<string> {
    const filter = await this.filterFor(query);
    const rows = await this.userModel
      .find(filter)
      .sort(AdminUsersService.sortFor(query))
      .limit(EXPORT_CAP)
      .exec();
    const header = [
      'id',
      'name',
      'email',
      'phone',
      'status',
      'emailVerified',
      'phoneVerified',
      'source',
      'joined',
      'lastLogin',
    ];
    const cell = (v: unknown): string => {
      const text =
        v === null || v === undefined
          ? ''
          : v instanceof Date
            ? v.toISOString()
            : typeof v === 'string'
              ? v
              : JSON.stringify(v);
      // Quote everything that could break a row, and neutralise a leading
      // = + - @ so a spreadsheet never runs a cell as a formula.
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = rows.map((u) => {
      const v = AdminUsersService.toView(u);
      return [
        v.id,
        v.name,
        v.email,
        v.phone,
        v.status,
        v.emailVerified,
        v.phoneVerified,
        v.acquisition?.source,
        v.createdAt,
        v.lastLoginAt,
      ]
        .map(cell)
        .join(',');
    });
    await this.audit.record({
      actor,
      action: 'user.export',
      targetType: 'user',
      targetId: 'list',
      meta: { rows: rows.length, filter: JSON.stringify(query) },
      ip,
    });
    return [header.join(','), ...lines].join('\n');
  }

  private async filterFor(query: UserListQuery): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.source) filter['acquisition.source'] = query.source;
    if (query.verified === 'email') filter.emailVerifiedAt = { $ne: null };
    else if (query.verified === 'phone') filter.phoneVerifiedAt = { $ne: null };
    else if (query.verified === 'any') {
      filter.$and = [
        { $or: [{ emailVerifiedAt: { $ne: null } }, { phoneVerifiedAt: { $ne: null } }] },
      ];
    } else if (query.verified === 'none') {
      filter.emailVerifiedAt = null;
      filter.phoneVerifiedAt = null;
    }
    const joined = dayRange(query.from, query.to);
    if (joined) filter.createdAt = joined;
    if (query.search) {
      const rx = new RegExp(escapeRegex(query.search.trim().replace(/^@/, '')), 'i');
      // A username lives on the profile, not the account.
      const viaProfile = await this.userModel.db
        .collection('user_profiles')
        .find({ $or: [{ username: rx }, { displayName: rx }] })
        .project({ userId: 1 })
        .limit(500)
        .toArray();
      const or: Record<string, unknown>[] = [
        { email: rx },
        { phone: rx },
        { name: rx },
        { _id: { $in: viaProfile.map((p) => p.userId as Types.ObjectId) } },
      ];
      if (
        Types.ObjectId.isValid(query.search.trim()) &&
        /^[a-f0-9]{24}$/i.test(query.search.trim())
      ) {
        or.push({ _id: new Types.ObjectId(query.search.trim()) });
      }
      filter.$or = or;
    }
    return filter;
  }

  private static sortFor(query: UserListQuery): Record<string, 1 | -1> {
    const dir = query.order === 'asc' ? 1 : -1;
    const field =
      query.sort === 'lastLogin' ? 'lastLoginAt' : query.sort === 'name' ? 'name' : 'createdAt';
    return { [field]: dir, _id: dir };
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
      // The shape, not the value — revealed one at a time, audited, on the
      // user's page.
      email: maskValue(user.email),
      phone: maskValue(user.phone),
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
}
