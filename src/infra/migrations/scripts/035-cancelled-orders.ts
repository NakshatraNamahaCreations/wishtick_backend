import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Marks orders whose gift was already withdrawn.
 *
 * `Order.cancelledAt` is written from the gift-cancelled event from now on, but
 * nothing emitted that event before this deploy: every gift withdrawn until now
 * left its order sitting at whatever stage it had reached, indistinguishable
 * from one still on its way. Those are exactly the orders a late courier event
 * would still move, so they are closed here.
 *
 * The gift's own `cancelledAt` is used as the date where it has one, so the
 * order does not claim to have been called off today.
 */
export const migration035: Migration = {
  id: '035-cancelled-orders',
  description: 'Mark orders whose gift was cancelled before the event existed',

  up: async (db: Db): Promise<void> => {
    const cancelled = db
      .collection<{ _id: mongo.ObjectId; cancelledAt?: Date }>('gifts')
      .find({ status: 'cancelled' }, { projection: { _id: 1, cancelledAt: 1 } });

    for await (const gift of cancelled) {
      await db.collection('orders').updateOne(
        { giftId: gift._id, cancelledAt: null, stage: { $ne: 'delivered' } },
        {
          $set: {
            cancelledAt: gift.cancelledAt ?? new Date(),
            cancelledNote: 'The gifter withdrew this gift',
          },
        },
      );
    }
  },

  down: async (db: Db): Promise<void> => {
    await db
      .collection('orders')
      .updateMany({}, { $unset: { cancelledAt: '', cancelledNote: '' } });
  },
};
