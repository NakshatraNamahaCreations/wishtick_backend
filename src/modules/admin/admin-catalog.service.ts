import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { WishlistVisibility } from 'src/modules/wishlists/wishlist.types';
import {
  merchantTrust,
  RESELLER_STORES,
  TRUSTED_STORES,
} from 'src/modules/products/merchant-trust';
import { ProductsService } from 'src/modules/products/products.service';
import { TaxonomyTerm, type TaxonomyDocument } from 'src/modules/taxonomy/schemas/taxonomy.schema';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
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
import type { AdminPage } from './admin-query.util';
import { AdminUser360Service } from './admin-user360.service';
import { AdminPermission, type AuthenticatedAdmin } from './admin.types';
import { AuditService } from './audit.service';

// ── Products, as an explorer area ─────────────────────────────────────────────

export const CATALOG_KINDS = ['products'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const CATALOG_ACTIONS: Record<CatalogKind, string[]> = { products: ['refresh'] };

export interface CatalogQuery extends BaseListQuery {
  provider?: string;
  merchant?: string;
  category?: string;
  inStock?: 'yes' | 'no';
  affiliated?: 'yes' | 'no';
}

const FACETS: Record<CatalogKind, string[]> = { products: ['merchant', 'category', 'provider'] };

const trustOf = (d: Doc): number =>
  merchantTrust({ merchant: str(d.merchant), productUrl: str(d.productUrl) ?? '' });

const SPECS: Record<CatalogKind, ListSpec<CatalogQuery>> = {
  products: {
    collection: 'products',
    search: ['title', 'brand', 'merchant', 'externalId'],
    // A product has no owner; the panel never offers the filter.
    owner: 'ownerId',
    dateField: 'lastSyncedAt',
    sorts: { synced: 'lastSyncedAt', created: 'createdAt', price: 'amountMinor', title: 'title' },
    filter: (q) => ({
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.merchant ? { merchant: q.merchant } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.inStock === 'yes' ? { inStock: true } : q.inStock === 'no' ? { inStock: false } : {}),
      ...(q.affiliated === 'yes'
        ? { affiliateUrl: { $ne: null } }
        : q.affiliated === 'no'
          ? { affiliateUrl: null }
          : {}),
    }),
    row: (d) => ({
      id: id(d._id)!,
      title: str(d.title),
      provider: str(d.provider),
      externalId: str(d.externalId),
      merchant: str(d.merchant),
      brand: str(d.brand),
      category: str(d.category),
      amountMinor: num(d.amountMinor),
      listPriceMinor: num(d.listPriceMinor),
      currency: str(d.currency),
      inStock: d.inStock !== false,
      rating: num(d.rating),
      reviewCount: num(d.reviewCount),
      offers: Array.isArray(d.offers) ? d.offers.length : 0,
      affiliated: Boolean(d.affiliateUrl),
      trust: trustOf(d),
      imageUrl: Array.isArray(d.imageUrls) ? str(d.imageUrls[0]) : null,
      lastSyncedAt: at(d.lastSyncedAt),
      createdAt: at(d.createdAt),
    }),
    userRefs: [],
  },
};

const SECTIONS: Record<CatalogKind, Record<string, SectionSpec>> = {
  products: {
    offers: {
      title: 'Sellers',
      userRefs: [],
      load: (_db, parent) =>
        Promise.resolve(
          (Array.isArray(parent.offers) ? (parent.offers as Doc[]) : []).map((o, i) => ({
            id: String(i),
            merchant: str(o.merchant),
            amountMinor: num(o.amountMinor),
            url: str(o.url),
            affiliated: o.affiliated === true || Boolean(o.affiliateUrl),
            trust: merchantTrust({ merchant: str(o.merchant), productUrl: str(o.url) ?? '' }),
          })),
        ),
    },
    items: {
      title: 'On wishlists',
      collection: 'wishlist_items',
      filter: (p) => ({ sourceProductId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        title: str(r.title),
        wishlistId: id(r.wishlistId),
        ownerId: id(r.ownerId),
        status: str(r.status),
        amountMinor: num(r.amountMinor),
        createdAt: at(r.createdAt),
      }),
      // Items on a private list keep their title to themselves, as everywhere else.
      enrich: async (db, docs, rows) => {
        const lists = await db
          .collection('wishlists')
          .find({ _id: { $in: docs.map((d) => d.wishlistId as Types.ObjectId) } })
          .project({ visibility: 1 })
          .toArray();
        const hidden = new Set(
          lists
            .filter((l) => l.visibility === WishlistVisibility.PRIVATE)
            .map((l) => String(l._id)),
        );
        return rows.map((r) =>
          hidden.has(String(r.wishlistId)) ? { ...r, title: null, private: true } : r,
        );
      },
      userRefs: ['ownerId'],
    },
    clicks: {
      title: 'Clicks out to the store',
      collection: 'click_events',
      filter: (p) => ({ productId: p._id as Types.ObjectId }),
      view: (r) => ({
        id: id(r._id)!,
        userId: id(r.userId),
        provider: str(r.provider),
        itemId: id(r.itemId),
        offerIndex: num(r.offerIndex),
        trackingId: str(r.trackingId),
        createdAt: at(r.createdAt),
      }),
      userRefs: ['userId'],
    },
  },
};

