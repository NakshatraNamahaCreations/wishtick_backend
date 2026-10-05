import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Connection, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { QUEUE } from 'src/infra/queue/queue.constants';
import { GiftStatus } from 'src/modules/gifting/gift.types';
import { GiftingService } from 'src/modules/gifting/gifting.service';
import { WebhookService } from 'src/modules/gifting/webhook.service';
import { GROUP_GIFT_RECONCILE_JOB } from 'src/modules/group-gifts/group-gift-reconcile.processor';
import { GroupGiftService } from 'src/modules/group-gifts/group-gift.service';
import { SettlementService } from 'src/modules/group-gifts/settlement.service';
import { OrderStage } from 'src/modules/orders/order.types';
import { OrdersService } from 'src/modules/orders/orders.service';
import { CONVERSION_SYNC_JOB } from 'src/modules/products/affiliate/conversion-sync.service';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import {
  at,
  id,
  ids,
  listAll,
  listPage,
  loadDoc,
  loadSection,
  num,
  refsIn,
  str,
  toCsv,
  yesNo,
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

/** The money areas, as they appear in URLs. */
export const MONEY_KINDS = [
  'gifts',
  'orders',
  'group-gifts',
  'conversions',
  'clicks',
  'webhooks',
] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];

export interface MoneyQuery extends BaseListQuery {
  status?: string;
  type?: string;
  mode?: string;
  stuck?: 'yes' | 'no';
  stage?: string;
  source?: string;
  courier?: string;
  cancelled?: 'yes' | 'no';
  drift?: 'yes' | 'no';
  network?: string;
  matched?: 'yes' | 'no';
  provider?: string;
  eventType?: string;
  /** Filled in by the service for `drift`, never by the caller. */
  driftIds?: Types.ObjectId[];
}

export interface MoneyListPage extends AdminPage<ExplorerRow> {
  names: Record<string, string>;
}

export interface MoneySection {
  key: string;
  title: string;
  items: ExplorerRow[];
  total: number;
  page: number;
  limit: number;
}

export interface MoneyDetail {
  kind: MoneyKind;
  id: string;
  row: ExplorerRow;
  fields: Record<string, unknown>;
  sections: MoneySection[];
  names: Record<string, string>;
  raw?: Doc;
}

/** The actions each area offers. */
export const MONEY_ACTIONS: Record<MoneyKind, string[]> = {
  gifts: ['cancel', 'mark-purchased', 'mark-fulfilled', 'extend'],
  orders: ['set-stage', 'set-tracking', 'cancel'],
  'group-gifts': ['cancel', 'refund-contribution', 'cancel-settlement', 'reconcile'],
  conversions: [],
  clicks: [],
  webhooks: ['replay'],
};

export interface MoneyActionInput {
  reason: string;
  until?: string;
  stage?: string;
  courier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  contributionId?: string;
  settlementId?: string;
}

/** How a drift record is filed in `ops_events`. */
export const DRIFT_EVENT_TYPE = 'group_gift.drift';

/** A gift still holding its item after its hold ran out. */
const stuckFilter = (): Doc => ({
  status: GiftStatus.RESERVED,
  active: true,
  expiresAt: { $lt: new Date() },
});

