import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

/** One changed field: what it was, what it became. The "readable diff". */
export interface AuditDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * An append-only record of every admin mutation.
 *
 * There is deliberately no update or delete path anywhere in the codebase — the
 * audit trail is worthless if an admin can edit it. Each row captures who did
 * what to which target, the field-level `diff`, and the source IP.
 */
@Schema({ collection: 'audit_logs', timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Admin', required: true })
  actorAdminId!: Types.ObjectId;

  @Prop({ type: String, required: true })
  actorEmail!: string;

  /** e.g. 'user.suspend', 'moderation.remove', 'admin.create'. */
  @Prop({ type: String, required: true })
  action!: string;

  @Prop({ type: String, required: true })
  targetType!: string;

  @Prop({ type: String, default: null })
  targetId!: string | null;

  /** Human-readable per-field before/after — what the reviewer actually reads. */
  @Prop({ type: [SchemaTypes.Mixed], default: [] })
  diff!: AuditDiffEntry[];

  /** Free-form context (reason, resolution, etc.). */
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  meta!: Record<string, unknown>;

  @Prop({ type: String, default: null })
  ip!: string | null;

  createdAt!: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ actorAdminId: 1, createdAt: -1 });
AuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
