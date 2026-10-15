import type { mongo } from 'mongoose';
import { HOST_SHARE_KEY } from 'src/modules/group-gifts/group-gift-share.service';

type Doc = mongo.Document;

/**
 * How a group-gift payment stands, as support reads it.
 *
 * Members pay the host outside Wishtick, so a chip-in is a claim (`pledged`)
 * until the host says what arrived. The stored status alone cannot say
 * "the host got less than claimed" or "the member says they did pay" — those
 * come from `claimedMinor` and `disputedAt` — so the admin side derives one
 * state from the whole row, the same way the app's view does.
 */
export type PaymentState =
  'awaiting' | 'received' | 'partial' | 'not_received' | 'refunded' | 'disputed';

/** Who a payment came from, as far as the money is concerned. */
export type PaymentKind = 'member' | 'host_share' | 'settle_up';

const date = (v: unknown): Date | null => (v instanceof Date ? v : null);
const amount = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Disputed: the member said "I did pay" after the host last answered. */
export function isDisputed(d: Doc): boolean {
  const disputedAt = date(d.disputedAt);
  if (!disputedAt || d.status === 'refunded') return false;
  const reviewedAt = date(d.reviewedAt);
  return !reviewedAt || disputedAt.getTime() > reviewedAt.getTime();
}

export function paymentStateOf(d: Doc): PaymentState {
  if (isDisputed(d)) return 'disputed';
  switch (d.status) {
    case 'pledged':
      return 'awaiting';
    case 'not_received':
      return 'not_received';
    case 'refunded':
      return 'refunded';
  }
  const claimed = amount(d.claimedMinor);
  const received = amount(d.amountMinor);
  return claimed !== null && received !== null && received < claimed ? 'partial' : 'received';
}

export function paymentKindOf(d: Doc): PaymentKind {
  const key = typeof d.idempotencyKey === 'string' ? d.idempotencyKey : '';
  if (key === HOST_SHARE_KEY) return 'host_share';
  if (key.startsWith('settle:')) return 'settle_up';
  return 'member';
}

/**
 * The Mongo filter for contributions in one [state] — what the payments list
 * filters on. One `$expr` each, with missing fields read as null: rows from
 * before claims existed carry no `disputedAt`/`claimedMinor` at all.
 */
export function paymentStateFilter(state: PaymentState): Doc {
  const nullish = (field: string) => ({ $eq: [{ $ifNull: [`$${field}`, null] }, null] });
  const disputed = {
    $and: [
      { $not: [nullish('disputedAt')] },
      { $or: [nullish('reviewedAt'), { $gt: ['$disputedAt', '$reviewedAt'] }] },
    ],
  };
  const notDisputed = { $not: [disputed] };
  const short = {
    $and: [{ $not: [nullish('claimedMinor')] }, { $lt: ['$amountMinor', '$claimedMinor'] }],
  };
  switch (state) {
    case 'disputed':
      return { status: { $ne: 'refunded' }, $expr: disputed };
    case 'awaiting':
      return { status: 'pledged', $expr: notDisputed };
    case 'not_received':
      return { status: 'not_received', $expr: notDisputed };
    case 'refunded':
      return { status: 'refunded' };
    case 'partial':
      return { status: 'confirmed', $expr: { $and: [notDisputed, short] } };
    case 'received':
      return { status: 'confirmed', $expr: { $and: [notDisputed, { $not: [short] }] } };
  }
}

/** The filter for one [kind] of payment. */
export function paymentKindFilter(kind: PaymentKind): Doc {
  if (kind === 'host_share') return { idempotencyKey: HOST_SHARE_KEY };
  if (kind === 'settle_up') return { idempotencyKey: { $regex: '^settle:' } };
  return { idempotencyKey: { $ne: HOST_SHARE_KEY, $not: /^settle:/ } };
}

/**
 * Pipeline stages that attach each payment's gift status as `gift.status`, for
 * leaving out the payments of gifts nobody can act on any more.
 */
export function withGiftStatus(giftCollection: string): Doc[] {
  return [
    {
      $lookup: {
        from: giftCollection,
        localField: 'groupGiftId',
        foreignField: '_id',
        as: 'gift',
      },
    },
    { $set: { gift: { $arrayElemAt: ['$gift', 0] } } },
  ];
}

/** The view every payment row shares: money page, user page, payments list. */
export function paymentFields(d: Doc): Record<string, unknown> {
  return {
    claimedMinor: amount(d.claimedMinor),
    receivedMinor:
      d.status === 'confirmed' || d.status === 'refunded' ? amount(d.amountMinor) : null,
    payment: paymentStateOf(d),
    kind: paymentKindOf(d),
    paymentRef: typeof d.paymentRef === 'string' && d.paymentRef ? d.paymentRef : null,
    reviewedAt: date(d.reviewedAt),
    disputedAt: date(d.disputedAt),
    refundedAt: date(d.refundedAt),
  };
}
