import { Injectable } from '@nestjs/common';
import type { Types } from 'mongoose';

export const GROUP_GIFT_PRESENCE = Symbol('GROUP_GIFT_PRESENCE');

/**
 * Answers "is a group gift still running on this list?" for the archive guard.
 *
 * The seam exists for the same reason [EVENT_PARTICIPATION] does: wishlists
 * must not depend on the group-gifts module (which already depends on
 * wishlists), and the only thing archiving wants from it is one boolean.
 * Implemented by MongoGroupGiftPresence, wired in via GroupGiftPresenceModule.
 *
 * "Running" means open, closed short, funded or being bought — every state in
 * which contributors still have money or a promise riding on the list. A
 * cancelled, refunding, purchased or fulfilled group is finished, and an
 * archived list no longer gets in its way.
 */
export interface IGroupGiftPresence {
  hasActiveGroupGift(wishlistId: Types.ObjectId | string): Promise<boolean>;
}

/**
 * Sees no group gifts. Kept for tests that need the wishlist domain in
 * isolation, without the group-gifts module attached.
 *
 * False here lets the archive proceed, which is the pre-guard behaviour — a
 * list with no group-gift module attached cannot have a group gift on it.
 */
@Injectable()
export class NullGroupGiftPresence implements IGroupGiftPresence {
  hasActiveGroupGift(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
