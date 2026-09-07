import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import { AccessPolicyService } from 'src/modules/wishlists/access/access-policy.service';
import type { AccessContext } from 'src/modules/wishlists/access/access.types';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import type { WishlistDocument } from 'src/modules/wishlists/schemas/wishlist.schema';
import { WishlistItemStatus } from 'src/modules/wishlists/wishlist.types';
import { toItemView, type ItemView } from 'src/modules/wishlists/wishlist.views';
import { WishlistsService } from 'src/modules/wishlists/wishlists.service';
import type { ImportProductDto } from './dto/product.dto';
import { ProductsService } from './products.service';

const POSITION_GAP = 1_000;
const MAX_ITEMS_PER_WISHLIST = 500;

@Injectable()
export class ProductImportService {
  private readonly logger = new Logger(ProductImportService.name);

  constructor(
    @InjectModel(WishlistItem.name) private readonly items: Model<WishlistItemDocument>,
    private readonly products: ProductsService,
    private readonly wishlists: WishlistsService,
    private readonly access: AccessPolicyService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /**
   * Imports a catalogue product into a wishlist.
   *
   * **Snapshot, don't reference.** The item gets its own copy of the title,
   * price, image, and link. It would be tidier to store only `sourceProductId`
   * and join at read time, and it would be wrong: the upstream catalogue is
   * someone else's mutable data. A user who added "Blue headphones, ₹2,499"
   * must keep seeing that, even after the merchant renames the listing, drops
   * the price, or reuses the id for a toaster. The nightly sync (see
   * AffiliateSyncProcessor) *flags* upstream changes; it never rewrites what
   * the user chose.
   *
   * `sourceProductId` is still stored — for sync, click attribution, and
   * analytics — but nothing reads through it for display.
   */
  async importToWishlist(
    wishlistId: string,
    ctx: AccessContext,
    dto: ImportProductDto,
  ): Promise<ItemView> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);
    return toItemView(await this.importForWishlist(wishlist, dto));
  }

  /**
   * The import itself, for a caller that has *already* established authority.
   *
   * The only such caller is the group-gift "Add Another Gift" flow, where the
   * host adds a product to the recipient's list — something no other path
   * permits. Its authority is having initiated that group gift, which this
   * service cannot check, so the access decision stays with the caller and is
   * deliberately absent here.
   */
  async importForWishlist(
    wishlist: WishlistDocument,
    dto: ImportProductDto,
    options: { hiddenFromOwner?: boolean } = {},
  ): Promise<WishlistItemDocument> {
    const count = await this.items
      .countDocuments({ wishlistId: wishlist._id, archivedAt: null })
      .exec();
    if (count >= MAX_ITEMS_PER_WISHLIST) {
      throw new AppException(
        ErrorCode.WISHLIST_LIMIT_REACHED,
        `A wishlist can hold at most ${MAX_ITEMS_PER_WISHLIST} items`,
        409,
      );
    }

    const snapshot = await this.products.resolveForImport(dto.provider, dto.externalId);

    // The provider's category is only usable if it maps onto our taxonomy. An
    // unmapped one is dropped rather than stored: a category key that fails
    // validation everywhere else would poison the Sprint 11 analytics.
    let category: string | null = null;
    if (snapshot.category) {
      const valid = await this.taxonomy.validKeys(TaxonomyKind.GIFT_CATEGORY);
      if (valid.has(snapshot.category)) category = snapshot.category;
      else this.logger.warn(`Provider category "${snapshot.category}" is not in our taxonomy`);
    }

    const last = await this.items
      .findOne({ wishlistId: wishlist._id })
      .sort({ position: -1 })
      .select('position')
      .exec();

    const item = await this.items.create({
      wishlistId: wishlist._id,
      ownerId: wishlist.ownerId,
      // Every field below is a COPY taken at this instant, deliberately.
      title: snapshot.title.slice(0, 200),
      notes: dto.notes ?? null,
      // Set only by the "Gift Now" path, which saves to the buyer's own list
      // on someone else's behalf. A plain "Add to Wishlist" leaves both null.
      recipientName: dto.recipientName ?? null,
      relation: dto.relation ?? null,
      imageUrls: snapshot.imageUrls.slice(0, 5),
      productLink: snapshot.productUrl,
      price: { amountMinor: snapshot.amountMinor, currency: snapshot.currency },
      category,
      priority: dto.priority ?? 3,
      quantity: dto.quantity ?? 1,
      status: WishlistItemStatus.AVAILABLE,
      hiddenFromOwner: options.hiddenFromOwner ?? false,
      // Kept for sync and click attribution — never for display.
      sourceProductId: snapshot._id,
      position: (last?.position ?? 0) + POSITION_GAP,
    });

    await this.wishlists.recount(wishlist._id);
    this.logger.log(
      `Imported ${dto.provider}/${dto.externalId} into wishlist ${wishlist._id.toString()}`,
    );
    return item;
  }

  /** Items across all active wishlists that came from a given product. */
  async itemsForProduct(productId: Types.ObjectId): Promise<WishlistItemDocument[]> {
    return this.items.find({ sourceProductId: productId, archivedAt: null }).exec();
  }
}
