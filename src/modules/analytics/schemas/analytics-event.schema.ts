import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type AnalyticsEventDocument = HydratedDocument<AnalyticsEvent>;

/**
 * The raw, append-only event stream — the source of truth for every metric.
 *
 * High-volume and self-expiring (TTL), so dashboards NEVER scan it directly:
 * the rollup worker pre-aggregates it into MetricDaily, and the DAU/WAU/MAU the
 * dashboard shows must reconcile with a direct recount here (that reconciliation
 * is an exit criterion). `userId` is null for a pre-signup/anonymous event, in
 * which case `anonymousId` carries the client id.
 */
@Schema({ collection: 'analytics_events', timestamps: false })
export class AnalyticsEvent {
  _id!: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  userId!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  anonymousId!: string | null;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: SchemaTypes.Mixed, default: {} })
  props!: Record<string, unknown>;

  /** Acquisition/UTM-style source, when known. */
  @Prop({ type: String, default: null })
  source!: string | null;

  @Prop({ type: Date, required: true })
  ts!: Date;
}

export const AnalyticsEventSchema = SchemaFactory.createForClass(AnalyticsEvent);

// Rollups scan by (name, time) and by (user, time) for active-user counts.
AnalyticsEventSchema.index({ name: 1, ts: 1 });
AnalyticsEventSchema.index({ ts: 1, userId: 1 });
// 180-day TTL. Rollups run long before this, so aggregates outlive the raw rows.
AnalyticsEventSchema.index({ ts: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
