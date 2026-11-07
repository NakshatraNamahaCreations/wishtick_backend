import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/** The statuses a gift only reaches by having funded at some point. */
const FUNDED_OR_LATER = ['funded', 'purchasing', 'purchased', 'fulfilled'];

interface HistoryEntry {
  status: string;
  at: Date;
}

/**
 * The deadline, the "I've sent it" step, and the fields that count fundings.
 *
 * Three things change shape here:
 *
 *  - A payment's transaction ID becomes unique per gift. Any gift carrying the
 *    same ref on two payments has the duplicates cleared first — the oldest
 *    keeps it, the rest lose it — because the index cannot be built over them,
 *    and a shared ref proved nothing anyway.
 *  - A `pledged` row used to mean "I paid"; from now it means "I will". Every
 *    existing pledge is therefore marked sent as of when it was made, so the
 *    host is still asked about it rather than the contributor being chased to
 *    send money they already sent.
 *  - A gift now remembers how many times it has funded, and when. Rebuilt from
 *    the history for gifts that funded before this; a gift past `funded` with
 *    no such entry (only possible through an old reconcile) counts as once.
 *
 * Everything else is a null or an empty list, set explicitly rather than left
 * to the schema's defaults so a raw read sees the same document the model does.
 */
export const migration048: Migration = {
  id: '048-group-gift-deadlines',
  description:
    'Closed collections and sent payments: unique payment refs, sentAt backfill, funding counters',

  up: async (db: Db): Promise<void> => {
    const contributions = db.collection('contributions');
    const groupGifts = db.collection('group_gifts');

    // 1. De-duplicate refs within a gift; the oldest payment keeps it.
    const duplicates = contributions.aggregate<{
      _id: { groupGiftId: mongo.ObjectId; paymentRef: string };
      ids: mongo.ObjectId[];
    }>([
      { $match: { paymentRef: { $type: 'string' } } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: { groupGiftId: '$groupGiftId', paymentRef: '$paymentRef' },
          ids: { $push: '$_id' },
        },
      },
      { $match: { 'ids.1': { $exists: true } } },
    ]);
    for await (const dup of duplicates) {
      const [, ...later] = dup.ids;
      await contributions.updateMany({ _id: { $in: later } }, { $set: { paymentRef: null } });
    }
    await contributions.createIndex(
      { groupGiftId: 1, paymentRef: 1 },
      { unique: true, partialFilterExpression: { paymentRef: { $type: 'string' } } },
    );

    // 2. Old pledges were "I paid" claims: keep the host's question open.
    await contributions.updateMany({ status: 'pledged', sentAt: null }, [
      { $set: { sentAt: '$createdAt' } },
    ]);
    await contributions.updateMany({ sentAt: { $exists: false } }, { $set: { sentAt: null } });

    // 3. Funding counters, from the audit trail.
    const funded = groupGifts.find<{
      _id: mongo.ObjectId;
      status: string;
      history?: HistoryEntry[];
      createdAt?: Date;
      updatedAt?: Date;
    }>(
      {
        fundedCount: { $exists: false },
        $or: [{ status: { $in: FUNDED_OR_LATER } }, { 'history.status': 'funded' }],
      },
      { projection: { status: 1, history: 1, createdAt: 1, updatedAt: 1 } },
    );
    for await (const gift of funded) {
      const fundings = (gift.history ?? []).filter((h) => h.status === 'funded');
      const fundedCount = fundings.length || (FUNDED_OR_LATER.includes(gift.status) ? 1 : 0);
      const fundedAt = fundings.at(-1)?.at ?? gift.updatedAt ?? gift.createdAt ?? null;
      await groupGifts.updateOne(
        { _id: gift._id },
        { $set: { fundedCount, fundedAt: fundedCount > 0 ? fundedAt : null } },
      );
    }
    await groupGifts.updateMany(
      { fundedCount: { $exists: false } },
      { $set: { fundedCount: 0, fundedAt: null } },
    );

    // 4. The rest start empty.
    await groupGifts.updateMany(
      { closedAt: { $exists: false } },
      { $set: { closedAt: null, lastNudgeAt: null } },
    );
    await groupGifts.updateMany(
      { closeRemindersSent: { $exists: false } },
      { $set: { closeRemindersSent: [], deadlineRemindersSent: [] } },
    );

    // 5. The deadline sweep's second pass, and the wishlist archive guard.
    await groupGifts.createIndex({ status: 1, closedAt: 1 });
    await groupGifts.createIndex({ wishlistId: 1, status: 1 });
  },

  // The cleared duplicate refs are not restored: they were never telling the
  // host anything true.
  down: async (db: Db): Promise<void> => {
    const contributions = db.collection('contributions');
    const groupGifts = db.collection('group_gifts');
    await contributions.dropIndex('groupGiftId_1_paymentRef_1').catch(() => undefined);
    for (const name of ['status_1_closedAt_1', 'wishlistId_1_status_1']) {
      await groupGifts.dropIndex(name).catch(() => undefined);
    }
    await contributions.updateMany({}, { $unset: { sentAt: '' } });
    await groupGifts.updateMany(
      {},
      {
        $unset: {
          closedAt: '',
          fundedAt: '',
          fundedCount: '',
          lastNudgeAt: '',
          closeRemindersSent: '',
          deadlineRemindersSent: '',
        },
      },
    );
  },
};
