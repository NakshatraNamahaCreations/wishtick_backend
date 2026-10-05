import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { User, type UserDocument } from 'src/modules/users/schemas/user.schema';
import { pageOf, type AdminPage } from './admin-query.util';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

type Doc = mongo.Document;

/** One user's whole story, at a glance — the header of their admin page. */
export interface UserProfileAdminView {
  id: string;
  /** Masked unless the admin revealed it; see [reveal]. */
  email: string | null;
  phone: string | null;
  name: string | null;
  status: string;
  suspendedReason: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  acquisition: { source: string; ref: string | null; capturedAt: Date } | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  deletionReason: string | null;
  profile: {
    displayName: string | null;
    username: string | null;
    photoUrl: string | null;
    avatarKey: string | null;
    gender: string | null;
    bio: string | null;
    dateOfBirth: Date | null;
    timezone: string | null;
    city: string | null;
    country: string | null;
    hasUpi: boolean;
    onboardingCompletedAt: Date | null;
    preferences: Record<string, unknown>;
  } | null;
  counts: Record<string, number>;
}

/** A row of one section: its fields, as plain JSON. */
export type SectionRow = Record<string, unknown> & { id: string };

export interface SectionPage extends AdminPage<SectionRow> {
  /** Display names for every user id the rows mention, so the panel can link them. */
  names: Record<string, string>;
}

/** What a section reads, how, and who may see it. */
interface SectionSpec {
  collection: string;
  permission: AdminPermission;
  filter: (uid: Types.ObjectId) => Doc;
  sort: Doc;
  /** Fields that hold a user id, resolved to names for the panel. */
  userRefs?: string[];
  view: (doc: Doc) => SectionRow;
}

const id = (v: unknown): string | null =>
  v instanceof Types.ObjectId ? v.toString() : typeof v === 'string' && v ? v : null;
const at = (v: unknown): Date | null => (v instanceof Date ? v : null);

