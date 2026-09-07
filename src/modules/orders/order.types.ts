/**
 * The six stages the Track Order screen (Figma `299:1513`) shows, in order.
 *
 * They are a *superset* of what Wishtick can currently observe. Items are
 * bought at the merchant through the affiliate redirect, so the only stages we
 * ever fill ourselves are the first two; the rest need a courier feed that does
 * not exist yet. Unreached stages are reported as pending rather than invented
 * — see OrderStageEntry.source for who filled each one.
 */
export enum OrderStage {
  /** The gifter told us they are buying it. Mirrors gift → purchased. */
  ORDER_CONFIRMED = 'order_confirmed',
  /** The affiliate network confirmed the sale. Mirrors an `order` webhook. */
  PAYMENT_CONFIRMED = 'payment_confirmed',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  DELIVERED = 'delivered',
}

/** Display order, and the order a timeline must advance in. */
export const ORDER_STAGE_SEQUENCE: OrderStage[] = [
  OrderStage.ORDER_CONFIRMED,
  OrderStage.PAYMENT_CONFIRMED,
  OrderStage.PROCESSING,
  OrderStage.SHIPPED,
  OrderStage.OUT_FOR_DELIVERY,
  OrderStage.DELIVERED,
];

/**
 * Who put a stage on the timeline.
 *
 * Recorded so a reader can always tell an observed fact from an inferred one:
 * `gift` means a Wishtick state change implied it, `affiliate_webhook` means
 * the network confirmed the sale, `courier_webhook` means a carrier reported
 * it, `manual` means a human (support/admin) set it.
 */
export enum OrderStageSource {
  GIFT = 'gift',
  AFFILIATE_WEBHOOK = 'affiliate_webhook',
  COURIER_WEBHOOK = 'courier_webhook',
  MANUAL = 'manual',
}

/** An order stops moving once it reaches one of these. */
export const TERMINAL_ORDER_STAGES: OrderStage[] = [OrderStage.DELIVERED];

export const stageIndex = (stage: OrderStage): number => ORDER_STAGE_SEQUENCE.indexOf(stage);

/**
 * Whether `to` may follow `from`.
 *
 * Forward-only, and skipping is allowed: a courier that reports "shipped"
 * without ever having reported "processing" is common, and refusing it would
 * strand the order. Backwards is refused — a delivered parcel does not become
 * un-delivered.
 */
export const canAdvanceTo = (from: OrderStage, to: OrderStage): boolean =>
  stageIndex(to) > stageIndex(from);