export interface CatalogSection {
  key: string;
  title: string;
  items: ExplorerRow[];
  total: number;
  page: number;
  limit: number;
}

export interface CatalogDetail {
  kind: CatalogKind;
  id: string;
  row: ExplorerRow;
  fields: Record<string, unknown>;
  sections: CatalogSection[];
  names: Record<string, string>;
  raw?: Doc;
}

const strip = (s: LoadedSection): CatalogSection => ({
  key: s.key,
  title: s.title,
  items: s.items,
  total: s.total,
  page: s.page,
  limit: s.limit,
});

// ── Taxonomy ──────────────────────────────────────────────────────────────────

/** One `meta` entry a kind's rows carry, and how the panel asks for it. */
export interface MetaField {
  key: string;
  label: string;
  required: boolean;
  /** A regular expression the value must match. */
  pattern?: string;
  /** Fixed choices. */
  options?: string[];
  /** Choices are the keys of another kind. */
  from?: TaxonomyKind;
}

interface KindInfo {
  label: string;
  meta: MetaField[];
  /** Whether new options may be added from the panel. */
  canAdd: boolean;
  note?: string;
  /** Where the kind's keys are stored, to count how often each is in use. */
  usage: { collection: string; field: string }[];
  /** Keys the code depends on; they cannot be turned off. */
  fixed?: string[];
}

const KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const groupMeta: MetaField[] = [
  { key: 'group', label: 'Group key', required: true, pattern: KEY_PATTERN.source },
  { key: 'groupLabel', label: 'Group name', required: true },
];
const pref = (field: string) => ({ collection: 'user_profiles', field: `preferences.${field}` });

export const TAXONOMY_INFO: Record<TaxonomyKind, KindInfo> = {
  [TaxonomyKind.INTEREST_CATEGORY]: {
    label: 'Interest categories',
    meta: [],
    canAdd: true,
    note: 'The tiles on the first interests screen. A new one has no interests under it until you add some.',
    usage: [pref('interestCategories')],
  },
  [TaxonomyKind.INTEREST]: {
    label: 'Interests',
    meta: [
      {
        key: 'category',
        label: 'Category',
        required: true,
        from: TaxonomyKind.INTEREST_CATEGORY,
      },
    ],
    canAdd: true,
    note: 'Keys start with their category, so the same word under two categories never collides.',
    usage: [pref('interests')],
  },
  [TaxonomyKind.COLOR]: {
    label: 'Colours',
    meta: [
      { key: 'hex', label: 'Colour', required: true, pattern: '^#[0-9A-Fa-f]{6}$' },
      ...groupMeta,
    ],
    canAdd: true,
    usage: [pref('favouriteColors')],
  },
  [TaxonomyKind.CLOTHING_SIZE]: {
    label: 'Clothing sizes',
    meta: [{ key: 'system', label: 'Size system', required: false, options: ['alpha'] }],
    canAdd: true,
    usage: [pref('clothingSize')],
  },
  [TaxonomyKind.SHOE_SIZE]: {
    label: 'Shoe sizes',
    meta: [{ key: 'system', label: 'Size system', required: false, options: ['uk', 'us', 'eu'] }],
    canAdd: true,
    usage: [pref('shoeSize')],
  },
  [TaxonomyKind.FIT_PREFERENCE]: {
    label: 'Fits',
    meta: [],
    canAdd: true,
    usage: [pref('fitPreference')],
  },
  [TaxonomyKind.GIFT_CATEGORY]: {
    label: 'Gift categories',
    meta: [],
    canAdd: true,
    usage: [pref('giftCategories'), { collection: 'wishlist_items', field: 'category' }],
  },
  [TaxonomyKind.LIFESTYLE]: {
    label: 'Lifestyle',
    meta: [],
    canAdd: true,
    usage: [pref('lifestyle')],
  },
  [TaxonomyKind.OCCASION]: {
    label: 'Occasions',
    meta: [],
    canAdd: true,
    note: '“Other” lets people name their own occasion, so it always stays on.',
    usage: [
      pref('occasions'),
      { collection: 'important_dates', field: 'occasionKey' },
      { collection: 'wishlist_items', field: 'occasionKey' },
    ],
    fixed: ['other'],
  },
  [TaxonomyKind.EVENT_TYPE]: {
    label: 'Event types',
    meta: [],
    canAdd: false,
    note: 'These mirror the event types the app is built around. Rename and reorder them here; a new type needs an app and server release.',
    usage: [{ collection: 'events', field: 'type' }],
    fixed: ['birthday', 'anniversary', 'generic', 'special'],
  },
  [TaxonomyKind.RELATION]: {
    label: 'Relations',
    meta: groupMeta,
    canAdd: true,
    usage: [{ collection: 'events', field: 'relation' }],
  },
};