/** The sections of a user's page, by key. Each reads one collection. */
const SECTIONS: Record<string, SectionSpec> = {
  wishlists: {
    collection: 'wishlists',
    permission: AdminPermission.CONTENT_VIEW,
    filter: (uid) => ({ ownerId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      title: d.title,
      visibility: d.visibility,
      occasion: d.occasionLabel ?? null,
      forName: d.forName ?? null,
      forUserId: id(d.forUserId),
      eventId: id(d.eventId),
      items: (d.stats as { itemCount?: number } | undefined)?.itemCount ?? 0,
      fulfilled: (d.stats as { fulfilledCount?: number } | undefined)?.fulfilledCount ?? 0,
      archivedAt: at(d.archivedAt),
      createdAt: at(d.createdAt),
    }),
  },
  'gifts-given': {
    collection: 'gifts',
    permission: AdminPermission.MONEY_VIEW,
    filter: (uid) => ({ gifterId: uid, type: { $ne: 'self' } }),
    sort: { createdAt: -1 },
    userRefs: ['recipientId'],
    view: (d) => giftRow(d),
  },
  'gifts-received': {
    collection: 'gifts',
    permission: AdminPermission.MONEY_VIEW,
    filter: (uid) => ({ recipientId: uid, type: { $ne: 'self' } }),
    sort: { createdAt: -1 },
    userRefs: ['gifterId'],
    view: (d) => giftRow(d),
  },
  'group-gifts': {
    collection: 'group_gifts',
    permission: AdminPermission.MONEY_VIEW,
    filter: (uid) => ({ $or: [{ initiatorId: uid }, { participantIds: uid }] }),
    sort: { createdAt: -1 },
    userRefs: ['initiatorId', 'recipientId'],
    view: (d) => ({
      id: id(d._id)!,
      title: d.title,
      status: d.status,
      initiatorId: id(d.initiatorId),
      recipientId: id(d.recipientId),
      forName: d.forName ?? null,
      targetAmountMinor: d.targetAmountMinor ?? null,
      collectedAmountMinor: d.collectedAmountMinor ?? 0,
      contributors: d.contributorCount ?? 0,
      deadline: at(d.deadline),
      createdAt: at(d.createdAt),
    }),
  },
  contributions: {
    collection: 'contributions',
    permission: AdminPermission.MONEY_VIEW,
    filter: (uid) => ({ userId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      groupGiftId: id(d.groupGiftId),
      amountMinor: d.amountMinor,
      status: d.status,
      anonymous: d.anonymous === true,
      message: d.message ?? null,
      createdAt: at(d.createdAt),
    }),
  },
  settlements: {
    collection: 'settlements',
    permission: AdminPermission.MONEY_VIEW,
    filter: (uid) => ({ $or: [{ contributorId: uid }, { hostId: uid }] }),
    sort: { createdAt: -1 },
    userRefs: ['contributorId', 'hostId'],
    view: (d) => ({
      id: id(d._id)!,
      groupGiftId: id(d.groupGiftId),
      direction: d.direction,
      contributorId: id(d.contributorId),
      hostId: id(d.hostId),
      amountMinor: d.amountMinor,
      status: d.status,
      // The UPI ID is private; this says only whether one was shared.
      hasUpi: Boolean(d.upiId),
      sentAt: at(d.sentAt),
      confirmedAt: at(d.confirmedAt),
      createdAt: at(d.createdAt),
    }),
  },
  orders: {
    collection: 'orders',
    permission: AdminPermission.MONEY_VIEW,
    filter: (uid) => ({ gifterId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      reference: d.reference,
      stage: d.stage,
      giftId: id(d.giftId),
      amountMinor: d.amountMinor ?? null,
      courier: d.courier ?? null,
      deliveredAt: at(d.deliveredAt),
      cancelledAt: at(d.cancelledAt),
      createdAt: at(d.createdAt),
    }),
  },
  events: {
    collection: 'events',
    permission: AdminPermission.CONTENT_VIEW,
    filter: (uid) => ({ hostId: uid }),
    sort: { startsAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      title: d.title,
      type: d.type,
      status: d.status,
      visibility: d.visibility,
      startsAt: at(d.startsAt),
      personName: d.personName ?? null,
      wishlists: Array.isArray(d.wishlistIds) ? d.wishlistIds.length : 0,
      createdAt: at(d.createdAt),
    }),
  },
  invites: {
    collection: 'event_invites',
    permission: AdminPermission.CONTENT_VIEW,
    filter: (uid) => ({ invitedUserId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      eventId: id(d.eventId),
      rsvp: d.rsvp,
      plusOnes: d.plusOnes ?? 0,
      respondedAt: at(d.respondedAt),
      revokedAt: at(d.revokedAt),
      createdAt: at(d.createdAt),
    }),
  },
  memories: {
    collection: 'memory_capsules',
    permission: AdminPermission.CONTENT_VIEW,
    filter: (uid) => ({ $or: [{ hostId: uid }, { recipientUserId: uid }] }),
    sort: { createdAt: -1 },
    userRefs: ['hostId', 'recipientUserId'],
    view: (d) => ({
      id: id(d._id)!,
      title: d.title,
      status: d.status,
      hostId: id(d.hostId),
      recipientUserId: id(d.recipientUserId),
      personName: d.personName ?? null,
      wishes: d.wishCount ?? 0,
      unlockAt: at(d.unlockAt),
      createdAt: at(d.createdAt),
    }),
  },
  wishmates: {
    collection: 'wish_links',
    permission: AdminPermission.USERS_VIEW,
    filter: (uid) => ({ $or: [{ requesterId: uid }, { addresseeId: uid }] }),
    sort: { createdAt: -1 },
    userRefs: ['requesterId', 'addresseeId'],
    view: (d) => ({
      id: id(d._id)!,
      requesterId: id(d.requesterId),
      addresseeId: id(d.addresseeId),
      status: d.status,
      respondedAt: at(d.respondedAt),
      createdAt: at(d.createdAt),
    }),
  },
  sessions: {
    collection: 'refresh_tokens',
    permission: AdminPermission.USERS_VIEW,
    filter: (uid) => ({ userId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      familyId: d.familyId,
      userAgent: d.userAgent ?? null,
      ip: d.ip ?? null,
      expiresAt: at(d.expiresAt),
      revokedAt: at(d.revokedAt),
      revokedReason: d.revokedReason ?? null,
      createdAt: at(d.createdAt),
    }),
  },
  devices: {
    collection: 'device_tokens',
    permission: AdminPermission.USERS_VIEW,
    filter: (uid) => ({ userId: uid }),
    sort: { lastSeenAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      platform: d.platform,
      deviceName: d.deviceName ?? null,
      lastSeenAt: at(d.lastSeenAt),
      revokedAt: at(d.revokedAt),
      createdAt: at(d.createdAt),
    }),
  },
  notifications: {
    collection: 'notifications',
    permission: AdminPermission.NOTIFICATIONS_VIEW,
    filter: (uid) => ({ userId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      type: d.type,
      category: d.category,
      title: d.title,
      body: d.body ?? null,
      readAt: at(d.readAt),
      createdAt: at(d.createdAt),
    }),
  },
  deliveries: {
    collection: 'delivery_logs',
    permission: AdminPermission.NOTIFICATIONS_VIEW,
    filter: (uid) => ({ userId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      type: d.type,
      channel: d.channel,
      status: d.status,
      error: d.error ?? null,
      createdAt: at(d.createdAt),
    }),
  },
  'important-dates': {
    collection: 'important_dates',
    permission: AdminPermission.USERS_VIEW,
    filter: (uid) => ({ userId: uid }),
    sort: { monthDay: 1 },
    view: (d) => ({
      id: id(d._id)!,
      personName: d.personName,
      relation: d.relation ?? null,
      occasion: d.occasionKey ?? d.customOccasion ?? null,
      date: at(d.date),
      linkedUserId: id(d.linkedUserId),
    }),
  },
  media: {
    collection: 'media',
    permission: AdminPermission.CONTENT_VIEW,
    filter: (uid) => ({ ownerId: uid }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      purpose: d.purpose,
      status: d.status,
      contentType: d.contentType ?? d.declaredContentType ?? null,
      sizeBytes: d.sizeBytes ?? d.declaredSizeBytes ?? null,
      url: d.url ?? null,
      createdAt: at(d.createdAt),
    }),
  },
  'reports-made': {
    collection: 'reports',
    permission: AdminPermission.MODERATION_VIEW,
    filter: (uid) => ({ reporterId: uid }),
    sort: { createdAt: -1 },
    view: (d) => reportRow(d),
  },
  'reports-against': {
    collection: 'reports',
    permission: AdminPermission.MODERATION_VIEW,
    filter: (uid) => ({ targetType: 'user', targetId: uid.toString() }),
    sort: { createdAt: -1 },
    view: (d) => reportRow(d),
  },
  audit: {
    collection: 'audit_logs',
    permission: AdminPermission.AUDIT_VIEW,
    filter: (uid) => ({ targetType: 'user', targetId: uid.toString() }),
    sort: { createdAt: -1 },
    view: (d) => ({
      id: id(d._id)!,
      action: d.action,
      actorEmail: d.actorEmail ?? null,
      diff: d.diff ?? [],
      meta: d.meta ?? null,
      createdAt: at(d.createdAt),
    }),
  },
  activity: {
    collection: 'analytics_events',
    permission: AdminPermission.USERS_VIEW,
    filter: (uid) => ({ userId: uid }),
    sort: { ts: -1 },
    view: (d) => ({
      id: id(d._id)!,
      name: d.name,
      source: d.source ?? null,
      props: d.props ?? {},
      at: at(d.ts),
    }),
  },
};

