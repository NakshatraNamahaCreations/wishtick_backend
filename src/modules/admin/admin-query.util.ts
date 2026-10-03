import type { Model, SortOrder } from 'mongoose';

/** What every admin list returns: one page, and how many there are in all. */
export interface AdminPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/** The most one admin list page holds, whatever is asked for. */
export const ADMIN_MAX_PAGE = 100;

/** Page and limit, clamped: page ≥ 1, 1 ≤ limit ≤ [ADMIN_MAX_PAGE]. */
export function pageOf(
  page?: number,
  limit?: number,
  fallback = 25,
): { page: number; limit: number } {
  return {
    page: Math.max(1, Math.floor(page ?? 1)),
    limit: Math.min(Math.max(1, Math.floor(limit ?? fallback)), ADMIN_MAX_PAGE),
  };
}

/** A string matched literally inside a regex — user input is never a pattern. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `{ $gte, $lt }` for a `YYYY-MM-DD` range, inclusive of the whole `to` day.
 * Undefined when neither end is given, so it can be spread straight into a filter.
 */
export function dayRange(from?: string, to?: string): { $gte?: Date; $lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const range: { $gte?: Date; $lt?: Date } = {};
  if (from) range.$gte = new Date(`${from}T00:00:00.000Z`);
  if (to) range.$lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);
  return range;
}

/**
 * One page of [model] matching [filter], newest first unless told otherwise,
 * mapped through [view] — the shape every admin list endpoint returns.
 */
export async function findPage<TDoc, TView>(
  model: Model<TDoc>,
  filter: Record<string, unknown>,
  opts: {
    page?: number;
    limit?: number;
    sort?: Record<string, SortOrder>;
    view: (doc: TDoc) => TView;
  },
): Promise<AdminPage<TView>> {
  const { page, limit } = pageOf(opts.page, opts.limit);
  const [docs, total] = await Promise.all([
    model
      .find(filter)
      .sort(opts.sort ?? { createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .exec(),
    model.countDocuments(filter).exec(),
  ]);
  return { items: (docs as unknown as TDoc[]).map((d) => opts.view(d)), total, page, limit };
}
