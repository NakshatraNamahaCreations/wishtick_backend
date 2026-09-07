import type { OrderStage } from './order.types';
import { ORDER_STAGE_SEQUENCE, type OrderStageSource, stageIndex } from './order.types';
import type { OrderDocument } from './schemas/order.schema';

/**
 * One row of the Track Order timeline.
 *
 * Every stage in the sequence is returned, reached or not, so the client
 * renders the same six rows for every order and never has to know the running
 * order of stages itself. `at` is null for a stage that has not happened —
 * which is the difference between "not yet" and "we don't know".
 */
export interface OrderStageView {
  stage: OrderStage;
  reached: boolean;
  at: Date | null;
  source: OrderStageSource | null;
  note: string | null;
}

export interface OrderView {
  id: string;
  giftId: string;
  itemId: string;
  /** The human-facing `WTK-…` reference. */
  reference: string;
  stage: OrderStage;
  timeline: OrderStageView[];
  amountMinor: number | null;
  currency: string;

  /**
   * Carrier detail. Every field here is null until a logistics feed exists —
   * clients must render "not available yet", never a placeholder that reads
   * like real courier data.
   */
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  deliveryMethod: string | null;
  estimatedDeliveryFrom: Date | null;
  estimatedDeliveryTo: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export const toOrderView = (order: OrderDocument): OrderView => {
  const reachedAt = new Map(order.timeline.map((entry) => [entry.stage, entry]));
  const current = stageIndex(order.stage);

  return {
    id: order._id.toString(),
    giftId: order.giftId.toString(),
    itemId: order.itemId.toString(),
    reference: order.reference,
    stage: order.stage,
    timeline: ORDER_STAGE_SEQUENCE.map((stage) => {
      const entry = reachedAt.get(stage);
      return {
        stage,
        // A stage counts as reached if it was recorded, or if the order has
        // moved past it — carriers skip stages, and a timeline that showed
        // "Shipped" as pending under "Out for delivery" would read as broken.
        reached: entry !== undefined || stageIndex(stage) <= current,
        at: entry?.at ?? null,
        source: entry?.source ?? null,
        note: entry?.note ?? null,
      };
    }),
    amountMinor: order.amountMinor,
    currency: order.currency,
    courier: order.courier,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    deliveryMethod: order.deliveryMethod,
    estimatedDeliveryFrom: order.estimatedDeliveryFrom,
    estimatedDeliveryTo: order.estimatedDeliveryTo,
    deliveredAt: order.deliveredAt,
    createdAt: order.createdAt,
  };
};