export interface TermRow {
  id: string;
  key: string;
  label: string;
  meta: Record<string, string>;
  sortOrder: number;
  active: boolean;
  uses: number;
  fixed: boolean;
  updatedAt: Date | null;
}

export interface TermInput {
  key?: string;
  label?: string;
  meta?: Record<string, string>;
  reason?: string;
}

/**
 * The catalogue desk: the options people pick from in onboarding and around
 * the app, and the product snapshots search has collected.
 *
 * Taxonomy keys are a contract — profiles, items and events store them — so a
 * key is never renamed or deleted here: labels change, options are retired
 * (turned off) and brought back. Every change clears the options cache so the
 * apps see it at once.
 */
@Injectable()
export class AdminCatalogService {
  constructor(
    @InjectConnection() private readonly conn: Connection,
    @InjectModel(TaxonomyTerm.name) private readonly terms: Model<TaxonomyDocument>,
    private readonly taxonomy: TaxonomyService,
    private readonly products: ProductsService,
    private readonly user360: AdminUser360Service,
    private readonly audit: AuditService,
  ) {}

  private get db(): mongo.Db {
    return this.conn.db as mongo.Db;
  }

  // ── Taxonomy ───────────────────────────────────────────────────────────────

  async kinds(): Promise<
    { kind: TaxonomyKind; label: string; total: number; active: number; canAdd: boolean }[]
  > {
    const counts = await this.terms
      .aggregate<{ _id: TaxonomyKind; total: number; active: number }>([
        {
          $group: {
            _id: '$kind',
            total: { $sum: 1 },
            active: { $sum: { $cond: ['$active', 1, 0] } },
          },
        },
      ])
      .exec();
    const byKind = new Map(counts.map((c) => [c._id, c]));
    return Object.values(TaxonomyKind).map((kind) => ({
      kind,
      label: TAXONOMY_INFO[kind].label,
      total: byKind.get(kind)?.total ?? 0,
      active: byKind.get(kind)?.active ?? 0,
      canAdd: TAXONOMY_INFO[kind].canAdd,
    }));
  }

  async kindDetail(kind: TaxonomyKind): Promise<{
    kind: TaxonomyKind;
    label: string;
    canAdd: boolean;
    note: string | null;
    meta: MetaField[];
    choices: Record<string, { value: string; label: string }[]>;
    terms: TermRow[];
  }> {
    const info = TAXONOMY_INFO[kind];
    const [docs, uses] = await Promise.all([
      this.terms.find({ kind }).sort({ sortOrder: 1, label: 1 }).lean().exec(),
      this.usage(kind),
    ]);
    const choices: Record<string, { value: string; label: string }[]> = {};
    for (const m of info.meta) {
      if (m.from) {
        const from = await this.terms.find({ kind: m.from }).sort({ sortOrder: 1 }).lean().exec();
        choices[m.key] = from.map((t) => ({ value: t.key, label: t.label }));
      } else if (m.options) {
        choices[m.key] = m.options.map((o) => ({ value: o, label: o.toUpperCase() }));
      }
    }
    return {
      kind,
      label: info.label,
      canAdd: info.canAdd,
      note: info.note ?? null,
      meta: info.meta,
      choices,
      terms: docs.map((t) => this.termRow(kind, t, uses.get(t.key) ?? 0)),
    };
  }

