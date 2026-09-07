import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, type FilterQuery } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { MediaService } from 'src/modules/media/media.service';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { TaxonomyService } from 'src/modules/taxonomy/taxonomy.service';
import { TaxonomyKind } from 'src/modules/taxonomy/taxonomy.types';
import { AccessPolicyService } from './access/access-policy.service';
import type { AccessContext } from './access/access.types';
import type { CreateItemDto, ListItemsQueryDto, UpdateItemDto } from './dto/wishlist.dto';
import { WishlistItem, type WishlistItemDocument } from './schemas/wishlist-item.schema';
import { WishlistsService } from './wishlists.service';
import { CLAIMED_ITEM_STATUSES, WishlistItemStatus } from './wishlist.types';
import { toItemView, type ItemView } from './wishlist.views';

/**
 * Gap between adjacent positions.
 *
 * Sparse spacing means inserting between two items usually just picks the
 * midpoint and writes one row, instead of renumbering everything after it.
 */
const POSITION_GAP = 1_000;

const MAX_ITEMS_PER_WISHLIST = 500;

@Injectable()
export class ItemsService {
  constructor(
    @InjectModel(WishlistItem.name) private readonly model: Model<WishlistItemDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly wishlists: WishlistsService,
    private readonly access: AccessPolicyService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
  ) {}

  // ── Read ──────────────────────────────────────────────────────────────────

  async list(
    wishlistId: string,
    ctx: AccessContext,
    query: ListItemsQueryDto,
  ): Promise<ItemView[]> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanView(wishlist, ctx);

    // The owner's view masks surprise reservations (see toItemView); everyone
    // else sees the true claimed status so duplicate gifting is still
    // prevented.
    const maskForOwner = wishlist.ownerId.toString() === ctx.userId;

    const filter: FilterQuery<WishlistItemDocument> = {
      wishlistId: wishlist._id,
      archivedAt: null,
      // Items a *host* added for a group gift are not the owner's own, and
      // showing them would spoil the surprise — see WishlistItem.hiddenFromOwner.
      ...(maskForOwner ? { hiddenFromOwner: { $ne: true } } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
    };

    const items = await this.model
      .find(filter)
      .sort({ position: 1, _id: 1 })
      .limit(MAX_ITEMS_PER_WISHLIST)
      .exec();

    return items.map((item) => toItemView(item, maskForOwner));
  }

