import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { AuthenticatedAdmin } from './admin.types';
import { AuditLog, type AuditDiffEntry, type AuditLogDocument } from './schemas/audit-log.schema';

/** The audit filters the list and the export share. */
export interface AuditFilters {
  targetType?: string;
  targetId?: string;
  actorAdminId?: string;
  action?: string;
  /** `read`: looking at private data or exporting it. `change`: everything else. */
  kind?: 'read' | 'change';
  /** Inclusive UTC day bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

/**
 * Actions that read rather than change: revealing masked or private data, and
 * exports. Kept as a pattern over action names so a new reveal or export
 * counts without anyone remembering to list it.
 */
export const READ_ACTION = /(reveal|export)/;

export interface AuditInput {
  actor: AuthenticatedAdmin;
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Curated field snapshots — only what changed, so the diff reads cleanly. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Writes the append-only audit trail. Every admin mutation calls `record`, which
 * derives a readable per-field diff from the before/after snapshots — the thing
 * a reviewer actually reads. There is no update or delete method, by design.
 */
@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditLog.name) private readonly model: Model<AuditLogDocument>) {}

  async record(input: AuditInput): Promise<void> {
    await this.model.create({
      actorAdminId: new Types.ObjectId(input.actor.id),
      actorEmail: input.actor.email,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      diff: AuditService.diff(input.before ?? {}, input.after ?? {}),
      meta: input.meta ?? {},
      ip: input.ip ?? null,
    });
  }

  /**
   * The audit trail, newest first.
   *
   * Paginated with a `total`, matching the users and moderation queues. The
   * previous fixed 500-row slice with no offset meant anything older was
   * unreachable over HTTP — which makes "what did this admin do last week"
   * unanswerable, and an audit log you cannot search is a compliance prop.
   */
  /** The Mongo filter for [filters]. */
  private filterOf(filters: AuditFilters): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    if (filters.targetType) query.targetType = filters.targetType;
    if (filters.targetId) query.targetId = filters.targetId;
    if (filters.action) query.action = filters.action;
    else if (filters.kind === 'read') query.action = READ_ACTION;
    else if (filters.kind === 'change') query.action = { $not: READ_ACTION };
    if (filters.actorAdminId && Types.ObjectId.isValid(filters.actorAdminId)) {
      query.actorAdminId = new Types.ObjectId(filters.actorAdminId);
    }

    // `to` is inclusive of the whole day, so the upper bound is the next
    // midnight — otherwise "to = today" silently excludes everything today.
    if (filters.from || filters.to) {
      const range: Record<string, Date> = {};
      if (filters.from) range.$gte = new Date(`${filters.from}T00:00:00.000Z`);
      if (filters.to) {
        const end = new Date(`${filters.to}T00:00:00.000Z`);
        end.setUTCDate(end.getUTCDate() + 1);
        range.$lt = end;
      }
      query.createdAt = range;
    }
    return query;
  }

  async list(
    filters: AuditFilters & { page?: number; limit?: number },
  ): Promise<{ items: AuditLogDocument[]; total: number; page: number; limit: number }> {
    const query = this.filterOf(filters);

    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(Math.max(1, filters.limit ?? 50), 500);

    const [items, total] = await Promise.all([
      this.model
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.model.countDocuments(query).exec(),
    ]);

    return { items, total, page, limit };
  }

  /** Everything [filters] match, newest first, up to [cap] rows — for an export. */
  async all(filters: AuditFilters, cap = 50_000): Promise<AuditLogDocument[]> {
    return this.model.find(this.filterOf(filters)).sort({ createdAt: -1 }).limit(cap).exec();
  }

  /**
   * What one admin has done over the last [days]: totals, changes against
   * reads per day, the actions they take most, and when they last did anything.
   */
  async activity(
    adminId: string,
    days: number,
  ): Promise<{
    total: number;
    reads: number;
    lastAt: Date | null;
    byAction: { action: string; n: number }[];
    byDay: { day: string; changes: number; reads: number }[];
  }> {
    const actor = new Types.ObjectId(adminId);
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const match = { actorAdminId: actor, createdAt: { $gte: since } };
    const [byAction, perDay, last] = await Promise.all([
      this.model
        .aggregate<{ _id: string; n: number }>([
          { $match: match },
          { $group: { _id: '$action', n: { $sum: 1 } } },
          { $sort: { n: -1, _id: 1 } },
        ])
        .exec(),
      this.model
        .aggregate<{ _id: { d: string; a: string }; n: number }>([
          { $match: match },
          {
            $group: {
              _id: {
                d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                a: '$action',
              },
              n: { $sum: 1 },
            },
          },
        ])
        .exec(),
      this.model.findOne({ actorAdminId: actor }).sort({ createdAt: -1 }).exec(),
    ]);
    const byDay = new Map<string, { changes: number; reads: number }>();
    for (let t = since.getTime(); t <= Date.now(); t += 86_400_000) {
      byDay.set(new Date(t).toISOString().slice(0, 10), { changes: 0, reads: 0 });
    }
    for (const r of perDay) {
      const day = byDay.get(r._id.d);
      if (!day) continue;
      if (READ_ACTION.test(r._id.a)) day.reads += r.n;
      else day.changes += r.n;
    }
    const rows = byAction.map((r) => ({ action: r._id, n: r.n }));
    return {
      total: rows.reduce((a, r) => a + r.n, 0),
      reads: rows.filter((r) => READ_ACTION.test(r.action)).reduce((a, r) => a + r.n, 0),
      lastAt: last?.createdAt ?? null,
      byAction: rows,
      byDay: [...byDay].map(([day, v]) => ({ day, ...v })),
    };
  }

  /** Distinct action names present in the log, for populating a filter. */
  async actions(): Promise<string[]> {
    const values = await this.model.distinct('action').exec();
    return (values as unknown[]).filter((v): v is string => typeof v === 'string').sort();
  }

  /** Field-level diff over the union of keys; only genuinely-changed fields. */
  static diff(before: Record<string, unknown>, after: Record<string, unknown>): AuditDiffEntry[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const entries: AuditDiffEntry[] = [];
    for (const field of keys) {
      const b = before[field];
      const a = after[field];
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        entries.push({ field, before: b ?? null, after: a ?? null });
      }
    }
    return entries;
  }
}
