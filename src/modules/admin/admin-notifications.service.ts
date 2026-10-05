import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Connection, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { DeviceTokenService } from 'src/modules/notifications/device-token.service';
import { NotificationRenderer } from 'src/modules/notifications/notification.renderer';
import { NotificationService } from 'src/modules/notifications/notification.service';
import {
  NOTIFICATION_SPECS,
  NotificationChannel,
  NotificationType,
} from 'src/modules/notifications/notification.types';
import {
  at,
  id,
  listAll,
  listPage,
  loadDoc,
  loadSection,
  num,
  refsIn,
  str,
  toCsv,
  type BaseListQuery,
  type Doc,
  type ExplorerRow,
  type ListSpec,
  type LoadedSection,
  type SectionSpec,
} from './admin-explorer.util';
import { pageOf, type AdminPage } from './admin-query.util';
import { AdminUser360Service, maskValue } from './admin-user360.service';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

/** The notification areas, as they appear in URLs. */
export const NOTIFICATION_KINDS = ['deliveries', 'devices'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationQuery extends BaseListQuery {
  type?: string;
  channel?: string;
  status?: string;
  platform?: string;
  revoked?: 'yes' | 'no';
}

/** Who a broadcast goes to. Every condition given must hold. */
export interface BroadcastSegment {
  city?: string;
  interest?: string;
  /** Signed in within this many days. */
  activeWithinDays?: number;
}

export interface BroadcastInput {
  title: string;
  body: string;
  url?: string;
  segment: BroadcastSegment;
}

/** The scheduler job that fans a broadcast out. */
export const ADMIN_BROADCAST_JOB = 'admin-broadcast';
/** How many people one enqueue round covers. */
const BROADCAST_BATCH = 500;

const SPECS: Record<NotificationKind, ListSpec<NotificationQuery>> = {
  deliveries: {
    collection: 'delivery_logs',
    search: ['refId', 'providerRef', 'error'],
    owner: 'userId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt' },
    filter: (q) => ({
      ...(q.type ? { type: q.type } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status ? { status: q.status } : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      userId: id(d.userId),
      type: str(d.type),
      channel: str(d.channel),
      status: str(d.status),
      // An address or a device token: masked, as everywhere else.
      destination: d.destination ? maskValue(String(d.destination)) : null,
      error: str(d.error),
      refId: str(d.refId),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['userId'],
  },
  devices: {
    collection: 'device_tokens',
    search: ['deviceName'],
    owner: 'userId',
    dateField: 'lastSeenAt',
    sorts: { seen: 'lastSeenAt', created: 'createdAt' },
    filter: (q) => ({
      ...(q.platform ? { platform: q.platform } : {}),
      ...(q.revoked === 'yes' ? { revokedAt: { $ne: null } } : {}),
      ...(q.revoked === 'no' ? { revokedAt: null } : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      userId: id(d.userId),
      platform: str(d.platform),
      deviceName: str(d.deviceName),
      lastSeenAt: at(d.lastSeenAt),
      revokedAt: at(d.revokedAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['userId'],
  },
};

const SECTIONS: Record<NotificationKind, Record<string, SectionSpec>> = {
  deliveries: {
    // The same notification on its other channels.
    siblings: {
      title: 'Same notification, other channels',
      collection: 'delivery_logs',
      filter: (p) => ({
        userId: p.userId as Types.ObjectId,
        type: str(p.type),
        refId: str(p.refId),
      }),
      view: (r) => SPECS.deliveries.row(r),
      userRefs: [],
    },
  },
  devices: {
    // Pushes do not record which device took them, so the person's pushes it is.
    pushes: {
      title: 'Recent pushes to this person',
      collection: 'delivery_logs',
      filter: (p) => ({ userId: p.userId as Types.ObjectId, channel: NotificationChannel.PUSH }),
      view: (r) => SPECS.deliveries.row(r),
      userRefs: [],
    },
  },
};

const strip = (s: LoadedSection) => {
  const { privateParts: _, ...rest } = s;
  void _;
  return rest;
};

/**
 * The notifications centre: what was sent to whom on which channel and how it
 * went, the devices that receive pushes, the addresses that bounce, every
 * notification's wording, a test send, and announcements to many people.
 */
@Injectable()
export class AdminNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(AdminNotificationsService.name);

  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
    private readonly registry: SchedulerRegistry,
    private readonly notifications: NotificationService,
    private readonly renderer: NotificationRenderer,
    private readonly devices: DeviceTokenService,
    private readonly user360: AdminUser360Service,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register(ADMIN_BROADCAST_JOB, (data) =>
      this.fanOut(String((data as { broadcastId?: unknown }).broadcastId)),
    );
  }

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  // ── Lists and records ──────────────────────────────────────────────────────

  async list(kind: NotificationKind, q: NotificationQuery) {
    const spec = SPECS[kind];
    const page = await listPage(this.db, spec, q);
    return {
      ...page,
      names: await this.user360.namesFor([...new Set(refsIn(page.items, spec.userRefs))]),
    };
  }

  async exportCsv(
    kind: NotificationKind,
    q: NotificationQuery,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<string> {
    const rows = await listAll(this.db, SPECS[kind], q);
    await this.audit.record({
      actor,
      action: 'notifications.export',
      targetType: kind,
      targetId: null,
      meta: { rows: rows.length, filters: q },
      ip,
    });
    return toCsv(rows);
  }

  async detail(kind: NotificationKind, rowId: string, admin: AuthenticatedAdmin) {
    const spec = SPECS[kind];
    const doc = await loadDoc(this.db, spec.collection, rowId);
    const sections = await Promise.all(
      Object.entries(SECTIONS[kind]).map(([key, s]) => loadSection(this.db, key, s, doc, true, 1)),
    );
    const row = spec.row(doc);
    return {
      kind,
      id: rowId,
      row,
      fields:
        kind === 'deliveries'
          ? {
              providerRef: str(doc.providerRef),
              dedupeKey: str(doc.dedupeKey),
              updatedAt: at(doc.updatedAt),
            }
          : { updatedAt: at(doc.updatedAt) },
      sections: sections.map(strip),
      names: await this.user360.namesFor([...new Set(refsIn([row], spec.userRefs))]),
      ...(admin.permissions.includes(AdminPermission.DEBUG_VIEW)
        ? { raw: { ...doc, token: doc.token ? maskValue(String(doc.token)) : undefined } }
        : {}),
    };
  }

  async section(kind: NotificationKind, rowId: string, key: string, page: number) {
    const spec = SECTIONS[kind][key];
    if (!spec) throw new AppException(ErrorCode.NOT_FOUND, 'No such section', 404);
    const doc = await loadDoc(this.db, SPECS[kind].collection, rowId);
    return {
      ...strip(await loadSection(this.db, key, spec, doc, true, Math.max(1, page))),
      names: {},
    };
  }

  /** The one action on a record: stop pushing to a device. */
  async act(
    kind: NotificationKind,
    rowId: string,
    action: string,
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ ok: true }> {
    if (kind !== 'devices' || action !== 'revoke') {
      throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'Unknown action', 400);
    }
    const doc = await loadDoc(this.db, 'device_tokens', rowId);
    if (doc.revokedAt) {
      throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'This device is already off', 409);
    }
    await this.devices.revoke([String(doc.token)]);
    await this.audit.record({
      actor,
      action: 'notifications.revoke_device',
      targetType: 'device',
      targetId: rowId,
      before: { revokedAt: null },
      after: { revokedAt: 'set' },
      meta: { reason, userId: id(doc.userId) },
      ip,
    });
    return { ok: true };
  }

  // ── How sending is going ───────────────────────────────────────────────────

  /**
   * The last [days] of deliveries: each channel's outcomes, the types that
   * fail most, and failures per day.
   */
  async overview(days = 30) {
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000);
    const logs = this.db.collection('delivery_logs');
    const [byChannel, byType, daily] = await Promise.all([
      logs
        .aggregate<{ _id: { c: string; s: string }; n: number }>([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: { c: '$channel', s: '$status' }, n: { $sum: 1 } } },
        ])
        .toArray(),
      logs
        .aggregate<{ _id: string; total: number; failed: number }>([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: '$type',
              total: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            },
          },
          { $sort: { failed: -1, total: -1 } },
        ])
        .toArray(),
      logs
        .aggregate<{ _id: string; sent: number; failed: number }>([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
    ]);

    const channels = new Map<string, Record<string, number>>();
    for (const r of byChannel) {
      const row = channels.get(r._id.c) ?? {};
      row[r._id.s] = r.n;
      channels.set(r._id.c, row);
    }
    return {
      days,
      byChannel: [...channels.entries()].map(([channel, counts]) => {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        return {
          channel,
          counts,
          total,
          failureRate: total ? Math.round(((counts.failed ?? 0) / total) * 10_000) / 100 : 0,
        };
      }),
      byType: byType.map((t) => ({
        type: t._id,
        total: t.total,
        failed: t.failed,
        failureRate: t.total ? Math.round((t.failed / t.total) * 10_000) / 100 : 0,
      })),
      daily: daily.map((d) => ({ day: d._id, sent: d.sent, failed: d.failed })),
    };
  }

  // ── Suppressions ───────────────────────────────────────────────────────────

  /**
   * Addresses that bounced or complained, per channel. Shown whole only to an
   * admin who may see contact details; masked otherwise, and then not removable.
   */
  async suppressions(admin: AuthenticatedAdmin) {
    const whole = admin.permissions.includes(AdminPermission.SENSITIVE_VIEW);
    const channels = [NotificationChannel.EMAIL, NotificationChannel.SMS];
    const lists = await Promise.all(channels.map((c) => this.notifications.listSuppressed(c)));
    return {
      revealed: whole,
      channels: channels.map((channel, i) => ({
        channel,
        total: lists[i].total,
        addresses: lists[i].addresses.map((a) => (whole ? a : maskValue(a)!)),
      })),
    };
  }

  async unsuppress(
    channel: NotificationChannel,
    address: string,
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ removed: boolean }> {
    if (![NotificationChannel.EMAIL, NotificationChannel.SMS].includes(channel)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Only email and SMS are suppressed', 400);
    }
    const removed = await this.notifications.unsuppress(channel, address);
    if (!removed) {
      throw new AppException(ErrorCode.NOT_FOUND, 'That address is not suppressed', 404);
    }
    await this.audit.record({
      actor,
      action: 'notifications.unsuppress',
      targetType: 'suppression',
      targetId: null,
      before: { suppressed: true },
      after: { suppressed: false },
      meta: { reason, channel, address: maskValue(address) },
      ip,
    });
    return { removed };
  }

  // ── Wording ────────────────────────────────────────────────────────────────

  templates() {
    return Object.entries(NOTIFICATION_SPECS).map(([type, spec]) => ({
      type,
      channels: spec.channels,
      priority: spec.priority,
      category: spec.category,
      template: spec.template,
    }));
  }

  /**
   * One notification rendered as people get it. [payload] fills the blanks;
   * left out, each type's own fallbacks show — the wording with placeholders.
   */
  async preview(type: string, payload: Record<string, unknown> = {}) {
    const t = this.typeOf(type);
    const rendered = await this.renderer.render(t, payload, { unsubscribeUrl: null });
    return { type: t, ...rendered };
  }

  /** Sends one notification to one person, now — to see it arrive. */
  async testSend(
    type: string,
    userId: string,
    payload: Record<string, unknown>,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ queued: true; refId: string }> {
    const t = this.typeOf(type);
    if (
      !Types.ObjectId.isValid(userId) ||
      !(await this.db.collection('users').findOne({ _id: new Types.ObjectId(userId) }))
    ) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such person', 404);
    }
    const refId = `admin-test-${Date.now()}`;
    await this.notifications.enqueue({ userId, type: t, refId, payload });
    await this.audit.record({
      actor,
      action: 'notifications.test_send',
      targetType: 'user',
      targetId: userId,
      meta: { type: t, refId },
      ip,
    });
    return { queued: true, refId };
  }

  private typeOf(type: string): NotificationType {
    if (!(Object.values(NotificationType) as string[]).includes(type)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such notification', 404);
    }
    return type as NotificationType;
  }

  // ── Announcements ──────────────────────────────────────────────────────────

  /** The users a segment covers: active accounts meeting every condition. */
  private async segmentFilter(segment: BroadcastSegment): Promise<Doc> {
    const filter: Doc = { status: 'active', deletedAt: null };
    if (segment.activeWithinDays) {
      filter.lastLoginAt = { $gte: new Date(Date.now() - segment.activeWithinDays * 86_400_000) };
    }
    if (segment.city || segment.interest) {
      const profileFilter: Doc = {};
      if (segment.city) {
        profileFilter.city = {
          $regex: `^${segment.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          $options: 'i',
        };
      }
      if (segment.interest) profileFilter['preferences.interests'] = segment.interest;
      const userIds = await this.db.collection('user_profiles').distinct('userId', profileFilter);
      filter._id = { $in: userIds };
    }
    return filter;
  }

  /** How many people a segment reaches — before anything is sent. */
  async dryRun(segment: BroadcastSegment): Promise<{ count: number }> {
    return {
      count: await this.db.collection('users').countDocuments(await this.segmentFilter(segment)),
    };
  }

  /**
   * Records an announcement and queues it. The fan-out runs as a job, in
   * batches, so a large audience never rides on one request.
   */
  async broadcast(input: BroadcastInput, actor: AuthenticatedAdmin, ip: string | null) {
    const { count } = await this.dryRun(input.segment);
    if (count === 0) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Nobody matches that audience', 400);
    }
    const _id = new Types.ObjectId();
    await this.db.collection('admin_broadcasts').insertOne({
      _id,
      title: input.title,
      body: input.body,
      url: input.url ?? null,
      segment: input.segment,
      audience: count,
      enqueued: 0,
      status: 'queued',
      createdBy: new Types.ObjectId(actor.id),
      createdByEmail: actor.email,
      createdAt: new Date(),
      finishedAt: null,
    });
    await this.scheduler.add(
      ADMIN_BROADCAST_JOB,
      { broadcastId: _id.toString() },
      { jobId: `admin-broadcast-${_id.toString()}`, removeOnComplete: true },
    );
    await this.audit.record({
      actor,
      action: 'notifications.broadcast',
      targetType: 'broadcast',
      targetId: _id.toString(),
      after: { title: input.title, audience: count },
      meta: { segment: input.segment },
      ip,
    });
    return { id: _id.toString(), audience: count };
  }

  async broadcasts(page?: number, limit?: number): Promise<AdminPage<ExplorerRow>> {
    const p = pageOf(page, limit);
    const col = this.db.collection('admin_broadcasts');
    const [docs, total] = await Promise.all([
      col
        .find({})
        .sort({ createdAt: -1 })
        .skip((p.page - 1) * p.limit)
        .limit(p.limit)
        .toArray(),
      col.countDocuments({}),
    ]);
    return {
      items: docs.map((d) => ({
        id: id(d._id)!,
        title: str(d.title),
        body: str(d.body),
        url: str(d.url),
        segment: (d.segment ?? {}) as Record<string, unknown>,
        audience: num(d.audience) ?? 0,
        enqueued: num(d.enqueued) ?? 0,
        status: str(d.status),
        createdByEmail: str(d.createdByEmail),
        createdAt: at(d.createdAt),
        finishedAt: at(d.finishedAt),
      })),
      total,
      page: p.page,
      limit: p.limit,
    };
  }

  /**
   * The job: everyone in the segment gets the announcement, a batch at a time.
   * Each person's notification is keyed by the broadcast, so a retried job
   * re-enqueues people already queued without sending them a second copy.
   */
  async fanOut(broadcastId: string): Promise<{ enqueued: number }> {
    const col = this.db.collection('admin_broadcasts');
    const b = Types.ObjectId.isValid(broadcastId)
      ? await col.findOne({ _id: new Types.ObjectId(broadcastId) })
      : null;
    if (!b || b.status === 'sent') return { enqueued: 0 };
    await col.updateOne({ _id: b._id }, { $set: { status: 'sending' } });

    const filter = await this.segmentFilter((b.segment ?? {}) as BroadcastSegment);
    const cursor = this.db.collection('users').find(filter).project({ _id: 1 });
    let enqueued = 0;
    let batch: string[] = [];
    const flush = async () => {
      await Promise.all(
        batch.map((userId) =>
          this.notifications.enqueue({
            userId,
            type: NotificationType.ADMIN_ANNOUNCEMENT,
            refId: broadcastId,
            payload: { title: b.title, body: b.body, url: b.url ?? undefined },
          }),
        ),
      );
      enqueued += batch.length;
      batch = [];
      await col.updateOne({ _id: b._id }, { $set: { enqueued } });
    };
    for await (const u of cursor) {
      batch.push(String(u._id));
      if (batch.length >= BROADCAST_BATCH) await flush();
    }
    if (batch.length) await flush();
    await col.updateOne(
      { _id: b._id },
      { $set: { status: 'sent', enqueued, finishedAt: new Date() } },
    );
    this.logger.log(`Broadcast ${broadcastId} queued for ${enqueued} people`);
    return { enqueued };
  }
}
