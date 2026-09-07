import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GroupGiftStatus } from './group-gift.types';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';

/** One group gift as an invitation lists it. */
export interface EventGroupGift {
  id: string;
  title: string;
}

/**
 * The group gifts running for an event.
 *
 * A service of its own, exporting one method, for the same reason
 * [EventParticipationModule] exists: the events module needs a single narrow
 * fact from group gifting, and importing the whole module for it would build a
 * dependency far heavier than the question deserves — group gifting already
 * depends on wishlists, gifting, chat and settlements.
 */
@Injectable()
export class EventGroupGiftsService {
  constructor(
    @InjectModel(GroupGift.name)
    private readonly model: Model<GroupGiftDocument>,
  ) {}

  /**
   * Open groups only.
   *
   * A cancelled or already-purchased group is not something an invitee can
   * still join, and listing one on an invitation would invite them to.
   */
  async forEvent(eventId: Types.ObjectId): Promise<EventGroupGift[]> {
    const gifts = await this.model
      .find({
        eventId,
        status: { $in: [GroupGiftStatus.OPEN, GroupGiftStatus.FUNDED] },
      })
      .select('_id title')
      .sort({ createdAt: 1 })
      .limit(20)
      .exec();

    return gifts.map((gift) => ({
      id: gift._id.toString(),
      title: gift.title,
    }));
  }
}
