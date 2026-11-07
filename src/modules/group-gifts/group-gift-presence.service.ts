import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IGroupGiftPresence } from 'src/modules/wishlists/access/group-gift-presence.port';
import { GroupGiftStatus } from './group-gift.types';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';

/**
 * The statuses in which a group gift still has people's money or promises on
 * it. Finished groups (cancelled, refunding, purchased, fulfilled) are not in
 * the way of anything.
 */
export const ACTIVE_GROUP_GIFT_STATUSES: readonly GroupGiftStatus[] = [
  GroupGiftStatus.OPEN,
  GroupGiftStatus.CLOSED,
  GroupGiftStatus.FUNDED,
  GroupGiftStatus.PURCHASING,
];

/**
 * Answers [IGroupGiftPresence] from the GroupGift collection.
 *
 * Registered through GroupGiftPresenceModule with only the GroupGift model, so
 * WishlistsModule can import it without reaching the full GroupGiftModule
 * (which depends on wishlists itself). Uses the `{wishlistId, status}` index.
 */
@Injectable()
export class MongoGroupGiftPresence implements IGroupGiftPresence {
  constructor(
    @InjectModel(GroupGift.name)
    private readonly model: Model<GroupGiftDocument>,
  ) {}

  async hasActiveGroupGift(wishlistId: Types.ObjectId | string): Promise<boolean> {
    const id = typeof wishlistId === 'string' ? new Types.ObjectId(wishlistId) : wishlistId;
    const found = await this.model
      .exists({ wishlistId: id, status: { $in: ACTIVE_GROUP_GIFT_STATUSES } })
      .exec();
    return found !== null;
  }
}
