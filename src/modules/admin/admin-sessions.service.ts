import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { AdminTokenService } from './admin-token.service';
import { permissionsFor, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';
import { Admin, type AdminDocument } from './schemas/admin.schema';
import { AdminSession, type AdminSessionDocument } from './schemas/admin-session.schema';

export interface AdminSessionView {
  id: string;
  ip: string | null;
  userAgent: string | null;
  startedAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
  endedBy: string | null;
  active: boolean;
}

/** An admin as the actor of their own sign-in, for the audit log. */
const asActor = (admin: AdminDocument, jti: string): AuthenticatedAdmin => ({
  id: admin._id.toString(),
  email: admin.email,
  name: admin.name,
  roles: admin.roles,
  permissions: permissionsFor(admin.roles),
  jti,
});

/**
 * Admin sessions: recorded at sign-in, touched while used, and ended by
 * sign-out, by another admin, by "log out everywhere", or by a password reset.
 * Signing in and out are audited, as is every session another admin ends.
 */
@Injectable()
export class AdminSessionsService {
  constructor(
    @InjectModel(AdminSession.name) private readonly model: Model<AdminSessionDocument>,
    @InjectModel(Admin.name) private readonly admins: Model<AdminDocument>,
    private readonly tokens: AdminTokenService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async start(
    admin: AdminDocument,
    jti: string,
    expiresInSeconds: number,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    const now = new Date();
    await this.model.create({
      adminId: admin._id,
      jti,
      ip,
      userAgent: userAgent?.slice(0, 300) ?? null,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      lastSeenAt: now,
    });
    await this.audit.record({
      actor: asActor(admin, jti),
      action: 'admin.login',
      targetType: 'admin',
      targetId: admin._id.toString(),
      meta: { userAgent: userAgent?.slice(0, 200) ?? null },
      ip,
    });
  }

  /** Marks the session used — at most once a minute, so a busy page costs nothing. */
  async touch(jti: string): Promise<void> {
    try {
      const first = await this.cache.client.set(`admin:seen:${jti}`, '1', 'EX', 60, 'NX');
      if (first === 'OK') {
        await this.model.updateOne({ jti, endedAt: null }, { $set: { lastSeenAt: new Date() } });
      }
    } catch {
      // "Last active" is a convenience; it must never fail a request.
    }
  }

  /** The admin signing themselves out. */
  async signedOut(actor: AuthenticatedAdmin, ip: string | null): Promise<void> {
    await this.model.updateOne(
      { jti: actor.jti, endedAt: null },
      { $set: { endedAt: new Date(), endedReason: 'logout', endedBy: actor.email } },
    );
    await this.audit.record({
      actor,
      action: 'admin.logout',
      targetType: 'admin',
      targetId: actor.id,
      ip,
    });
  }

  /** Active sessions first, then the last 20 that ended or expired. */
  async list(adminId: string): Promise<{ active: AdminSessionView[]; recent: AdminSessionView[] }> {
    const admin = await this.adminOf(adminId);
    const docs = await this.model
      .find({ adminId: admin._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .exec();
    const views = docs.map((d) => this.view(d, admin));
    return {
      active: views.filter((v) => v.active),
      recent: views.filter((v) => !v.active).slice(0, 20),
    };
  }

  /** Ends one session now: its token stops working on the next request. */
  async end(
    adminId: string,
    sessionId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<AdminSessionView> {
    const admin = await this.adminOf(adminId);
    const session = Types.ObjectId.isValid(sessionId)
      ? await this.model.findOne({ _id: new Types.ObjectId(sessionId), adminId: admin._id }).exec()
      : null;
    if (!session) throw new AppException(ErrorCode.NOT_FOUND, 'No such session', 404);
    if (!this.view(session, admin).active) {
      throw new AppException(ErrorCode.CONFLICT, 'That session has already ended', 409);
    }
    await this.tokens.denylist(session.jti, Math.floor(session.expiresAt.getTime() / 1000));
    session.endedAt = new Date();
    session.endedReason = 'ended_by_admin';
    session.endedBy = actor.email;
    await session.save();
    await this.audit.record({
      actor,
      action: 'admin.session_end',
      targetType: 'admin',
      targetId: adminId,
      meta: { sessionId, sessionIp: session.ip, startedAt: session.createdAt },
      ip,
    });
    return this.view(session, admin);
  }

  /** Ends every session the admin holds, including any not recorded here. */
  async logoutAll(
    adminId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ ended: number }> {
    const admin = await this.adminOf(adminId);
    admin.tokensInvalidBefore = new Date();
    await admin.save();
    const ended = await this.endAllFor(admin._id, 'logout_all', actor.email);
    await this.audit.record({
      actor,
      action: 'admin.logout_all',
      targetType: 'admin',
      targetId: adminId,
      meta: { sessionsEnded: ended },
      ip,
    });
    return { ended };
  }

  /** Marks every open session ended — the token cutoff has already done the real work. */
  async endAllFor(adminId: Types.ObjectId, reason: string, by: string | null): Promise<number> {
    const res = await this.model.updateMany(
      { adminId, endedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { endedAt: new Date(), endedReason: reason, endedBy: by } },
    );
    return res.modifiedCount;
  }

  private async adminOf(adminId: string): Promise<AdminDocument> {
    const admin = Types.ObjectId.isValid(adminId)
      ? await this.admins.findById(adminId).exec()
      : null;
    if (!admin) throw new AppException(ErrorCode.ADMIN_NOT_FOUND, 'Admin not found', 404);
    return admin;
  }

  private view(d: AdminSessionDocument, admin: AdminDocument): AdminSessionView {
    const cutoff = admin.tokensInvalidBefore?.getTime() ?? 0;
    const active =
      !d.endedAt && d.expiresAt.getTime() > Date.now() && d.createdAt.getTime() >= cutoff;
    return {
      id: d._id.toString(),
      ip: d.ip,
      userAgent: d.userAgent,
      startedAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      expiresAt: d.expiresAt,
      endedAt: d.endedAt,
      endedReason: d.endedAt
        ? d.endedReason
        : d.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : null,
      endedBy: d.endedBy,
      active,
    };
  }
}