export const USER_SECTION_KEYS = Object.keys(SECTIONS);

function giftRow(d: Doc): SectionRow {
  return {
    id: id(d._id)!,
    type: d.type,
    mode: d.mode,
    status: d.status,
    itemId: id(d.itemId),
    wishlistId: id(d.wishlistId),
    gifterId: id(d.gifterId),
    recipientId: id(d.recipientId),
    forName: d.forName ?? null,
    amountMinor: d.amountMinor ?? null,
    currency: d.currency ?? 'INR',
    expiresAt: at(d.expiresAt),
    purchasedAt: at(d.purchasedAt),
    createdAt: at(d.createdAt),
  };
}

function reportRow(d: Doc): SectionRow {
  return {
    id: id(d._id)!,
    targetType: d.targetType,
    targetId: d.targetId,
    reason: d.reason,
    status: d.status,
    severity: d.severity ?? 0,
    source: d.source,
    createdAt: at(d.createdAt),
  };
}

/** `ro***@gmail.com`, `+9198•••••210`, `ro***@okaxis` — the shape without the value. */
export function maskValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const atIdx = value.indexOf('@');
  if (atIdx > 0) return `${value.slice(0, Math.min(2, atIdx))}***${value.slice(atIdx)}`;
  return value.length > 8 ? `${value.slice(0, 5)}•••••${value.slice(-3)}` : '•••';
}

/** What can be revealed, one at a time, with a reason. */
export type RevealField = 'email' | 'phone' | 'upi' | 'addresses';

