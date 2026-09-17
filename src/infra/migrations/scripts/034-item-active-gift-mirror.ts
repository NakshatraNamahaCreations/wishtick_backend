import type { mongo } from 'mongoose';

// See migration.types.ts: 'mongodb' is a phantom dependency with two copies.
type Db = mongo.Db;
import type { Migration } from '../migration.types';

/**
 * Copies each active gift's id and buyer onto its item.
 *
 * GiftStatusService writes these for every gift from now on, and the item view
 * reads them to tell a buyer the item is theirs — to undo it, or to put their
 * name on it — and "Gift Now" reads them to let the holder back to the shop.
 * A gift made before this deploy has an item with none of them, so its buyer
 * would be treated as a stranger to their own gift until it moved again.
 *
 * Names stay hidden: nobody has chosen to show one yet, and the defaults on
 * the schema already say so.
 */
export const migration034: Migration = {
  id: '034-item-active-gift-mirror',
  description: 'Mirror the active gift id and buyer onto wishlist items',

  up: async (db: Db): Promise<void> => {
    const active = db
      .collection<{ itemId: mongo.ObjectId; gifterId: mongo.ObjectId }>('gifts')
      .find({ active: true }, { projection: { _id: 1, itemId: 1, gifterId: 1 } });

    for await (const gift of active) {
      await db.collection('wishlist_items').updateOne(
        { _id: gift.itemId, activeGiftId: null },
        {
          $set: {
            activeGiftId: gift._id,
            activeGiftBuyerId: gift.gifterId,
            activeGiftShowName: false,
            activeGiftByOwner: false,
          },
        },
      );
    }
  },

  down: async (db: Db): Promise<void> => {
    await db.collection('wishlist_items').updateMany(
      {},
      {
        $unset: {
          activeGiftId: '',
          activeGiftBuyerId: '',
          activeGiftShowName: '',
          activeGiftByOwner: '',
        },
      },
    );
  },
};
