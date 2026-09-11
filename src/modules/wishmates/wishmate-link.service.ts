import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IWishmateLink } from 'src/modules/wishlists/access/wishmate-link.port';
import { WishLink, WishLinkStatus, type WishLinkDocument } from './schemas/wish-link.schema';

/**
 * The real implementation of [IWishmateLink].
 *
 * Answers, for AccessPolicyService: may this user see a WISHMATES wishlist?
 *
 * Deliberately one query against the pair in either direction — a link row is
 * written once, by whoever asked first, and the two sides are symmetric once
 * it is accepted. Anything other than `accepted` is a no: a pending request is
 * somebody asking rather than somebody admitted, and a declined one is
 * indistinguishable from no link at all, which is how the rest of the
 * wishmates module treats it.
 */
@Injectable()
export class MongoWishmateLink implements IWishmateLink {
  constructor(@InjectModel(WishLink.name) private readonly links: Model<WishLinkDocument>) {}

  async areLinked(ownerId: Types.ObjectId, viewerId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(viewerId)) return false;
    const viewer = new Types.ObjectId(viewerId);
    // The owner is handled by the policy's own owner branch long before this,
    // but a self-link would be a nonsense row and is not a wishmate link.
    if (viewer.equals(ownerId)) return false;

    const count = await this.links
      .countDocuments({
        status: WishLinkStatus.ACCEPTED,
        $or: [
          { requesterId: ownerId, addresseeId: viewer },
          { requesterId: viewer, addresseeId: ownerId },
        ],
      })
      .exec();
    return count > 0;
  }
}