  private termRow(kind: TaxonomyKind, t: TaxonomyTerm, uses: number): TermRow {
    return {
      id: String(t._id),
      key: t.key,
      label: t.label,
      meta: t.meta ?? {},
      sortOrder: t.sortOrder,
      active: t.active,
      uses,
      fixed: TAXONOMY_INFO[kind].fixed?.includes(t.key) ?? false,
      updatedAt: t.updatedAt ?? null,
    };
  }

  /** How many records hold each key of [kind], across every place it is stored. */
  private async usage(kind: TaxonomyKind): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    for (const { collection, field } of TAXONOMY_INFO[kind].usage) {
      const rows = await this.db
        .collection(collection)
        .aggregate<{ _id: unknown; n: number }>([
          { $match: { [field]: { $nin: [null, []] } } },
          { $project: { v: `$${field}` } },
          { $unwind: '$v' },
          { $group: { _id: '$v', n: { $sum: 1 } } },
        ])
        .toArray();
      for (const r of rows) {
        if (typeof r._id === 'string') totals.set(r._id, (totals.get(r._id) ?? 0) + r.n);
      }
    }
    return totals;
  }

  /** The meta a write may store: declared keys only, required ones present and well formed. */
  private async checkMeta(
    kind: TaxonomyKind,
    meta: Record<string, string>,
  ): Promise<Record<string, string>> {
    const fields = TAXONOMY_INFO[kind].meta;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      const field = fields.find((f) => f.key === k);
      if (!field) throw this.invalid(`“${k}” is not something ${kind} options carry`);
      const value = typeof v === 'string' ? v.trim() : '';
      if (!value) continue;
      if (field.pattern && !new RegExp(field.pattern).test(value)) {
        throw this.invalid(`${field.label} is not in the right form`);
      }
      if (field.options && !field.options.includes(value)) {
        throw this.invalid(`${field.label} must be one of ${field.options.join(', ')}`);
      }
      if (field.from && !(await this.terms.exists({ kind: field.from, key: value }))) {
        throw this.invalid(`${field.label} “${value}” does not exist`);
      }
      out[k] = value;
    }
    for (const f of fields) {
      if (f.required && !out[f.key]) throw this.invalid(`${f.label} is required`);
    }
    return out;
  }

  private invalid(message: string): AppException {
    return new AppException(ErrorCode.VALIDATION_FAILED, message, 400);
  }

  private async termOf(kind: TaxonomyKind, termId: string): Promise<TaxonomyDocument> {
    const term = Types.ObjectId.isValid(termId)
      ? await this.terms.findOne({ _id: new Types.ObjectId(termId), kind }).exec()
      : null;
    if (!term) throw new AppException(ErrorCode.NOT_FOUND, 'No such option', 404);
    return term;
  }

  async createTerm(
    kind: TaxonomyKind,
    input: TermInput,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<TermRow> {
    const info = TAXONOMY_INFO[kind];
    if (!info.canAdd) {
      throw new AppException(
        ErrorCode.CONTENT_ACTION_INVALID,
        `${info.label} cannot be added to from the panel`,
        400,
      );
    }
    const key = (input.key ?? '').trim();
    const label = (input.label ?? '').trim();
    if (!KEY_PATTERN.test(key) || key.length > 60) {
      throw this.invalid('The key is lower-case letters and numbers joined by underscores');
    }
    if (!label) throw this.invalid('A label is required');
    if (await this.terms.exists({ kind, key })) {
      throw new AppException(ErrorCode.CONFLICT, `There is already a “${key}”`, 409);
    }
    const meta = await this.checkMeta(kind, input.meta ?? {});
    const last = await this.terms.findOne({ kind }).sort({ sortOrder: -1 }).lean().exec();
    const term = await this.terms.create({
      kind,
      key,
      label,
      meta,
      sortOrder: (last?.sortOrder ?? -10) + 10,
      active: true,
    });
    await this.taxonomy.bustCache();
    await this.record(actor, 'catalog.add_option', kind, term, {}, { key, label, meta }, input, ip);
    return this.termRow(kind, term.toObject(), 0);
  }

  async updateTerm(
    kind: TaxonomyKind,
    termId: string,
    input: TermInput,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<TermRow> {
    const term = await this.termOf(kind, termId);
    const before = { label: term.label, meta: { ...term.meta } };
    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label) throw this.invalid('A label is required');
      term.label = label;
    }
    if (input.meta !== undefined) {
      // Keys sent empty are removed; keys not sent are kept.
      term.meta = await this.checkMeta(kind, { ...term.meta, ...input.meta });
      term.markModified('meta');
    }
    await term.save();
    await this.taxonomy.bustCache();
    await this.record(
      actor,
      'catalog.edit_option',
      kind,
      term,
      before,
      { label: term.label, meta: term.meta },
      input,
      ip,
    );
    return this.termRow(kind, term.toObject(), (await this.usage(kind)).get(term.key) ?? 0);
  }

  async setActive(
    kind: TaxonomyKind,
    termId: string,
    active: boolean,
    input: TermInput,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<TermRow> {
    const term = await this.termOf(kind, termId);
    if (!active && TAXONOMY_INFO[kind].fixed?.includes(term.key)) {
      throw new AppException(
        ErrorCode.CONTENT_ACTION_INVALID,
        `“${term.label}” is used by the app itself and stays on`,
        400,
      );
    }
    if (term.active !== active) {
      term.active = active;
      await term.save();
      await this.taxonomy.bustCache();
      await this.record(
        actor,
        active ? 'catalog.restore_option' : 'catalog.retire_option',
        kind,
        term,
        { active: !active },
        { active },
        input,
        ip,
      );
    }
    return this.termRow(kind, term.toObject(), (await this.usage(kind)).get(term.key) ?? 0);
  }

  /** Puts [ids] in that order; options not named keep their place after them. */
  async reorder(
    kind: TaxonomyKind,
    order: string[],
    input: TermInput,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ ok: true }> {
    const docs = await this.terms.find({ kind }).sort({ sortOrder: 1, label: 1 }).exec();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    if (order.some((x) => !byId.has(x)) || new Set(order).size !== order.length) {
      throw this.invalid('The order names options that are not in this list');
    }
    const named = order.map((x) => byId.get(x)!);
    const rest = docs.filter((d) => !order.includes(String(d._id)));
    const ordered = [...named, ...rest];
    await this.terms.bulkWrite(
      ordered.map((d, i) => ({
        updateOne: { filter: { _id: d._id }, update: { $set: { sortOrder: i * 10 } } },
      })),
    );
    await this.taxonomy.bustCache();
    await this.audit.record({
      actor,
      action: 'catalog.reorder_options',
      targetType: 'taxonomy',
      targetId: kind,
      before: { order: docs.map((d) => d.key) },
      after: { order: ordered.map((d) => d.key) },
      meta: input.reason ? { reason: input.reason } : {},
      ip,
    });
    return { ok: true };
  }

  private record(
    actor: AuthenticatedAdmin,
    action: string,
    kind: TaxonomyKind,
    term: TaxonomyDocument,
    before: Doc,
    after: Doc,
    input: TermInput,
    ip: string | null,
  ): Promise<void> {
    return this.audit.record({
      actor,
      action,
      targetType: 'taxonomy',
      targetId: String(term._id),
      before,
      after,
      meta: { kind, key: term.key, ...(input.reason ? { reason: input.reason } : {}) },
      ip,
    });
  }

  // ── Stores ─────────────────────────────────────────────────────────────────

  /** The trusted and reseller lists, and the stores the catalogue actually holds. */
  async stores(): Promise<{
    trusted: readonly string[];
    resellers: readonly string[];
    merchants: { merchant: string | null; products: number; trust: number }[];
  }> {
    const rows = await this.db
      .collection('products')
      .aggregate<{ _id: unknown; products: number; url: unknown }>([
        { $group: { _id: '$merchant', products: { $sum: 1 }, url: { $first: '$productUrl' } } },
        { $sort: { products: -1 } },
        { $limit: 300 },
      ])
      .toArray();
    return {
      trusted: TRUSTED_STORES,
      resellers: RESELLER_STORES,
      merchants: rows.map((r) => ({
        merchant: str(r._id),
        products: r.products,
        trust: merchantTrust({ merchant: str(r._id), productUrl: str(r.url) ?? '' }),
      })),
    };
  }

  // ── Products ───────────────────────────────────────────────────────────────

  async list(
    kind: CatalogKind,
    q: CatalogQuery,
  ): Promise<AdminPage<ExplorerRow> & { names: Record<string, string> }> {
    return { ...(await listPage(this.db, SPECS[kind], q)), names: {} };
  }

  async exportCsv(
    kind: CatalogKind,
    q: CatalogQuery,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<string> {
    const rows = await listAll(this.db, SPECS[kind], q);
    await this.audit.record({
      actor,
      action: 'catalog.export',
      targetType: kind,
      targetId: null,
      meta: { rows: rows.length, filters: { ...q } },
      ip,
    });
    return toCsv(rows);
  }

  async facets(kind: CatalogKind, field: string): Promise<string[]> {
    if (!FACETS[kind].includes(field)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No such filter', 404);
    }
    const values = await this.db.collection(SPECS[kind].collection).distinct(field);
    return values
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 200);
  }

  async detail(
    kind: CatalogKind,
    rowId: string,
    admin: AuthenticatedAdmin,
  ): Promise<CatalogDetail> {
    const doc = await loadDoc(this.db, SPECS[kind].collection, rowId);
    const sections = await Promise.all(
      Object.entries(SECTIONS[kind]).map(([key, s]) => loadSection(this.db, key, s, doc, true, 1)),
    );
    const refs = sections.flatMap((s) => refsIn(s.items, SECTIONS[kind][s.key].userRefs));
    return {
      kind,
      id: rowId,
      row: SPECS[kind].row(doc),
      fields: {
        description: str(doc.description),
        productUrl: str(doc.productUrl),
        affiliateUrl: str(doc.affiliateUrl),
        deliveryNote: str(doc.deliveryNote),
        features: Array.isArray(doc.features)
          ? (doc.features as Doc[]).map((f) => ({ label: str(f.label), value: str(f.value) }))
          : [],
        images: Array.isArray(doc.imageUrls) ? doc.imageUrls : [],
        lastChangedAt: at(doc.lastChangedAt),
        updatedAt: at(doc.updatedAt),
      },
      sections: sections.map(strip),
      names: await this.user360.namesFor([...new Set(refs)]),
      ...(admin.permissions.includes(AdminPermission.DEBUG_VIEW) ? { raw: doc } : {}),
    };
  }

  async section(
    kind: CatalogKind,
    rowId: string,
    key: string,
    page: number,
  ): Promise<CatalogSection & { names: Record<string, string> }> {
    const spec = SECTIONS[kind][key];
    if (!spec) throw new AppException(ErrorCode.NOT_FOUND, 'No such section', 404);
    const doc = await loadDoc(this.db, SPECS[kind].collection, rowId);
    const s = await loadSection(this.db, key, spec, doc, true, Math.max(1, page));
    return {
      ...strip(s),
      names: await this.user360.namesFor([...new Set(refsIn(s.items, spec.userRefs))]),
    };
  }

  /**
   * Fetches the product from its provider again now. This is a paid lookup
   * when the provider is SerpApi, and it goes through the same breaker and
   * counters as any other.
   */
  async act(
    kind: CatalogKind,
    rowId: string,
    action: string,
    reason: string,
    actor: AuthenticatedAdmin,
    ip: string | null,
  ): Promise<{ ok: true; result?: unknown }> {
    if (!CATALOG_ACTIONS[kind].includes(action)) {
      throw new AppException(
        ErrorCode.CONTENT_ACTION_INVALID,
        `“${action}” is not something you can do to ${kind}`,
        400,
      );
    }
    const doc = await loadDoc(this.db, SPECS[kind].collection, rowId);
    const pick = (d: Doc) => ({
      title: str(d.title),
      amountMinor: num(d.amountMinor),
      inStock: d.inStock !== false,
      offers: Array.isArray(d.offers) ? d.offers.length : 0,
    });
    const { freshness } = await this.products.getDetails(
      String(doc.provider),
      String(doc.externalId),
    );
    const after = await loadDoc(this.db, SPECS[kind].collection, rowId);
    await this.audit.record({
      actor,
      action: 'catalog.refresh_product',
      targetType: kind,
      targetId: rowId,
      before: pick(doc),
      after: pick(after),
      meta: { reason, freshness },
      ip,
    });
    return { ok: true, result: { freshness } };
  }
}
