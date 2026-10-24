import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { AppConfig } from 'src/config/configuration';
import { AccessPolicyService } from './access/access-policy.service';
import { Wishlist, type WishlistDocument } from './schemas/wishlist.schema';
import { toWishlistView, type WishlistView } from './wishlist.views';

/** More than anyone keeps going at once; a profile is not an archive. */
const MAX_LISTED = 50;

/**
 * Somebody's wishlists, as the person looking at their profile may see them:
 * the ones shared with their WishMates, the public ones, and any they were
 * added to themselves.
 *
 * Decided by the same access policy as opening a list — nothing here judges
 * visibility on its own — so a list shown on the profile is always one that
 * opens when tapped, and a private one never appears.
 */
@Injectable()
export class PersonWishlistsService {
  constructor(
    @InjectModel(Wishlist.name) private readonly model: Model<WishlistDocument>,
    private readonly access: AccessPolicyService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async listFor(viewerId: string, ownerId: string): Promise<WishlistView[]> {
    if (!Types.ObjectId.isValid(ownerId) || viewerId === ownerId) return [];
    const lists = await this.model
      .find({ ownerId: new Types.ObjectId(ownerId), archivedAt: null })
      .sort({ updatedAt: -1 })
      .limit(MAX_LISTED)
      .exec();
    const shareBaseUrl = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');

    const views: WishlistView[] = [];
    for (const list of lists) {
      const decision = await this.access.resolve(list, { userId: viewerId });
      if (decision.canView) views.push(toWishlistView(list, decision, shareBaseUrl));
    }
    return views;
  }
}
