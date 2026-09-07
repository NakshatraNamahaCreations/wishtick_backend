import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { UsersService } from 'src/modules/users/users.service';
import {
  UserProfile,
  type UserProfileDocument,
} from 'src/modules/profile/schemas/user-profile.schema';
import { AccessPolicyService } from './access/access-policy.service';
import { WishlistItem, type WishlistItemDocument } from './schemas/wishlist-item.schema';
import type { WishlistDocument } from './schemas/wishlist.schema';
import { WishlistsService } from './wishlists.service';
import { CLAIMED_ITEM_STATUSES } from './wishlist.types';
import type { OpenGraphPreview, PublicItemView, PublicWishlistView } from './wishlist.views';

@Injectable()
export class PublicWishlistsService {
  constructor(
    @InjectModel(WishlistItem.name) private readonly items: Model<WishlistItemDocument>,
    @InjectModel(UserProfile.name) private readonly profiles: Model<UserProfileDocument>,
    private readonly wishlists: WishlistsService,
    private readonly access: AccessPolicyService,
    private readonly users: UsersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Resolves a share slug to a wishlist the caller may actually open.
   *
   * The error codes here are deliberately more specific than elsewhere: the
   * caller already holds the link, so telling them "this needs a passcode" or
   * "this link expired" reveals nothing they did not have, and the alternative
   * is a dead end they cannot act on. An unknown or non-linkable slug is a flat
   * 404 — that must not confirm a private list exists.
   */
  private async resolveBySlug(
    slug: string,
    passcode?: string,
    viewerUserId?: string,
  ): Promise<WishlistDocument> {
    const wishlist = await this.wishlists.findBySlug(slug);
    if (!wishlist || wishlist.archivedAt) {
      throw new AppException(ErrorCode.SHARE_LINK_INVALID, 'This link is not valid', 404);
    }

    if (wishlist.share.expiresAt && wishlist.share.expiresAt.getTime() < Date.now()) {
      throw new AppException(ErrorCode.SHARE_LINK_EXPIRED, 'This link has expired', 410);
    }

    if (wishlist.share.passcodeHash && !passcode) {
      throw new AppException(ErrorCode.SHARE_PASSCODE_REQUIRED, 'This link needs a passcode', 401);
    }

    // The policy is still the authority: it is what refuses a PRIVATE list even
    // when the slug is correct.
    //
    // The viewer is passed as well as the link, because who is asking can only
    // widen what the policy allows: an EVENT_ONLY list opens for an accepted
    // guest of its event, and the owner arriving through their own link is
    // still the owner. Resolving on the link alone refused an event's guests
    // the very list the invitation had just offered them — the invite view
    // resolves *with* a viewer, so it listed a slug this route would not open.
    const decision = await this.access.resolve(wishlist, {
      userId: viewerUserId,
      share: { slug, passcode },
    });
    if (!decision.canView) {
      if (wishlist.share.passcodeHash && passcode) {
        throw new AppException(ErrorCode.SHARE_PASSCODE_INVALID, 'Incorrect passcode', 403);
      }
      throw new AppException(ErrorCode.SHARE_LINK_INVALID, 'This link is not valid', 404);
    }

    return wishlist;
  }

  /**
   * The unauthenticated view of a shared wishlist.
   *
   * Built from an explicit allowlist of fields rather than by deleting things
   * from the internal document: a redaction that works by subtraction leaks
   * every field added later, and this response goes to anyone with a link.
   *
   * Withheld on purpose:
   *  - the owner's email, phone, delivery address, and date of birth;
   *  - the owner's user id (an identifier to correlate across lists);
   *  - who reserved or bought anything, and which of the claimed statuses it is;
   *  - participants, chat, share settings, and internal counters.
   */
  async getBySlug(
    slug: string,
    passcode?: string,
    viewerUserId?: string,
  ): Promise<PublicWishlistView> {
    const wishlist = await this.resolveBySlug(slug, passcode, viewerUserId);

    const [items, ownerFirstName] = await Promise.all([
      this.items
        .find({ wishlistId: wishlist._id, archivedAt: null })
        .sort({ position: 1, _id: 1 })
        .limit(500)
        .exec(),
      this.ownerFirstName(wishlist),
    ]);

    return {
      title: wishlist.title,
      description: wishlist.description,
      coverUrl: wishlist.coverUrl,
      ownerFirstName,
      itemCount: items.length,
      items: items.map((item) => PublicWishlistsService.toPublicItem(item)),
    };
  }

  /** Open Graph tags for a WhatsApp/social link preview. */
  async getPreviewBySlug(slug: string, passcode?: string): Promise<OpenGraphPreview> {
    const wishlist = await this.resolveBySlug(slug, passcode);
    const ownerFirstName = await this.ownerFirstName(wishlist);
    const webUrl = this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');

    return {
      title: wishlist.title,
      // A preview is unfurled by WhatsApp's servers and shown in the chat before
      // anyone opens the link, so it carries even less than the public view.
      description:
        wishlist.description ??
        (ownerFirstName
          ? `${ownerFirstName} shared a wishlist on Wishtick`
          : 'A Wishtick wishlist'),
      image: wishlist.coverUrl,
      url: `${webUrl}/w/${wishlist.share.slug}`,
      type: 'website',
      siteName: 'Wishtick',
    };
  }

  /**
   * First name only.
   *
   * "Aarav's wishlist" is the point of sharing; "Aarav Sharma" plus a photo and
   * a delivery address is a profile a stranger can act on. Falls back to null
   * rather than inventing a placeholder.
   */
  private async ownerFirstName(wishlist: WishlistDocument): Promise<string | null> {
    const profile = await this.profiles
      .findOne({ userId: wishlist.ownerId })
      .select('displayName')
      .exec();
    const fromProfile = profile?.displayName;
    if (fromProfile) return fromProfile.trim().split(/\s+/)[0] ?? null;

    const user = await this.users.findById(wishlist.ownerId);
    const fromUser = user?.name;
    return fromUser ? (fromUser.trim().split(/\s+/)[0] ?? null) : null;
  }

  private static toPublicItem(item: WishlistItemDocument): PublicItemView {
    return {
      id: item._id.toString(),
      title: item.title,
      notes: item.notes,
      imageUrls: item.imageUrls,
      productLink: item.productLink,
      price: {
        amountMinor: item.price?.amountMinor ?? null,
        currency: item.price?.currency ?? 'INR',
      },
      category: item.category,
      priority: item.priority,
      importance: item.importance,
      quantity: item.quantity,
      giftPreferences: {
        color: item.giftPreferences?.color ?? null,
        size: item.giftPreferences?.size ?? null,
        variantNotes: item.giftPreferences?.variantNotes ?? null,
      },
      // A boolean, never the status or the gifter. Enough to prevent duplicate
      // gifting; not enough to reveal who is buying what.
      isClaimed: CLAIMED_ITEM_STATUSES.includes(item.status),
    };
  }
}
