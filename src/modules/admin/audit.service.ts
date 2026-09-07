import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { AuthenticatedAdmin } from './admin.types';
import { AuditLog, type AuditDiffEntry, type AuditLogDocument } from './schemas/audit-log.schema';

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
  async list(filters: {
    targetType?: string;
    targetId?: string;
    actorAdminId?: string;
    action?: string;
    /** Inclusive UTC day bounds, `YYYY-MM-DD`. */
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: AuditLogDocument[]; total: number; page: number; limit: number }> {
    const query: Record<string, unknown> = {};
    if (filters.targetType) query.targetType = filters.targetType;
    if (filters.targetId) query.targetId = filters.targetId;
    if (filters.action) query.action = filters.action;
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