/**
 * Everything about one user, for their admin page.
 *
 * Read through the raw collections rather than each module's service: the
 * admin view crosses every domain and owns none of them, and a module's own
 * read paths enforce the user's privacy rules, which are the wrong rules here.
 * Private values (email, phone, UPI ID, addresses) are masked until an admin
 * with `sensitive:view` reveals one, with a reason, and every reveal is audited.
 */
@Injectable()
export class AdminUser360Service {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  private get db(): mongo.Db {
    return this.users.db.db as mongo.Db;
  }

  async profile(userId: string, permissions: AdminPermission[]): Promise<UserProfileAdminView> {
    const user = await this.load(userId);
    const uid = user._id;
    const profile = await this.db.collection('user_profiles').findOne({ userId: uid });
    const can = (p: AdminPermission) => permissions.includes(p);

    const countOf = (collection: string, filter: Doc) =>
      this.db.collection(collection).countDocuments(filter);
    const tally: [string, AdminPermission, Promise<number>][] = [
      [
        'wishlists',
        AdminPermission.CONTENT_VIEW,
        countOf('wishlists', { ownerId: uid, archivedAt: null }),
      ],
      ['events', AdminPermission.CONTENT_VIEW, countOf('events', { hostId: uid })],
      [
        'memories',
        AdminPermission.CONTENT_VIEW,
        countOf('memory_capsules', { $or: [{ hostId: uid }, { recipientUserId: uid }] }),
      ],
      [
        'giftsGiven',
        AdminPermission.MONEY_VIEW,
        countOf('gifts', { gifterId: uid, type: { $ne: 'self' } }),
      ],
      [
        'giftsReceived',
        AdminPermission.MONEY_VIEW,
        countOf('gifts', { recipientId: uid, type: { $ne: 'self' } }),
      ],
      [
        'groupGifts',
        AdminPermission.MONEY_VIEW,
        countOf('group_gifts', { $or: [{ initiatorId: uid }, { participantIds: uid }] }),
      ],
      ['orders', AdminPermission.MONEY_VIEW, countOf('orders', { gifterId: uid })],
      [
        'wishmates',
        AdminPermission.USERS_VIEW,
        countOf('wish_links', {
          status: 'accepted',
          $or: [{ requesterId: uid }, { addresseeId: uid }],
        }),
      ],
      [
        'activeSessions',
        AdminPermission.USERS_VIEW,
        countOf('refresh_tokens', { userId: uid, revokedAt: null, expiresAt: { $gt: new Date() } }),
      ],
      [
        'devices',
        AdminPermission.USERS_VIEW,
        countOf('device_tokens', { userId: uid, revokedAt: null }),
      ],
      [
        'reportsAgainst',
        AdminPermission.MODERATION_VIEW,
        countOf('reports', { targetType: 'user', targetId: uid.toString() }),
      ],
    ];
    const allowed = tally.filter(([, p]) => can(p));
    const values = await Promise.all(allowed.map(([, , n]) => n));
    const counts = Object.fromEntries(allowed.map(([key], i) => [key, values[i] ?? 0]));

    const contact = (profile?.contact ?? {}) as Doc;
    return {
      id: uid.toString(),
      email: maskValue(user.email),
      phone: maskValue(user.phone),
      name: user.name ?? null,
      status: user.status,
      suspendedReason: user.suspendedReason ?? null,
      emailVerified: user.emailVerifiedAt != null,
      phoneVerified: user.phoneVerifiedAt != null,
      acquisition: user.acquisition
        ? {
            source: user.acquisition.source,
            ref: user.acquisition.ref,
            capturedAt: user.acquisition.capturedAt,
          }
        : null,
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
      deletedAt: user.deletedAt ?? null,
      deletionReason: user.deletionReason ?? null,
      profile: profile
        ? {
            displayName: (profile.displayName as string) ?? null,
            username: (profile.username as string) ?? null,
            photoUrl: (profile.photoUrl as string) ?? null,
            avatarKey: (profile.avatarKey as string) ?? null,
            gender: (profile.gender as string) ?? null,
            bio: (profile.bio as string) ?? null,
            dateOfBirth: at(profile.dateOfBirth),
            timezone: (profile.timezone as string) ?? null,
            city: (contact.city as string) ?? null,
            country: (contact.country as string) ?? null,
            hasUpi: Boolean(profile.upiId),
            onboardingCompletedAt: at(profile.onboardingCompletedAt),
            preferences: (profile.preferences as Record<string, unknown>) ?? {},
          }
        : null,
      counts,
    };
  }