const SPECS: Record<MoneyKind, ListSpec<MoneyQuery>> = {
  gifts: {
    collection: 'gifts',
    search: ['orderRef', 'forName'],
    owner: 'gifterId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt', updated: 'updatedAt', amount: 'amountMinor' },
    filter: (q) => ({
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.mode ? { mode: q.mode } : {}),
      ...(q.stuck === 'yes' ? stuckFilter() : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      itemId: id(d.itemId),
      wishlistId: id(d.wishlistId),
      gifterId: id(d.gifterId),
      recipientId: id(d.recipientId),
      forName: str(d.forName),
      type: str(d.type),
      mode: str(d.mode),
      status: str(d.status),
      amountMinor: num(d.amountMinor),
      currency: str(d.currency) ?? 'INR',
      orderRef: str(d.orderRef),
      expiresAt: at(d.expiresAt),
      stuck:
        d.status === GiftStatus.RESERVED &&
        d.active === true &&
        d.expiresAt instanceof Date &&
        d.expiresAt.getTime() < Date.now(),
      purchasedAt: at(d.purchasedAt),
      fulfilledAt: at(d.fulfilledAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['gifterId', 'recipientId'],
  },
  orders: {
    collection: 'orders',
    search: ['reference', 'trackingNumber', 'courier'],
    owner: 'gifterId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt', updated: 'updatedAt', amount: 'amountMinor' },
    filter: (q) => ({
      ...(q.stage ? { stage: q.stage } : {}),
      ...(q.source ? { 'timeline.source': q.source } : {}),
      ...(q.courier ? { courier: q.courier } : {}),
      ...yesNo(q.cancelled, 'cancelledAt'),
    }),
    row: (d) => ({
      id: id(d._id)!,
      reference: str(d.reference),
      giftId: id(d.giftId),
      gifterId: id(d.gifterId),
      itemId: id(d.itemId),
      stage: str(d.stage),
      amountMinor: num(d.amountMinor),
      currency: str(d.currency) ?? 'INR',
      courier: str(d.courier),
      trackingNumber: str(d.trackingNumber),
      deliveredAt: at(d.deliveredAt),
      cancelledAt: at(d.cancelledAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['gifterId'],
  },
  'group-gifts': {
    collection: 'group_gifts',
    search: ['title', 'forName', 'share.slug'],
    owner: 'initiatorId',
    dateField: 'deadline',
    sorts: { created: 'createdAt', collected: 'collectedAmountMinor', deadline: 'deadline' },
    filter: (q) => ({
      ...(q.status ? { status: q.status } : {}),
      ...(q.drift === 'yes' ? { _id: { $in: q.driftIds ?? [] } } : {}),
      ...(q.drift === 'no' ? { _id: { $nin: q.driftIds ?? [] } } : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      title: str(d.title),
      status: str(d.status),
      initiatorId: id(d.initiatorId),
      recipientId: id(d.recipientId),
      forName: str(d.forName),
      targetAmountMinor: num(d.targetAmountMinor),
      collectedAmountMinor: num(d.collectedAmountMinor) ?? 0,
      contributors: num(d.contributorCount) ?? 0,
      currency: str(d.currency) ?? 'INR',
      deadline: at(d.deadline),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['initiatorId', 'recipientId'],
  },
  conversions: {
    collection: 'conversions',
    search: ['orderId', 'productName', 'campaignName', 'externalId', 'merchantReferenceId'],
    owner: 'userId',
    dateField: 'transactionAt',
    sorts: { transaction: 'transactionAt', commission: 'commissionMinor', sale: 'saleAmountMinor' },
    filter: (q) => ({
      ...(q.network ? { network: q.network } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...yesNo(q.matched, 'giftId'),
    }),
    row: (d) => ({
      id: id(d._id)!,
      network: str(d.network),
      status: str(d.status),
      merchant: str(d.campaignName),
      productName: str(d.productName),
      saleAmountMinor: num(d.saleAmountMinor),
      commissionMinor: num(d.commissionMinor),
      currency: str(d.currency) ?? 'INR',
      userId: id(d.userId),
      giftId: id(d.giftId),
      itemId: id(d.itemId),
      transactionAt: at(d.transactionAt),
      reconciledAt: at(d.reconciledAt),
    }),
    userRefs: ['userId'],
  },
  clicks: {
    collection: 'click_events',
    search: ['trackingId', 'provider'],
    owner: 'userId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt' },
    filter: (q) => ({ ...(q.provider ? { provider: q.provider } : {}) }),
    row: (d) => ({
      id: id(d._id)!,
      trackingId: str(d.trackingId),
      provider: str(d.provider),
      productId: id(d.productId),
      itemId: id(d.itemId),
      wishlistId: id(d.wishlistId),
      userId: id(d.userId),
      createdAt: at(d.createdAt),
    }),
    userRefs: ['userId'],
  },
  webhooks: {
    collection: 'webhook_events',
    search: ['providerEventId', 'orderRef'],
    owner: 'matchedGiftId',
    dateField: 'createdAt',
    sorts: { created: 'createdAt' },
    filter: (q) => ({
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.eventType ? { eventType: q.eventType } : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      provider: str(d.provider),
      providerEventId: str(d.providerEventId),
      eventType: str(d.eventType),
      orderRef: str(d.orderRef),
      status: str(d.status),
      matchedGiftId: id(d.matchedGiftId),
      note: str(d.note),
      createdAt: at(d.createdAt),
    }),
    userRefs: [],
  },
};

/** An array kept on the document itself, shown as a section. */
const embedded = (
  title: string,
  field: string,
  view: (e: Doc, i: number) => ExplorerRow,
  userRefs: string[] = [],
): SectionSpec => ({
  title,
  userRefs,
  load: (_db, parent) =>
    Promise.resolve(
      (Array.isArray(parent[field]) ? (parent[field] as Doc[]) : [])
        .map((e, i) => view(e, i))
        .reverse(),
    ),
});

/** History says who by user id, `admin:…` or `system:…`; ids become names. */
const historyRow = (e: Doc, i: number): ExplorerRow => ({
  id: String(i),
  status: str(e.status),
  at: at(e.at),
  by: str(e.by),
  note: str(e.note),
});

const SECTIONS: Record<MoneyKind, Record<string, SectionSpec>> = {
  gifts: {
    history: embedded('History', 'history', historyRow, ['by']),
    orders: {
      title: 'Order',
      collection: 'orders',
      filter: (p) => ({ giftId: p._id as Types.ObjectId }),
      view: (r) => SPECS.orders.row(r),
      userRefs: [],
    },
    'group-gifts': {
      title: 'Group gift',
      collection: 'group_gifts',
      filter: (p) => ({ giftId: p._id as Types.ObjectId }),
      view: (r) => SPECS['group-gifts'].row(r),
      userRefs: ['initiatorId'],
    },
    conversions: {
      title: 'Affiliate sales',
      collection: 'conversions',
      filter: (p) => ({ giftId: p._id as Types.ObjectId }),
      view: (r) => SPECS.conversions.row(r),
      userRefs: [],
    },
  },
  orders: {
    timeline: embedded('Timeline', 'timeline', (e, i) => ({
      id: String(i),
      stage: str(e.stage),
      at: at(e.at),
      source: str(e.source),
      note: str(e.note),
    })),
  },
  'group-gifts': {
    contributions: {
      title: 'Contributions',
      collection: 'contributions',
      filter: (p) => ({ groupGiftId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        userId: id(r.userId),
        amountMinor: num(r.amountMinor),
        status: str(r.status),
        anonymous: r.anonymous === true,
        message: str(r.message),
        paymentRef: str(r.paymentRef),
        refundRef: str(r.refundRef),
        refundedAt: at(r.refundedAt),
        createdAt: at(r.createdAt),
      }),
      userRefs: ['userId'],
    },
    settlements: {
      title: 'Settle-ups',
      collection: 'settlements',
      filter: (p) => ({ groupGiftId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        direction: str(r.direction),
        contributorId: id(r.contributorId),
        hostId: id(r.hostId),
        amountMinor: num(r.amountMinor),
        status: str(r.status),
        // Masked: a UPI id is a payment address. The user's page reveals it.
        upiId: r.upiId ? maskValue(String(r.upiId)) : null,
        sentAt: at(r.sentAt),
        confirmedAt: at(r.confirmedAt),
        note: str(r.note),
        createdAt: at(r.createdAt),
      }),
      userRefs: ['contributorId', 'hostId'],
    },
    invites: {
      title: 'Invites',
      collection: 'group_gift_invites',
      filter: (p) => ({ groupGiftId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        invitedUserId: id(r.invitedUserId),
        invitedById: id(r.invitedById),
        status: str(r.status),
        respondedAt: at(r.respondedAt),
        createdAt: at(r.createdAt),
      }),
      userRefs: ['invitedUserId', 'invitedById'],
    },
    history: embedded('History', 'history', historyRow, ['by']),
  },
  conversions: {
    clicks: {
      title: 'The click it came from',
      collection: 'click_events',
      filter: (p) => ({ trackingId: str(p.clickTrackingId) ?? '__none__' }),
      view: (r) => SPECS.clicks.row(r),
      userRefs: ['userId'],
    },
  },
  clicks: {
    conversions: {
      title: 'Sales from this click',
      collection: 'conversions',
      filter: (p) => ({ clickTrackingId: str(p.trackingId) ?? '__none__' }),
      view: (r) => SPECS.conversions.row(r),
      userRefs: ['userId'],
    },
  },
  webhooks: {},
};

/**
 * The money explorer: gifts, orders, group gifts, affiliate sales and clicks,
 * and the webhooks that move them — listed, opened with what hangs off each,
 * and corrected. Every correction goes through the module that owns the
 * money, so it has the same consequences as the user doing it, and is
 * audited with the admin's reason.
 */
@Injectable()
export class AdminMoneyService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectQueue(QUEUE.SCHEDULER) private readonly scheduler: Queue,
    @InjectQueue(QUEUE.AFFILIATE_SYNC) private readonly affiliateQueue: Queue,
    private readonly user360: AdminUser360Service,
    private readonly gifting: GiftingService,
    private readonly orders: OrdersService,
    private readonly groupGifts: GroupGiftService,
    private readonly settlements: SettlementService,
    private readonly webhooks: WebhookService,
    private readonly audit: AuditService,
  ) {}

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  // ── Lists ──────────────────────────────────────────────────────────────────

  private async withDrift(kind: MoneyKind, q: MoneyQuery): Promise<MoneyQuery> {
    if (kind !== 'group-gifts' || !q.drift) return q;
    const driftIds = (await this.db
      .collection('ops_events')
      .distinct('refId', { type: DRIFT_EVENT_TYPE })) as Types.ObjectId[];
    return { ...q, driftIds };
  }

  async list(kind: MoneyKind, q: MoneyQuery): Promise<MoneyListPage> {
    const spec = SPECS[kind];
    const page = await listPage(this.db, spec, await this.withDrift(kind, q));
    const items = await this.decorate(kind, page.items);
    return {
      ...page,
      items,
      names: await this.user360.namesFor([...new Set(refsIn(items, spec.userRefs))]),
    };
  }

  async exportCsv(
    kind: MoneyKind,
    q: MoneyQuery,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<string> {
    const rows = await this.decorate(
      kind,
      await listAll(this.db, SPECS[kind], await this.withDrift(kind, q)),
    );
    await this.audit.record({
      actor,
      action: 'money.export',
      targetType: kind,
      targetId: null,
      meta: { rows: rows.length, filters: { ...q, driftIds: undefined } },
      ip,
    });
    return toCsv(rows);
  }

  /**
   * What a gift or order row cannot say alone: the item's title. Items on a
   * private list stay untitled here, as they do in the content explorer.
   */
  private async decorate(kind: MoneyKind, rows: ExplorerRow[]): Promise<ExplorerRow[]> {
    if (kind !== 'gifts' && kind !== 'orders' && kind !== 'conversions') return rows;
    const itemIds = [...new Set(rows.map((r) => str(r.itemId)).filter((x): x is string => !!x))];
    if (itemIds.length === 0) return rows;
    const items = await this.db
      .collection('wishlist_items')
      .find({ _id: { $in: itemIds.map((x) => new Types.ObjectId(x)) } })
      .project({ title: 1, wishlistId: 1 })
      .toArray();
    const lists = await this.db
      .collection('wishlists')
      .find({ _id: { $in: items.map((i) => i.wishlistId as Types.ObjectId) } })
      .project({ visibility: 1 })
      .toArray();
    const privateList = new Set(
      lists.filter((l) => l.visibility === WishlistVisibility.PRIVATE).map((l) => String(l._id)),
    );
    const titleOf = new Map(
      items.map((i) => [
        String(i._id),
        privateList.has(String(i.wishlistId)) ? null : str(i.title),
      ]),
    );
    return rows.map((r) => ({ ...r, itemTitle: titleOf.get(String(r.itemId)) ?? null }));
  }

  // ── Detail ─────────────────────────────────────────────────────────────────

  async detail(kind: MoneyKind, rowId: string, admin: AuthenticatedAdmin): Promise<MoneyDetail> {
    const spec = SPECS[kind];
    const doc = await loadDoc(this.db, spec.collection, rowId);
    const specs = Object.entries(SECTIONS[kind]);
    const sections = await Promise.all(
      specs.map(([key, s]) => loadSection(this.db, key, s, doc, true, 1)),
    );
    const [row] = await this.decorate(kind, [spec.row(doc)]);
    const fields = await this.fieldsOf(kind, doc);
    const refs = [
      ...refsIn([row], spec.userRefs),
      ...sections.flatMap((s) => refsIn(s.items, SECTIONS[kind][s.key].userRefs)),
      ...fields.userIds,
    ];
    return {
      kind,
      id: rowId,
      row,
      fields: fields.values,
      sections: sections.map(strip),
      names: await this.user360.namesFor([...new Set(refs)]),
      ...(admin.permissions.includes(AdminPermission.DEBUG_VIEW) ? { raw: doc } : {}),
    };
  }

  async section(
    kind: MoneyKind,
    rowId: string,
    key: string,
    page: number,
  ): Promise<MoneySection & { names: Record<string, string> }> {
    const spec = SECTIONS[kind][key];
    if (!spec) throw new AppException(ErrorCode.NOT_FOUND, 'No such section', 404);
    const doc = await loadDoc(this.db, SPECS[kind].collection, rowId);
    const s = await loadSection(this.db, key, spec, doc, true, Math.max(1, page));
    return {
      ...strip(s),
      names: await this.user360.namesFor([...new Set(refsIn(s.items, spec.userRefs))]),
    };
  }

  private async fieldsOf(
    kind: MoneyKind,
    d: Doc,
  ): Promise<{ values: Record<string, unknown>; userIds: string[] }> {
    switch (kind) {
      case 'gifts':
        return {
          values: {
            visibility: str(d.visibility),
            showBuyerName: d.showBuyerName === true,
            deliveryNotes: str(d.deliveryNotes),
            reservedAt: at(d.reservedAt),
            expectedDeliveryAt: at(d.expectedDeliveryAt),
            completedAt: at(d.completedAt),
            cancelledAt: at(d.cancelledAt),
          },
          userIds: [],
        };
      case 'orders':
        return {
          values: {
            trackingUrl: str(d.trackingUrl),
            deliveryMethod: str(d.deliveryMethod),
            estimatedDeliveryFrom: at(d.estimatedDeliveryFrom),
            estimatedDeliveryTo: at(d.estimatedDeliveryTo),
            cancelledNote: str(d.cancelledNote),
          },
          userIds: [],
        };
      case 'group-gifts': {
        const drift = await this.db
          .collection('ops_events')
          .find({ type: DRIFT_EVENT_TYPE, refId: d._id as Types.ObjectId })
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();
        return {
          values: {
            balance: await this.settlements.balance(String(d._id)),
            lines: (Array.isArray(d.lines) ? (d.lines as Doc[]) : []).map((l) => ({
              itemId: id(l.itemId),
              giftId: id(l.giftId),
              amountMinor: num(l.amountMinor),
            })),
            charges: (Array.isArray(d.charges) ? (d.charges as Doc[]) : []).map((c) => ({
              label: str(c.label),
              amountMinor: num(c.amountMinor),
            })),
            contributionMode: str(d.contributionMode),
            overfundPolicy: str(d.overfundPolicy),
            visibility: str(d.visibility),
            hostUpiSet: Boolean(d.hostUpiId),
            giftId: id(d.giftId),
            chatId: id(d.chatId),
            eventId: id(d.eventId),
            cancelReason: str(d.cancelReason),
            participants: ids(d.participantIds).length,
            drift: drift.map((e) => ({
              at: at(e.createdAt),
              ...((e.data ?? {}) as Record<string, unknown>),
            })),
          },
          userIds: [],
        };
      }
      case 'conversions':
        return {
          values: {
            externalId: str(d.externalId),
            orderId: str(d.orderId),
            merchantReferenceId: str(d.merchantReferenceId),
            clickTrackingId: str(d.clickTrackingId),
            campaignId: num(d.campaignId),
            wishlistId: id(d.wishlistId),
            groupGiftId: id(d.groupGiftId),
            networkUpdatedAt: at(d.networkUpdatedAt),
          },
          userIds: [],
        };
      case 'clicks':
        return {
          values: {
            referer: str(d.referer),
            userAgent: str(d.userAgent),
            offerIndex: num(d.offerIndex),
          },
          userIds: [],
        };
      case 'webhooks':
        return { values: { payload: d.payload ?? null }, userIds: [] };
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async act(
    kind: MoneyKind,
    rowId: string,
    action: string,
    input: MoneyActionInput,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ ok: true; result?: unknown }> {
    if (!MONEY_ACTIONS[kind].includes(action)) {
      throw new AppException(
        ErrorCode.CONTENT_ACTION_INVALID,
        `“${action}” is not something you can do to ${kind}`,
        400,
      );
    }
    const doc = await loadDoc(this.db, SPECS[kind].collection, rowId);
    const by = `admin:${actor.email}`;
    const note = input.reason;
    const record = (name: string, before: Doc, after: Doc, meta: Doc = {}) =>
      this.audit.record({
        actor,
        action: `money.${name}`,
        targetType: kind,
        targetId: rowId,
        before,
        after,
        meta: { reason: note, ...meta },
        ip,
      });
    const child = (v: string | undefined, what: string): string => {
      if (!v || !Types.ObjectId.isValid(v)) {
        throw new AppException(ErrorCode.VALIDATION_FAILED, `${what} is required`, 400);
      }
      return v;
    };

    switch (`${kind}:${action}`) {
      case 'gifts:cancel':
      case 'gifts:mark-purchased':
      case 'gifts:mark-fulfilled': {
        const run = {
          cancel: () => this.gifting.adminCancel(rowId, by, note),
          'mark-purchased': () => this.gifting.adminPurchase(rowId, by, note),
          'mark-fulfilled': () => this.gifting.adminFulfil(rowId, by, note),
        }[action as 'cancel' | 'mark-purchased' | 'mark-fulfilled'];
        const gift = await run();
        await record(
          action.replace(/-/g, '_'),
          { status: str(doc.status) },
          { status: gift.status },
        );
        return { ok: true };
      }
      case 'gifts:extend': {
        const until = new Date(input.until ?? '');
        const gift = await this.gifting.extendReservation(rowId, until, by, note);
        await record('extend', { expiresAt: at(doc.expiresAt) }, { expiresAt: gift.expiresAt });
        return { ok: true };
      }

      case 'orders:set-stage': {
        const stage = input.stage as OrderStage;
        if (!Object.values(OrderStage).includes(stage)) {
          throw new AppException(ErrorCode.VALIDATION_FAILED, 'Choose a stage', 400);
        }
        await this.orders.setStageAsAdmin(rowId, stage, note);
        await record('set_stage', { stage: str(doc.stage) }, { stage });
        return { ok: true };
      }
      case 'orders:set-tracking': {
        const changes = {
          ...(input.courier !== undefined ? { courier: input.courier || null } : {}),
          ...(input.trackingNumber !== undefined
            ? { trackingNumber: input.trackingNumber || null }
            : {}),
          ...(input.trackingUrl !== undefined ? { trackingUrl: input.trackingUrl || null } : {}),
        };
        await this.orders.setTrackingAsAdmin(rowId, changes);
        await record(
          'set_tracking',
          Object.fromEntries(Object.keys(changes).map((k) => [k, doc[k] ?? null])),
          changes,
        );
        return { ok: true };
      }
      case 'orders:cancel': {
        // An order is its gift's: cancelling one is cancelling the other, so the
        // item frees up and the order closes the way it does for the gifter.
        const gift = await this.gifting.adminCancel(String(doc.giftId), by, note);
        await record('cancel', { stage: str(doc.stage) }, { giftStatus: gift.status });
        return { ok: true };
      }

      case 'group-gifts:cancel':
        await this.groupGifts.cancelAsAdmin(rowId, by, note);
        await record('cancel', { status: str(doc.status) }, { status: 'cancelled' });
        return { ok: true };
      case 'group-gifts:refund-contribution': {
        const contributionId = child(input.contributionId, 'contributionId');
        await this.groupGifts.refundContributionAsAdmin(rowId, contributionId, actor.id);
        await record(
          'refund_contribution',
          { status: 'confirmed' },
          { status: 'refunded' },
          {
            contributionId,
          },
        );
        return { ok: true };
      }
      case 'group-gifts:cancel-settlement': {
        const settlementId = child(input.settlementId, 'settlementId');
        const settlement = await this.db.collection('settlements').findOne({
          _id: new Types.ObjectId(settlementId),
          groupGiftId: doc._id as Types.ObjectId,
        });
        if (!settlement) {
          throw new AppException(
            ErrorCode.NOT_FOUND,
            'That settle-up is not on this group gift',
            404,
          );
        }
        await this.settlements.cancelAsAdmin(settlementId, note);
        await record(
          'cancel_settlement',
          { status: str(settlement.status) },
          { status: 'cancelled' },
          {
            settlementId,
          },
        );
        return { ok: true };
      }
      case 'group-gifts:reconcile': {
        await this.scheduler.add(
          GROUP_GIFT_RECONCILE_JOB,
          {},
          { jobId: `group-gift-reconcile-manual-${Date.now()}`, removeOnComplete: true },
        );
        await record('reconcile', {}, { queued: true });
        return { ok: true };
      }

      case 'webhooks:replay': {
        const result = await this.webhooks.replay(rowId);
        await record(
          'replay',
          { status: str(doc.status) },
          { status: result.status },
          {
            giftId: result.giftId ?? null,
          },
        );
        return { ok: true, result };
      }
    }
    throw new AppException(ErrorCode.CONTENT_ACTION_INVALID, 'Unknown action', 400);
  }

  // ── Overviews ──────────────────────────────────────────────────────────────

  /**
   * Money by month: what was bought through gifts (GMV), what groups
   * collected, and what the networks owe — split by their own status words.
   */
  async finance(
    from?: string,
    to?: string,
  ): Promise<{
    months: {
      month: string;
      gmvMinor: number;
      giftsBought: number;
      groupCollectedMinor: number;
      commissionByStatus: Record<string, number>;
      commissionMinor: number;
    }[];
    totals: { gmvMinor: number; groupCollectedMinor: number; commissionMinor: number };
  }> {
    const range = monthRange(from, to);
    const monthOf = (field: string) => ({ $dateToString: { format: '%Y-%m', date: `$${field}` } });

    const [gmv, collected, commission] = await Promise.all([
      this.db
        .collection('gifts')
        .aggregate<{ _id: string; minor: number; n: number }>([
          {
            $match: {
              purchasedAt: range,
              status: { $in: [GiftStatus.PURCHASED, GiftStatus.FULFILLED, GiftStatus.COMPLETED] },
              type: { $ne: 'self' },
            },
          },
          {
            $group: {
              _id: monthOf('purchasedAt'),
              minor: { $sum: { $ifNull: ['$amountMinor', 0] } },
              n: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      this.db
        .collection('contributions')
        .aggregate<{ _id: string; minor: number }>([
          { $match: { createdAt: range, status: 'confirmed' } },
          { $group: { _id: monthOf('createdAt'), minor: { $sum: '$amountMinor' } } },
        ])
        .toArray(),
      this.db
        .collection('conversions')
        .aggregate<{ _id: { m: string; s: string | null }; minor: number }>([
          { $match: { transactionAt: range } },
          {
            $group: {
              _id: { m: monthOf('transactionAt'), s: '$status' },
              minor: { $sum: { $ifNull: ['$commissionMinor', 0] } },
            },
          },
        ])
        .toArray(),
    ]);

    const months = new Map<
      string,
      {
        month: string;
        gmvMinor: number;
        giftsBought: number;
        groupCollectedMinor: number;
        commissionByStatus: Record<string, number>;
        commissionMinor: number;
      }
    >();
    const monthRow = (m: string) => {
      let row = months.get(m);
      if (!row) {
        row = {
          month: m,
          gmvMinor: 0,
          giftsBought: 0,
          groupCollectedMinor: 0,
          commissionByStatus: {},
          commissionMinor: 0,
        };
        months.set(m, row);
      }
      return row;
    };
    for (const g of gmv) Object.assign(monthRow(g._id), { gmvMinor: g.minor, giftsBought: g.n });
    for (const c of collected) monthRow(c._id).groupCollectedMinor = c.minor;
    for (const c of commission) {
      const row = monthRow(c._id.m);
      const status = c._id.s ?? 'unknown';
      row.commissionByStatus[status] = (row.commissionByStatus[status] ?? 0) + c.minor;
      row.commissionMinor += c.minor;
    }
    const list = [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
    return {
      months: list,
      totals: {
        gmvMinor: list.reduce((s, m) => s + m.gmvMinor, 0),
        groupCollectedMinor: list.reduce((s, m) => s + m.groupCollectedMinor, 0),
        commissionMinor: list.reduce((s, m) => s + m.commissionMinor, 0),
      },
    };
  }

  async financeCsv(
    from: string | undefined,
    to: string | undefined,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<string> {
    const { months } = await this.finance(from, to);
    const statuses = [...new Set(months.flatMap((m) => Object.keys(m.commissionByStatus)))].sort();
    const rows: ExplorerRow[] = months.map((m) => ({
      id: m.month,
      gmvMinor: m.gmvMinor,
      giftsBought: m.giftsBought,
      groupCollectedMinor: m.groupCollectedMinor,
      commissionMinor: m.commissionMinor,
      ...Object.fromEntries(statuses.map((s) => [`commission_${s}`, m.commissionByStatus[s] ?? 0])),
    }));
    await this.audit.record({
      actor,
      action: 'money.export',
      targetType: 'finance',
      targetId: null,
      meta: { from: from ?? null, to: to ?? null, rows: rows.length },
      ip,
    });
    return toCsv(rows).replace(/^id,/, 'month,');
  }

  /**
   * The affiliate picture: commission by month and merchant, clicks and sales
   * by store (with a click-to-sale rate), the products clicked most, and when
   * each network last synced.
   */
  async affiliate(
    from?: string,
    to?: string,
  ): Promise<{
    byMerchant: { merchant: string; sales: number; saleMinor: number; commissionMinor: number }[];
    byProvider: {
      provider: string;
      clicks: number;
      sales: number;
      conversionRate: number | null;
    }[];
    topProducts: {
      productId: string;
      title: string | null;
      merchant: string | null;
      clicks: number;
    }[];
    sync: { network: string; lastSyncedAt: Date | null }[];
  }> {
    const range = monthRange(from, to);
    const [byMerchant, clicks, salesByNetwork, top, sync] = await Promise.all([
      this.db
        .collection('conversions')
        .aggregate<{ _id: string | null; sales: number; sale: number; commission: number }>([
          { $match: { transactionAt: range } },
          {
            $group: {
              _id: '$campaignName',
              sales: { $sum: 1 },
              sale: { $sum: { $ifNull: ['$saleAmountMinor', 0] } },
              commission: { $sum: { $ifNull: ['$commissionMinor', 0] } },
            },
          },
          { $sort: { commission: -1 } },
          { $limit: 50 },
        ])
        .toArray(),
      this.db
        .collection('click_events')
        .aggregate<{ _id: string | null; n: number }>([
          { $match: { createdAt: range } },
          { $group: { _id: '$provider', n: { $sum: 1 } } },
        ])
        .toArray(),
      this.db
        .collection('conversions')
        .aggregate<{ _id: string | null; n: number }>([
          { $match: { transactionAt: range, clickTrackingId: { $ne: null } } },
          {
            $lookup: {
              from: 'click_events',
              localField: 'clickTrackingId',
              foreignField: 'trackingId',
              as: 'click',
            },
          },
          { $unwind: '$click' },
          { $group: { _id: '$click.provider', n: { $sum: 1 } } },
        ])
        .toArray(),
      this.db
        .collection('click_events')
        .aggregate<{ _id: Types.ObjectId; n: number }>([
          { $match: { createdAt: range, productId: { $ne: null } } },
          { $group: { _id: '$productId', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $limit: 20 },
        ])
        .toArray(),
      this.db.collection('affiliate_sync_state').find({}).toArray(),
    ]);

    const products = await this.db
      .collection('products')
      .find({ _id: { $in: top.map((t) => t._id) } })
      .project({ title: 1, merchant: 1 })
      .toArray();
    const productOf = new Map(products.map((p) => [String(p._id), p]));
    const salesOf = new Map(salesByNetwork.map((s) => [s._id ?? 'unknown', s.n]));

    return {
      byMerchant: byMerchant.map((m) => ({
        merchant: m._id ?? 'Unknown',
        sales: m.sales,
        saleMinor: m.sale,
        commissionMinor: m.commission,
      })),
      byProvider: clicks
        .map((c) => {
          const provider = c._id ?? 'unknown';
          const sales = salesOf.get(provider) ?? 0;
          return {
            provider,
            clicks: c.n,
            sales,
            conversionRate: c.n > 0 ? Math.round((sales / c.n) * 10_000) / 100 : null,
          };
        })
        .sort((a, b) => b.clicks - a.clicks),
      topProducts: top.map((t) => ({
        productId: String(t._id),
        title: str(productOf.get(String(t._id))?.title),
        merchant: str(productOf.get(String(t._id))?.merchant),
        clicks: t.n,
      })),
      sync: sync.map((s) => ({ network: String(s.network), lastSyncedAt: at(s.lastSyncedAt) })),
    };
  }

  /** Asks for an affiliate sales sync now, rather than at the next hour. */
  async syncNow(actor: AuthenticatedAdmin, ip: string | null): Promise<{ queued: true }> {
    await this.affiliateQueue.add(
      CONVERSION_SYNC_JOB,
      {},
      { jobId: `affiliate-conversion-sync-manual-${Date.now()}`, removeOnComplete: true },
    );
    await this.audit.record({
      actor,
      action: 'money.affiliate_sync',
      targetType: 'affiliate',
      targetId: null,
      after: { queued: true },
      ip,
    });
    return { queued: true };
  }

  /** Group gifts whose collected total had drifted from their contributions. */
  async driftLog(
    page?: number,
    limit?: number,
  ): Promise<AdminPage<ExplorerRow> & { names: Record<string, string> }> {
    const p = pageOf(page, limit);
    const col = this.db.collection('ops_events');
    const filter = { type: DRIFT_EVENT_TYPE };
    const [docs, total] = await Promise.all([
      col
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((p.page - 1) * p.limit)
        .limit(p.limit)
        .toArray(),
      col.countDocuments(filter),
    ]);
    const giftIds = docs.map((d) => d.refId as Types.ObjectId).filter(Boolean);
    const gifts = await this.db
      .collection('group_gifts')
      .find({ _id: { $in: giftIds } })
      .project({ title: 1 })
      .toArray();
    const titleOf = new Map(gifts.map((g) => [String(g._id), str(g.title)]));
    const items = docs.map((d) => {
      const data = (d.data ?? {}) as Doc;
      return {
        id: id(d._id)!,
        groupGiftId: id(d.refId),
        title: titleOf.get(String(d.refId)) ?? null,
        cachedAmountMinor: num(data.cachedAmountMinor),
        summedAmountMinor: num(data.summedAmountMinor),
        driftMinor: num(data.driftMinor),
        at: at(d.createdAt),
      };
    });
    return { items, total, page: p.page, limit: p.limit, names: {} };
  }
}

function strip(s: LoadedSection): MoneySection {
  const { privateParts: _, ...rest } = s;
  void _;
  return rest;
}

/** `{ $gte, $lt }` over whole months, from `YYYY-MM` (or a day) to `YYYY-MM`. */
function monthRange(from?: string, to?: string): Doc {
  const start = from
    ? new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`)
    : new Date(Date.UTC(new Date().getUTCFullYear() - 1, new Date().getUTCMonth(), 1));
  const endMonth = to
    ? new Date(`${to.slice(0, 7)}-01T00:00:00.000Z`)
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const end = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() + 1, 1));
  return { $gte: start, $lt: end };
}