  async getOne(wishlistId: string, itemId: string, ctx: AccessContext): Promise<ItemView> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanView(wishlist, ctx);
    const maskForOwner = wishlist.ownerId.toString() === ctx.userId;
    const item = await this.findItemOrFail(wishlist._id, itemId);
    // Same 404 the list gives by omission — a hidden item must not be
    // reachable by guessing its id either.
    if (maskForOwner && item.hiddenFromOwner) {
      throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
    }
    return toItemView(item, maskForOwner);
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  async create(wishlistId: string, ctx: AccessContext, dto: CreateItemDto): Promise<ItemView> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);

    const count = await this.model
      .countDocuments({ wishlistId: wishlist._id, archivedAt: null })
      .exec();
    if (count >= MAX_ITEMS_PER_WISHLIST) {
      throw new AppException(
        ErrorCode.WISHLIST_LIMIT_REACHED,
        `A wishlist can hold at most ${MAX_ITEMS_PER_WISHLIST} items`,
        409,
      );
    }

    await this.taxonomy.assertValidOne(TaxonomyKind.GIFT_CATEGORY, dto.category, 'category');
    await this.taxonomy.assertValidOne(TaxonomyKind.OCCASION, dto.occasionKey, 'occasionKey');
    const imageUrls = await this.resolveImages(ctx.userId!, dto.mediaIds ?? []);

    const item = await this.model.create({
      wishlistId: wishlist._id,
      ownerId: wishlist.ownerId,
      title: dto.title,
      notes: dto.notes ?? null,
      recipientName: dto.recipientName ?? null,
      relation: dto.relation ?? null,
      occasionKey: dto.occasionKey ?? null,
      imageUrls,
      mediaIds: (dto.mediaIds ?? []).map((id) => new Types.ObjectId(id)),
      productLink: dto.productLink ?? null,
      price: {
        amountMinor: dto.price?.amountMinor ?? null,
        currency: dto.price?.currency ?? 'INR',
      },
      category: dto.category ?? null,
      priority: dto.priority ?? 3,
      importance: dto.importance,
      quantity: dto.quantity ?? 1,
      giftPreferences: {
        color: dto.giftPreferences?.color ?? null,
        size: dto.giftPreferences?.size ?? null,
        variantNotes: dto.giftPreferences?.variantNotes ?? null,
      },
      status: WishlistItemStatus.AVAILABLE,
      position: await this.nextPosition(wishlist._id),
    });

    await this.wishlists.recount(wishlist._id);
    return toItemView(item);
  }

  async update(
    wishlistId: string,
    itemId: string,
    ctx: AccessContext,
    dto: UpdateItemDto,
  ): Promise<ItemView> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);

    const item = await this.findItemOrFail(wishlist._id, itemId);

    // Once someone has committed to an item, its substance is frozen. Editing
    // "Blue headphones" into "A toaster" after a gifter has bought the
    // headphones strands them with the wrong gift and no way to know.
    // Presentation-only fields (priority, notes) stay editable.
    if (CLAIMED_ITEM_STATUSES.includes(item.status)) {
      const substantive = ['title', 'price', 'productLink', 'quantity', 'giftPreferences'] as const;
      const changed = substantive.filter((f) => dto[f] !== undefined);
      if (changed.length > 0) {
        throw new AppException(
          ErrorCode.WISHLIST_ITEM_LOCKED,
          `Someone has already claimed this item, so ${changed.join(', ')} cannot be changed`,
          409,
          { status: item.status, lockedFields: changed },
        );
      }
    }

    if (dto.category !== undefined) {
      await this.taxonomy.assertValidOne(TaxonomyKind.GIFT_CATEGORY, dto.category, 'category');
      item.category = dto.category;
    }

    if (dto.occasionKey !== undefined) {
      await this.taxonomy.assertValidOne(TaxonomyKind.OCCASION, dto.occasionKey, 'occasionKey');
      item.occasionKey = dto.occasionKey;
    }

    if (dto.title !== undefined) item.title = dto.title;
    if (dto.notes !== undefined) item.notes = dto.notes;
    // Who/why this was added is organizational context, not what the item is —
    // unlike title/price/productLink, it stays editable after a claim.
    if (dto.recipientName !== undefined) item.recipientName = dto.recipientName;
    if (dto.relation !== undefined) item.relation = dto.relation;
    if (dto.productLink !== undefined) item.productLink = dto.productLink;
    if (dto.priority !== undefined) item.priority = dto.priority;
    if (dto.importance !== undefined) item.importance = dto.importance;
    if (dto.quantity !== undefined) item.quantity = dto.quantity;

    if (dto.price !== undefined) {
      item.price = {
        amountMinor: dto.price.amountMinor ?? item.price?.amountMinor ?? null,
        currency: dto.price.currency ?? item.price?.currency ?? 'INR',
      };
    }

    if (dto.giftPreferences !== undefined) {
      item.giftPreferences = {
        color: dto.giftPreferences.color ?? item.giftPreferences?.color ?? null,
        size: dto.giftPreferences.size ?? item.giftPreferences?.size ?? null,
        variantNotes:
          dto.giftPreferences.variantNotes ?? item.giftPreferences?.variantNotes ?? null,
      };
    }

    if (dto.mediaIds !== undefined) {
      item.imageUrls = await this.resolveImages(ctx.userId!, dto.mediaIds);
      item.mediaIds = dto.mediaIds.map((id) => new Types.ObjectId(id));
    }

    await item.save();
    return toItemView(item);
  }

  async remove(wishlistId: string, itemId: string, ctx: AccessContext): Promise<void> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);

    const item = await this.findItemOrFail(wishlist._id, itemId);

    // Deleting an item someone has bought would erase their gift from the
    // product without telling them.
    if (CLAIMED_ITEM_STATUSES.includes(item.status)) {
      throw new AppException(
        ErrorCode.WISHLIST_ITEM_LOCKED,
        'Someone has already claimed this item, so it cannot be removed',
        409,
        { status: item.status },
      );
    }

    item.archivedAt = new Date();
    await item.save();
    await this.wishlists.recount(wishlist._id);
  }

  /**
   * Applies a new manual order.
   *
   * Runs in a transaction: a reorder is one user-visible action, and a partial
   * failure would leave duplicate or missing positions — a list that renders in
   * a nonsensical order with no error to explain it. Requires a replica set,
   * which is why dev and CI both run one (see docker-compose.yml).
   */
  async reorder(wishlistId: string, ctx: AccessContext, itemIds: string[]): Promise<ItemView[]> {
    const wishlist = await this.wishlists.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);

    const active = await this.model
      .find({ wishlistId: wishlist._id, archivedAt: null })
      .select('_id')
      .exec();

    const activeIds = new Set(active.map((i) => i._id.toString()));
    const submitted = new Set(itemIds);

    // The payload must be a permutation of exactly the active items. A partial
    // list would leave the omitted rows at stale positions, silently
    // interleaving them; duplicates would make the result order-dependent.
    if (submitted.size !== itemIds.length) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'itemIds contains duplicates', 400);
    }
    if (submitted.size !== activeIds.size || [...submitted].some((id) => !activeIds.has(id))) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'itemIds must list every active item in this wishlist exactly once',
        400,
        { expected: activeIds.size, received: submitted.size },
      );
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.model.bulkWrite(
          itemIds.map((id, index) => ({
            updateOne: {
              filter: { _id: new Types.ObjectId(id), wishlistId: wishlist._id },
              update: { $set: { position: (index + 1) * POSITION_GAP } },
            },
          })),
          { session, ordered: true },
        );
      });
    } finally {
      await session.endSession();
    }

    return this.list(wishlistId, ctx, {});
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async findItemOrFail(
    wishlistId: Types.ObjectId,
    itemId: string,
  ): Promise<WishlistItemDocument> {
    if (!Types.ObjectId.isValid(itemId)) {
      throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
    }
    const item = await this.model
      .findOne({ _id: new Types.ObjectId(itemId), wishlistId, archivedAt: null })
      .exec();
    if (!item) {
      throw new AppException(ErrorCode.WISHLIST_ITEM_NOT_FOUND, 'Item not found', 404);
    }
    return item;
  }

  /** Appends after the current last item, leaving room to insert later. */
  private async nextPosition(wishlistId: Types.ObjectId): Promise<number> {
    const last = await this.model
      .findOne({ wishlistId })
      .sort({ position: -1 })
      .select('position')
      .exec();
    return (last?.position ?? 0) + POSITION_GAP;
  }

  /** Only media the caller owns, confirmed, and uploaded for a wishlist item. */
  private async resolveImages(userId: string, mediaIds: string[]): Promise<string[]> {
    if (mediaIds.length === 0) return [];
    const media = await Promise.all(mediaIds.map((id) => this.media.getReadyOwned(userId, id)));

    const wrongPurpose = media.filter((m) => m.purpose !== MediaPurpose.WISHLIST_ITEM);
    if (wrongPurpose.length > 0) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'Item images must be uploaded with purpose wishlist_item',
        400,
      );
    }
    return media.map((m) => m.url ?? '').filter(Boolean);
  }
}