  async section(
    userId: string,
    key: string,
    permissions: AdminPermission[],
    page?: number,
    limit?: number,
  ): Promise<SectionPage> {
    const spec = SECTIONS[key];
    if (!spec) throw new AppException(ErrorCode.NOT_FOUND, 'No such section', 404);
    if (!permissions.includes(spec.permission)) {
      throw new AppException(
        ErrorCode.ADMIN_FORBIDDEN,
        'You do not have permission for this section',
        403,
      );
    }
    const user = await this.load(userId);
    const p = pageOf(page, limit);
    const filter = spec.filter(user._id);
    const col = this.db.collection(spec.collection);
    const [docs, total] = await Promise.all([
      col
        .find(filter)
        .sort(spec.sort)
        .skip((p.page - 1) * p.limit)
        .limit(p.limit)
        .toArray(),
      col.countDocuments(filter),
    ]);
    const items = docs.map((d) => spec.view(d));
    const ids = new Set<string>();
    for (const row of items) {
      for (const field of spec.userRefs ?? []) {
        const v = row[field];
        if (typeof v === 'string' && v !== userId) ids.add(v);
      }
    }
    return { items, total, page: p.page, limit: p.limit, names: await this.namesFor([...ids]) };
  }

  /**
   * One private value, unmasked — audited with the admin's reason. Every call
   * writes an audit row, so "who looked at this person's address" always has
   * an answer.
   */
  async reveal(
    userId: string,
    field: RevealField,
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ field: RevealField; value: unknown }> {
    const user = await this.load(userId);
    let value: unknown;
    if (field === 'email') value = user.email ?? null;
    else if (field === 'phone') value = user.phone ?? null;
    else if (field === 'upi') {
      const profile = await this.db.collection('user_profiles').findOne({ userId: user._id });
      value = (profile?.upiId as string) ?? null;
    } else {
      const rows = await this.db.collection('addresses').find({ userId: user._id }).toArray();
      value = rows.map((raw) => {
        const a = raw as Record<string, unknown>;
        return {
          id: id(a._id),
          label: a.label ?? null,
          fullName: a.fullName ?? null,
          mobile: a.mobile ?? null,
          locality: a.locality ?? null,
          landmark: a.landmark ?? null,
          city: a.city ?? null,
          state: a.state ?? null,
          pincode: a.pincode ?? null,
          isDefault: a.isDefault === true,
        };
      });
    }
    await this.audit.record({
      actor,
      action: 'user.reveal',
      targetType: 'user',
      targetId: userId,
      meta: { field, reason },
      ip,
    });
    return { field, value };
  }

  // ── Actions (each audited) ──────────────────────────────────────────────────

  /** Ends one sign-in (a whole refresh-token family), not every session. */
  async revokeSession(
    userId: string,
    sessionId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<void> {
    const user = await this.load(userId);
    const row = await this.findOwned('refresh_tokens', sessionId, user._id);
    await this.db
      .collection('refresh_tokens')
      .updateMany(
        { userId: user._id, familyId: row.familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'admin_revoke_session' } },
      );
    await this.audit.record({
      actor,
      action: 'user.session_revoke',
      targetType: 'user',
      targetId: userId,
      meta: { sessionId, familyId: row.familyId as string },
      ip,
    });
  }

  /** Stops push to one device. */
  async revokeDevice(
    userId: string,
    deviceId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<void> {
    const user = await this.load(userId);
    const row = await this.findOwned('device_tokens', deviceId, user._id);
    await this.db
      .collection('device_tokens')
      .updateOne({ _id: row._id as Types.ObjectId }, { $set: { revokedAt: new Date() } });
    await this.audit.record({
      actor,
      action: 'user.device_revoke',
      targetType: 'user',
      targetId: userId,
      meta: { deviceId, platform: row.platform as string },
      ip,
    });
  }

  /** Marks an email or phone verified — for support, after checking it by hand. */
  async markVerified(
    userId: string,
    field: 'email' | 'phone',
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<void> {
    const user = await this.load(userId);
    if (field === 'email' && !user.email)
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'No email to verify', 400);
    if (field === 'phone' && !user.phone)
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'No phone to verify', 400);
    const path = field === 'email' ? 'emailVerifiedAt' : 'phoneVerifiedAt';
    const before = user[path];
    if (before) return;
    const now = new Date();
    await this.users.updateOne({ _id: user._id }, { $set: { [path]: now } }).exec();
    await this.audit.record({
      actor,
      action: `user.verify_${field}`,
      targetType: 'user',
      targetId: userId,
      before: { [path]: null },
      after: { [path]: now },
      meta: { reason },
      ip,
    });
  }

