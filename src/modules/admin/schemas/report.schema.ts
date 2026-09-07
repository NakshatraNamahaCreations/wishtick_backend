import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { ReportSource, ReportStatus, ReportTargetType } from '../moderation.types';

export type ReportDocument = HydratedDocument<Report>;

/**
 * A piece of content or a person flagged for review — from a user hitting
 * "report" or from an auto-flag hook. The moderation queue is these, ordered by
 * severity then age. A duplicate `(source, targetType, targetId, reporterId)`
 * is collapsed by the unique index so one person cannot spam the queue.
 */
@Schema({ collection: 'reports', timestamps: true })
export class Report {
  _id!: Types.ObjectId;

  /** Null for an auto-flag (no human reporter). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  reporterId!: Types.ObjectId | null;

  @Prop({ type: String, enum: Object.values(ReportSource), default: ReportSource.USER })
  source!: ReportSource;

  @Prop({ type: String, enum: Object.values(ReportTargetType), required: true })
  targetType!: ReportTargetType;

  @Prop({ type: String, required: true })
  targetId!: string;

  @Prop({ type: String, required: true, maxlength: 80 })
  reason!: string;

  @Prop({ type: String, default: null, maxlength: 1000 })
  detail!: string | null;

  @Prop({ type: String, enum: Object.values(ReportStatus), default: ReportStatus.OPEN })
  status!: ReportStatus;

  /** Higher is reviewed sooner. */
  @Prop({ type: Number, default: 1 })
  severity!: number;

  /** Set when a moderator closes it. */
  @Prop({ type: String, default: null })
  resolution!: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Admin', default: null })
  handledBy!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  handledAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

// The queue: open first, then highest severity, then oldest.
ReportSchema.index({ status: 1, severity: -1, createdAt: 1 });
ReportSchema.index({ targetType: 1, targetId: 1 });
// One open report per (reporter, target, source) — dedupes spam and auto-flags.
ReportSchema.index({ source: 1, targetType: 1, targetId: 1, reporterId: 1 }, { unique: true });
