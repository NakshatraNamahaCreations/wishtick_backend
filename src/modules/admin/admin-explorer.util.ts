import { Types, type mongo } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { dayRange, escapeRegex, pageOf, type AdminPage } from './admin-query.util';

/**
 * The machinery shared by the admin explorers (content, money): a list read
 * from one collection through a spec, a detail page's sections paged on their
 * own, and the small conversions every row needs. Each explorer supplies the
 * specs; this file knows nothing about any one collection.
 */

export type Doc = mongo.Document;

/** One row of a list or section — its fields as plain JSON. */
export type ExplorerRow = Record<string, unknown> & { id: string };

// ── Values out of loosely-typed documents ─────────────────────────────────────

export const id = (v: unknown): string | null =>
  v instanceof Types.ObjectId ? v.toString() : typeof v === 'string' && v ? v : null;
export const at = (v: unknown): Date | null => (v instanceof Date ? v : null);
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
export const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(id).filter((x): x is string => x !== null) : [];
export const oid = (v: string): Types.ObjectId | null =>
  Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null;
/** `yes` → the field is set; `no` → it is not; otherwise no condition. */
export const yesNo = (v: 'yes' | 'no' | undefined, field: string): Doc =>
  v === 'yes' ? { [field]: { $ne: null } } : v === 'no' ? { [field]: null } : {};

// ── Lists ─────────────────────────────────────────────────────────────────────