  /**
   * Corrects or redacts what a user shows others — an offensive display name,
   * a username that impersonates someone, a bio with a phone number in it.
   */
  async editProfile(
    userId: string,
    changes: { displayName?: string | null; username?: string | null; bio?: string | null },
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<void> {
    const user = await this.load(userId);
    const profiles = this.db.collection('user_profiles');
    const profile = await profiles.findOne({ userId: user._id });
    if (!profile) throw new AppException(ErrorCode.NOT_FOUND, 'This user has no profile yet', 404);

    const set: Doc = {};
    const before: Doc = {};
    for (const key of ['displayName', 'username', 'bio'] as const) {
      if (changes[key] === undefined) continue;
      const next = typeof changes[key] === 'string' ? changes[key].trim() || null : null;
      const current = (profile[key] as string | null | undefined) ?? null;
      if (next === current) continue;
      before[key] = current;
      set[key] = next;
    }
    if (Object.keys(set).length === 0) return;
    if (typeof set.username === 'string') {
      set.username = set.username.toLowerCase();
      const taken = await profiles.findOne({ username: set.username, userId: { $ne: user._id } });
      if (taken) throw new AppException(ErrorCode.CONFLICT, 'That username is taken', 409);
    }
    await profiles.updateOne({ _id: profile._id }, { $set: { ...set, updatedAt: new Date() } });
    await this.audit.record({
      actor,
      action: 'user.profile_edit',
      targetType: 'user',
      targetId: userId,
      before,
      after: set,
      meta: { reason },
      ip,
    });
  }

  /** Takes down a profile photo; the user falls back to their avatar. */
  async removePhoto(
    userId: string,
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<void> {
    const user = await this.load(userId);
    const profiles = this.db.collection('user_profiles');
    const profile = await profiles.findOne({ userId: user._id });
    if (!profile?.photoUrl) return;
    await profiles.updateOne(
      { _id: profile._id },
      { $set: { photoUrl: null, photoMediaId: null, updatedAt: new Date() } },
    );
    await this.audit.record({
      actor,
      action: 'user.photo_remove',
      targetType: 'user',
      targetId: userId,
      before: { photoUrl: profile.photoUrl as string },
      after: { photoUrl: null },
      meta: { reason },
      ip,
    });
  }

  /**
   * Gives back today's product-search allowance — for someone who hit the cap
   * through no fault of their own (a retrying app, a bug).
   */
  async resetSearchBudget(
    userId: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<void> {
    const user = await this.load(userId);
    await this.cache.delByPattern(`suggestions:budget:v1:${user._id.toString()}:*`);
    await this.audit.record({
      actor,
      action: 'user.search_budget_reset',
      targetType: 'user',
      targetId: userId,
      ip,
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Display names for user ids: profile name, then account name. */
  async namesFor(ids: string[]): Promise<Record<string, string>> {
    const valid = ids.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));
    if (valid.length === 0) return {};
    const [profiles, users] = await Promise.all([
      this.db
        .collection('user_profiles')
        .find({ userId: { $in: valid } })
        .project({ userId: 1, displayName: 1 })
        .toArray(),
      this.users
        .find({ _id: { $in: valid } })
        .select('name')
        .exec(),
    ]);
    const out: Record<string, string> = {};
    for (const u of users) if (u.name) out[u._id.toString()] = u.name;
    for (const p of profiles) if (p.displayName) out[String(p.userId)] = p.displayName as string;
    return out;
  }

  private async findOwned(collection: string, rowId: string, uid: Types.ObjectId): Promise<Doc> {
    if (!Types.ObjectId.isValid(rowId))
      throw new AppException(ErrorCode.NOT_FOUND, 'Not found', 404);
    const row = await this.db
      .collection(collection)
      .findOne({ _id: new Types.ObjectId(rowId), userId: uid });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND, 'Not found', 404);
    return row;
  }

  private async load(userId: string): Promise<UserDocument> {
    if (!Types.ObjectId.isValid(userId))
      throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    const user = await this.users.findById(userId).exec();
    if (!user) throw new AppException(ErrorCode.NOT_FOUND, 'User not found', 404);
    return user;
  }
}
