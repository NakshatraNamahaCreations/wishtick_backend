import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MetricDailyDocument = HydratedDocument<MetricDaily>;

/**
 * A daily pre-aggregate the dashboards read instead of scanning raw events.
 *
 * One row per (metric, day, dimension). The rollup upserts these idempotently —
 * re-running a day recomputes the same value — keyed by the unique
 * `(metric, bucket, dimKey)` index. `dimKey` is a stable serialization of `dims`
 * (e.g. `source=whatsapp`), empty for an undimensioned metric like DAU.
 */
@Schema({ collection: 'metric_daily', timestamps: true })
export class MetricDaily {
  _id!: Types.ObjectId;

  /** The day this covers, `YYYY-MM-DD` in UTC. */
  @Prop({ type: String, required: true })
  bucket!: string;

  /** e.g. 'dau', 'signups', 'reels_generated'. */
  @Prop({ type: String, required: true })
  metric!: string;

  @Prop({ type: String, default: '' })
  dimKey!: string;

  @Prop({ type: Object, default: {} })
  dims!: Record<string, string>;

  @Prop({ type: Number, default: 0 })
  value!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const MetricDailySchema = SchemaFactory.createForClass(MetricDaily);

// Idempotent upsert target + the dashboard range scan.
MetricDailySchema.index({ metric: 1, bucket: 1, dimKey: 1 }, { unique: true });
MetricDailySchema.index({ metric: 1, bucket: 1 });
