import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { CacheService } from 'src/infra/redis/cache.service';
import { MAILER, type IMailer } from 'src/infra/notifier/mailer.port';
import { PUSH_SENDER, type IPushSender } from 'src/infra/notifier/push.port';
import { SMS_SENDER, type ISmsSender } from 'src/infra/notifier/sms.port';
import { UsersService } from 'src/modules/users/users.service';
import { DeviceTokenService } from './device-token.service';
import {
  NOTIFICATION_DISPATCH_JOB,
  dispatchJobId,
  type DispatchJobData,
} from './notification.jobs';
import { NotificationRenderer } from './notification.renderer';
import {
  DeliveryStatus,
  NOTIFICATION_SPECS,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  isCritical,
  isDigest,
  type NotificationSpec,
} from './notification.types';
import { DeliveryLog, type DeliveryLogDocument } from './schemas/delivery-log.schema';
import { Notification, type NotificationDocument } from './schemas/notification.schema';
import {
  NotificationPreference,
  type NotificationPreferenceDocument,
} from './schemas/notification-preference.schema';

export interface NotificationRequest {
  userId: string;
  type: NotificationType;
  refId: string;
  payload: Record<string, unknown>;
}

const deliveryDedupe = (userId: string, type: string, refId: string, channel: string): string =>
  `${userId}:${type}:${refId}:${channel}`;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(NotificationPreference.name)
    private readonly prefModel: Model<NotificationPreferenceDocument>,
    @InjectModel(DeliveryLog.name)
    private readonly deliveryModel: Model<DeliveryLogDocument>,
    @InjectQueue(QUEUE.NOTIFICATIONS) private readonly queue: Queue,
    @Inject(MAILER) private readonly mailer: IMailer,
    @Inject(SMS_SENDER) private readonly sms: ISmsSender,
    @Inject(PUSH_SENDER) private readonly push: IPushSender,
    private readonly devices: DeviceTokenService,
    private readonly renderer: NotificationRenderer,
    private readonly users: UsersService,
    private readonly cache: CacheService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ── Enqueue (from the listener) ─────────────────────────────────────────────

  /**
   * Enqueue a dispatch job. Stable `jobId` means a burst of the same (user, type,
   * ref) coalesces to one queued job — the fast, cheap first line of dedupe in
   * front of the durable per-channel ledger.
   */
  async enqueue(req: NotificationRequest): Promise<void> {
    await this.queue.add(NOTIFICATION_DISPATCH_JOB, req satisfies DispatchJobData, {
      jobId: dispatchJobId(req.userId, req.type, req.refId),
      removeOnComplete: true,
    });
  }

  // ── Dispatch (from the processor) ───────────────────────────────────────────

  /**
   * Fan one notification out across its channels. Single-stage on purpose: the
   * per-channel DeliveryLog claim makes the whole job idempotent, so a BullMQ
   * retry re-runs this and every already-delivered channel is skipped — nothing
   * sends twice. Quiet hours defer a channel by re-enqueuing it delayed; digest
   * types skip immediate email for the daily roll-up; in-app always lands.
   */
  async dispatch(data: DispatchJobData): Promise<void> {
    const spec = NOTIFICATION_SPECS[data.type];
    const pref = await this.getOrCreatePreference(data.userId);
    const channels = data.onlyChannel ? [data.onlyChannel] : spec.channels;

    for (const channel of channels) {
      if (channel === NotificationChannel.IN_APP) {
        await this.createInApp(data, spec);
        continue;
      }
      if (!this.channelEnabled(pref, spec, channel)) {
        await this.record(data, channel, DeliveryStatus.SUPPRESSED, { error: 'preference-off' });
        continue;
      }
      // Push resolves to a *set* of device tokens rather than one address, so
      // it takes its own path out of the address plumbing below.
      if (channel === NotificationChannel.PUSH) {
        if (!isCritical(data.type) && this.inQuietHours(pref)) {
          await this.deferChannel(data, channel, pref);
          await this.record(data, channel, DeliveryStatus.DEFERRED, {});
          continue;
        }
        await this.sendPush(data);
        continue;
      }
      const address = await this.resolveAddress(data.userId, channel);
      if (!address) {
        await this.record(data, channel, DeliveryStatus.SUPPRESSED, { error: 'no-address' });
        continue;
      }
      if (await this.isSuppressed(channel, address)) {
        await this.record(data, channel, DeliveryStatus.SUPPRESSED, {
          destination: address,
          error: 'undeliverable',
        });
        continue;
      }
      // Digest-type email rolls into the daily digest instead of sending now.
      if (channel === NotificationChannel.EMAIL && isDigest(data.type) && !data.onlyChannel) {
        await this.record(data, channel, DeliveryStatus.DIGESTED, { destination: address });
        continue;
      }
      // Quiet hours: defer non-critical email/SMS to the end of the window.
      if (!isCritical(data.type) && this.inQuietHours(pref)) {
        await this.deferChannel(data, channel, pref);
        await this.record(data, channel, DeliveryStatus.DEFERRED, { destination: address });
        continue;
      }
      await this.sendChannel(data, spec, pref, channel, address);
    }
  }

  /**
   * Pushes to every live device this person has.
   *
   * A person with no registered device is not a failure — most are signed in on
   * the web, or have not granted the permission — so it records SUPPRESSED and
   * moves on. Tokens the provider rejects are revoked here, which is the only
   * thing that keeps the registry from filling with dead addresses.
   */
  private async sendPush(data: DispatchJobData): Promise<void> {
    const tokens = await this.devices.liveTokensFor(data.userId);
    if (tokens.length === 0) {
      await this.record(data, NotificationChannel.PUSH, DeliveryStatus.SUPPRESSED, {
        error: 'no-device',
      });
      return;
    }

    const { title, text } = this.renderer.content(data.type, data.payload);
    try {
      const result = await this.push.send({
        tokens,
        title,
        body: text.split('\n')[0],
        // FCM data values must be strings; the app routes on these two.
        data: { type: data.type, refId: data.refId },
      });
      await this.devices.revoke(result.unregistered);
      await this.record(data, NotificationChannel.PUSH, DeliveryStatus.SENT, {});
    } catch (err) {
      await this.record(data, NotificationChannel.PUSH, DeliveryStatus.FAILED, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // let BullMQ retry with backoff
    }
  }

  private async sendChannel(
    data: DispatchJobData,
    spec: NotificationSpec,
    pref: NotificationPreferenceDocument,
    channel: NotificationChannel,
    address: string,
  ): Promise<void> {
    const dedupeKey = deliveryDedupe(data.userId, data.type, data.refId, channel);
    // Claim: insert QUEUED. A duplicate that is already SENT means delivered —
    // skip. A duplicate in any other state is a prior attempt of THIS job; re-send.
    let log: DeliveryLogDocument | null;
    try {
      log = await this.deliveryModel.create({
        userId: new Types.ObjectId(data.userId),
        type: data.type,
        channel,
        refId: data.refId,
        dedupeKey,
        status: DeliveryStatus.QUEUED,
        destination: address,
      });
    } catch (err) {
      if (!NotificationService.isDuplicateKey(err)) throw err;
      log = await this.deliveryModel.findOne({ dedupeKey }).exec();
      if (!log || log.status === DeliveryStatus.SENT) return;
    }

    try {
      const rendered = await this.renderer.render(data.type, data.payload, {
        unsubscribeUrl: this.unsubscribeUrl(pref, spec.category),
      });
      if (channel === NotificationChannel.EMAIL) {
        await this.mailer.send({
          to: address,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });
      } else {
        await this.sms.send({ to: address, body: rendered.sms });
      }
      log.status = DeliveryStatus.SENT;
      log.error = null;
      await log.save();
    } catch (err) {
      log.status = DeliveryStatus.FAILED;
      log.error = err instanceof Error ? err.message : String(err);
      await log.save();
      throw err; // let BullMQ retry with backoff
    }
  }

  private async createInApp(data: DispatchJobData, spec: NotificationSpec): Promise<void> {
    const { title, text } = this.renderer.content(data.type, data.payload);
    try {
      await this.notificationModel.create({
        userId: new Types.ObjectId(data.userId),
        type: data.type,
        category: spec.category,
        title,
        body: text.split('\n')[0],
        payload: data.payload,
        refId: data.refId,
        channels: [NotificationChannel.IN_APP],
        dedupeKey: `${data.type}:${data.refId}`,
      });
    } catch (err) {
      // A retried dispatch hits the unique (userId, dedupeKey) — already created.
      if (NotificationService.isDuplicateKey(err)) return;
      throw err;
    }
    await this.record(data, NotificationChannel.IN_APP, DeliveryStatus.SENT, {});
  }

  private async deferChannel(
    data: DispatchJobData,
    channel: NotificationChannel,
    pref: NotificationPreferenceDocument,
  ): Promise<void> {
    const delay = this.msUntilHour(pref.timezone, this.quietWindow(pref).endHour);
    await this.queue.add(
      NOTIFICATION_DISPATCH_JOB,
      { ...data, onlyChannel: channel } satisfies DispatchJobData,
      {
        delay,
        jobId: `${dispatchJobId(data.userId, data.type, data.refId)}-${channel}-deferred`,
        removeOnComplete: true,
      },
    );
  }

  private async record(
    data: DispatchJobData,
    channel: NotificationChannel,
    status: DeliveryStatus,
    extra: { destination?: string; error?: string },
  ): Promise<void> {
    const dedupeKey = deliveryDedupe(data.userId, data.type, data.refId, channel);
    await this.deliveryModel
      .updateOne(
        { dedupeKey },
        {
          $set: { status, destination: extra.destination ?? null, error: extra.error ?? null },
          $setOnInsert: {
            userId: new Types.ObjectId(data.userId),
            type: data.type,
            channel,
            refId: data.refId,
          },
        },
        { upsert: true },
      )
      .exec();
  }

  // ── In-app notifications (the dashboard section) ────────────────────────────

  async list(userId: string, limit = 50): Promise<NotificationDocument[]> {
    return this.notificationModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async markRead(userId: string, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(ErrorCode.NOTIFICATION_NOT_FOUND, 'Notification not found', 404);
    }
    const res = await this.notificationModel
      .updateOne(
        { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId), readAt: null },
        { $set: { readAt: new Date() } },
      )
      .exec();
    if (res.matchedCount === 0) {
      // Either it does not exist, is not theirs, or was already read — all a no-op
      // to the client, but 404 when the row simply is not theirs to see.
      const exists = await this.notificationModel.exists({
        _id: new Types.ObjectId(id),
        userId: new Types.ObjectId(userId),
      });
      if (!exists) {
        throw new AppException(ErrorCode.NOTIFICATION_NOT_FOUND, 'Notification not found', 404);
      }
    }
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.notificationModel
      .updateMany(
        { userId: new Types.ObjectId(userId), readAt: null },
        { $set: { readAt: new Date() } },
      )
      .exec();
    return { updated: res.modifiedCount };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notificationModel
      .countDocuments({ userId: new Types.ObjectId(userId), readAt: null })
      .exec();
  }

  /** The dashboard NOTIFICATIONS section: total count + unread badge. */
  async sectionCounts(userId: string): Promise<{ count: number; badge: number }> {
    const [count, badge] = await Promise.all([
      this.notificationModel.countDocuments({ userId: new Types.ObjectId(userId) }).exec(),
      this.unreadCount(userId),
    ]);
    return { count, badge };
  }

  // ── Preferences + unsubscribe ───────────────────────────────────────────────

  async getOrCreatePreference(userId: string): Promise<NotificationPreferenceDocument> {
    const uid = new Types.ObjectId(userId);
    const existing = await this.prefModel.findOne({ userId: uid }).exec();
    if (existing) return existing;
    try {
      return await this.prefModel.create({
        userId: uid,
        unsubscribeToken: randomBytes(24).toString('base64url'),
      });
    } catch (err) {
      if (NotificationService.isDuplicateKey(err)) {
        const raced = await this.prefModel.findOne({ userId: uid }).exec();
        if (raced) return raced;
      }
      throw err;
    }
  }

  async updatePreference(
    userId: string,
    input: {
      disabled?: string[];
      timezone?: string;
      quietHours?: { enabled?: boolean; startHour?: number | null; endHour?: number | null };
      thankYouAutoSend?: boolean;
    },
  ): Promise<NotificationPreferenceDocument> {
    const pref = await this.getOrCreatePreference(userId);
    if (input.disabled) pref.disabled = [...new Set(input.disabled)];
    if (input.timezone) pref.timezone = input.timezone;
    if (input.quietHours) {
      if (input.quietHours.enabled !== undefined)
        pref.quietHours.enabled = input.quietHours.enabled;
      if (input.quietHours.startHour !== undefined)
        pref.quietHours.startHour = input.quietHours.startHour;
      if (input.quietHours.endHour !== undefined)
        pref.quietHours.endHour = input.quietHours.endHour;
    }
    if (input.thankYouAutoSend !== undefined) pref.thankYouAutoSend = input.thankYouAutoSend;
    await pref.save();
    return pref;
  }

  /** Public unsubscribe: turns off a category's email. Takes effect immediately. */
  async unsubscribeByToken(token: string, category: NotificationCategory): Promise<void> {
    const key = `${category}:${NotificationChannel.EMAIL}`;
    const res = await this.prefModel
      .updateOne({ unsubscribeToken: token }, { $addToSet: { disabled: key } })
      .exec();
    if (res.matchedCount === 0) {
      throw new AppException(
        ErrorCode.UNSUBSCRIBE_TOKEN_INVALID,
        'This unsubscribe link is invalid',
        404,
      );
    }
  }

  // ── Suppression (bounces/complaints) ────────────────────────────────────────

  async suppress(channel: NotificationChannel, address: string): Promise<void> {
    await this.cache.client.sadd(NotificationService.suppressKey(channel), address.toLowerCase());
  }

  private async isSuppressed(channel: NotificationChannel, address: string): Promise<boolean> {
    const member = await this.cache.client.sismember(
      NotificationService.suppressKey(channel),
      address.toLowerCase(),
    );
    return member === 1;
  }

  // ── Daily digest (the repeatable job) ───────────────────────────────────────

  /**
   * Once a day, roll every digest-type notification from the last 24h into one
   * summary email per user — the low-signal traffic that would otherwise be a
   * drip of separate mails. Best-effort and idempotent enough for a daily cron:
   * running it twice in a day just re-sends the same summary.
   */
  async runDailyDigest(): Promise<{ sent: number }> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const digestTypes = Object.values(NotificationType).filter(isDigest);
    const groups = await this.notificationModel
      .aggregate<{ _id: Types.ObjectId; titles: string[]; count: number }>([
        { $match: { type: { $in: digestTypes }, createdAt: { $gte: since } } },
        { $group: { _id: '$userId', titles: { $push: '$title' }, count: { $sum: 1 } } },
      ])
      .exec();

    let sent = 0;
    for (const g of groups) {
      const user = await this.users.findById(g._id.toString());
      if (!user?.email || (await this.isSuppressed(NotificationChannel.EMAIL, user.email)))
        continue;
      const text =
        "Here's a summary of recent activity on Wishtick:\n\n" +
        g.titles.map((t) => `• ${t}`).join('\n');
      try {
        await this.mailer.send({ to: user.email, subject: `Your Wishtick digest`, text });
        sent += 1;
      } catch (err) {
        this.logger.error(`Digest email to ${user.email} failed: ${String(err)}`);
      }
    }
    return { sent };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private channelEnabled(
    pref: NotificationPreferenceDocument,
    spec: NotificationSpec,
    channel: NotificationChannel,
  ): boolean {
    // You cannot mute a security email — the one channel that must always reach you.
    if (channel === NotificationChannel.EMAIL && spec.priority === NotificationPriority.CRITICAL) {
      return true;
    }
    return !pref.disabled.includes(`${spec.category}:${channel}`);
  }

  private async resolveAddress(
    userId: string,
    channel: NotificationChannel,
  ): Promise<string | null> {
    const user = await this.users.findById(userId);
    if (!user) return null;
    return channel === NotificationChannel.EMAIL ? (user.email ?? null) : (user.phone ?? null);
  }

  private unsubscribeUrl(
    pref: NotificationPreferenceDocument,
    category: NotificationCategory,
  ): string {
    const webUrl = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
    return `${webUrl}/unsubscribe?token=${pref.unsubscribeToken}&category=${category}`;
  }

  private quietWindow(pref?: NotificationPreferenceDocument): {
    startHour: number;
    endHour: number;
  } {
    const cfg = this.config.get('notifications', { infer: true });
    return {
      startHour: pref?.quietHours.startHour ?? cfg.quietHoursStart,
      endHour: pref?.quietHours.endHour ?? cfg.quietHoursEnd,
    };
  }

  private inQuietHours(pref: NotificationPreferenceDocument): boolean {
    if (!pref.quietHours.enabled) return false;
    const { startHour, endHour } = this.quietWindow(pref);
    if (startHour === endHour) return false;
    const h = NotificationService.hourInZone(pref.timezone, new Date());
    return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
  }

  /** ms until the next occurrence of `hour:00` in the given zone. */
  private msUntilHour(tz: string, hour: number): number {
    const now = new Date();
    const h = NotificationService.hourInZone(tz, now);
    const m = NotificationService.minuteInZone(tz, now);
    let minutes = ((hour - h + 24) % 24) * 60 - m;
    if (minutes <= 0) minutes += 24 * 60;
    return minutes * 60 * 1000;
  }

  private static hourInZone(tz: string, at: Date): number {
    const v = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).format(at);
    return parseInt(v, 10) % 24;
  }

  private static minuteInZone(tz: string, at: Date): number {
    const v = new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: 'numeric' }).format(at);
    return parseInt(v, 10);
  }

  private static suppressKey(channel: NotificationChannel): string {
    return `notif:suppressed:${channel}`;
  }

  private static isDuplicateKey(err: unknown): boolean {
    return (err as { code?: number })?.code === 11000;
  }
}
