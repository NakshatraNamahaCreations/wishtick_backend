import { GroupGiftStatus } from './group-gift.types';

/** A Mongo update document, as the funding sites build theirs. */
export type GroupGiftUpdate = Record<string, Record<string, unknown>>;

/**
 * What reaching the goal writes, wherever it is reached: the status, when,
 * the next [GroupGift.fundedCount], and the history line.
 *
 * One definition, used by every place a gift can become funded — a host's
 * own contribution, a confirmed payment, settling up, a cheaper price, the
 * host's share of an equal split, a confirmed top-up. Each of them wrote its
 * own `$set` until Nov 2026, none of them counted, and so a gift funded a
 * second time (short again after a correction, then topped up) announced
 * nothing: the notification and the chat both key on the count.
 *
 * Merged into [base] so a site's own `$inc` (the money that funded it) and
 * this one's land in the same atomic write. The caller emits
 * `GROUP_GIFT_FUNDED` with the count *after* this — the row it read plus one,
 * or the document `findOneAndUpdate` hands back.
 */
export function withFunded(
  base: GroupGiftUpdate,
  opts: { at: Date; by: string; note?: string | null },
): GroupGiftUpdate {
  return {
    ...base,
    $set: { ...(base.$set ?? {}), status: GroupGiftStatus.FUNDED, fundedAt: opts.at },
    $inc: { ...(base.$inc ?? {}), fundedCount: 1 },
    $push: {
      ...(base.$push ?? {}),
      history: {
        status: GroupGiftStatus.FUNDED,
        at: opts.at,
        by: opts.by,
        note: opts.note ?? null,
      },
    },
  };
}