/** The filters every explorer list shares; each spec reads the rest itself. */
export interface BaseListQuery {
  q?: string;
  owner?: string;
  from?: string;
  to?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/** What a list reads, how it filters, and what one row says. */
export interface ListSpec<Q extends BaseListQuery> {
  collection: string;
  /** Fields the free-text search looks in; an id always matches too. */
  search: string[];
  /** The field "owner" narrows by — owner, host, gifter… */
  owner: string;
  /** The field the date range applies to. */
  dateField: string;
  /** Sort keys the panel may ask for → fields; the first is the default. */
  sorts: Record<string, string>;
  filter: (q: Q) => Doc;
  row: (d: Doc) => ExplorerRow;
  /** Fields that hold a user id, resolved to names for the panel. */
  userRefs: string[];
}

export function listFilter<Q extends BaseListQuery>(spec: ListSpec<Q>, q: Q): Doc {
  const filter: Doc = { ...spec.filter(q) };
  const term = q.q?.trim();
  if (term) {
    const or: Doc[] = spec.search.map((f) => ({
      [f]: { $regex: escapeRegex(term), $options: 'i' },
    }));
    if (Types.ObjectId.isValid(term)) or.push({ _id: new Types.ObjectId(term) });
    filter.$or = or.length ? or : [{ _id: null }];
  }
  if (q.owner && oid(q.owner)) filter[spec.owner] = oid(q.owner);
  const range = dayRange(q.from, q.to);
  if (range) filter[spec.dateField] = range;
  return filter;
}

export function listSort<Q extends BaseListQuery>(spec: ListSpec<Q>, q: Q): Doc {
  const field = (q.sort && spec.sorts[q.sort]) || Object.values(spec.sorts)[0];
  return { [field]: q.order === 'asc' ? 1 : -1, _id: -1 };
}

/** One page of a list. Names are the caller's to add. */
export async function listPage<Q extends BaseListQuery>(
  db: mongo.Db,
  spec: ListSpec<Q>,
  q: Q,
): Promise<AdminPage<ExplorerRow>> {
  const { page, limit } = pageOf(q.page, q.limit);
  const filter = listFilter(spec, q);
  const col = db.collection(spec.collection);
  const [docs, total] = await Promise.all([
    col
      .find(filter)
      .sort(listSort(spec, q))
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col.countDocuments(filter),
  ]);
  return { items: docs.map((d) => spec.row(d)), total, page, limit };
}

/** Every row a list's filters match, up to [cap], for an export. */
export async function listAll<Q extends BaseListQuery>(
  db: mongo.Db,
  spec: ListSpec<Q>,
  q: Q,
  cap = 50_000,
): Promise<ExplorerRow[]> {
  const docs = await db
    .collection(spec.collection)
    .find(listFilter(spec, q))
    .sort(listSort(spec, q))
    .limit(cap)
    .toArray();
  return docs.map((d) => spec.row(d));
}

// ── Detail sections ───────────────────────────────────────────────────────────

/** Rows per section page on a detail page. */
export const SECTION_PAGE = 25;

/** A list of other things hanging off a record — paged on its own. */
export interface SectionSpec {
  title: string;
  collection?: string;
  filter?: (parent: Doc) => Doc;
  sort?: Doc;
  /** [show] is false while the parent's private parts are held back. */
  view?: (r: Doc, show: boolean) => ExplorerRow;
  /** Private until revealed, judged from the parent. */
  locked?: (parent: Doc) => boolean;
  userRefs: string[];
  pageSize?: number;
  /** Adds what the rows cannot say alone (a file's address, say). */
  enrich?: (db: mongo.Db, docs: Doc[], rows: ExplorerRow[]) => Promise<ExplorerRow[]>;
  /** A section that is not one collection: loaded whole. */
  load?: (db: mongo.Db, parent: Doc) => Promise<ExplorerRow[]>;
}

export interface LoadedSection {
  key: string;
  title: string;
  items: ExplorerRow[];
  total: number;
  page: number;
  limit: number;
  /** Whether its rows have private parts at all. */
  privateParts: boolean;
}

export async function loadSection(
  db: mongo.Db,
  key: string,
  spec: SectionSpec,
  parent: Doc,
  open: boolean,
  page: number,
): Promise<LoadedSection> {
  const privateParts = spec.locked?.(parent) ?? false;
  const show = !privateParts || open;
  const limit = spec.pageSize ?? SECTION_PAGE;
  if (spec.load) {
    const all = await spec.load(db, parent);
    return {
      key,
      title: spec.title,
      items: all,
      total: all.length,
      page: 1,
      limit: all.length || limit,
      privateParts,
    };
  }
  const col = db.collection(spec.collection!);
  const filter = spec.filter!(parent);
  const [docs, total] = await Promise.all([
    col
      .find(filter)
      .sort(spec.sort ?? { createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    col.countDocuments(filter),
  ]);
  let items = docs.map((r) => spec.view!(r, show));
  if (spec.enrich) items = await spec.enrich(db, docs, items);
  return { key, title: spec.title, items, total, page, limit, privateParts };
}

// ── Odds and ends ─────────────────────────────────────────────────────────────

/** One document by id, or a 404 — an invalid id and a missing one alike. */
export async function loadDoc(db: mongo.Db, collection: string, rowId: string): Promise<Doc> {
  const _id = oid(rowId);
  const doc = _id ? await db.collection(collection).findOne({ _id }) : null;
  if (!doc) throw new AppException(ErrorCode.NOT_FOUND, 'Not found', 404);
  return doc;
}

/** Every user id [fields] of [rows] mention. */
export function refsIn(rows: ExplorerRow[], fields: string[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const f of fields) {
      const v = r[f];
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
    }
  }
  return out;
}

/** Rows as CSV, with a header from the first row's keys. */
export function toCsv(rows: ExplorerRow[]): string {
  const columns = rows.length ? Object.keys(rows[0]) : ['id'];
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n');
}

/** A CSV cell that a spreadsheet will not run as a formula. */
export function csvCell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (v instanceof Date) s = v.toISOString();
  else if (Array.isArray(v))
    s = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  else if (typeof v === 'object') s = JSON.stringify(v);
  else if (typeof v === 'string') s = v;
  else s = typeof v === 'number' || typeof v === 'boolean' ? v.toString() : '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
