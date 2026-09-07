import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { customAlphabet } from 'nanoid';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import { MediaService } from 'src/modules/media/media.service';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { WishmateRelationship } from 'src/modules/wishmates/wishmates.views';
import { MediaPurpose } from 'src/modules/media/schemas/media.schema';
import { AccessPolicyService } from './access/access-policy.service';
import type { AccessContext } from './access/access.types';
import type { CreateWishlistDto, ShareWishlistDto, UpdateWishlistDto } from './dto/wishlist.dto';
import { WishlistItem, type WishlistItemDocument } from './schemas/wishlist-item.schema';
import { Wishlist, type WishlistDocument } from './schemas/wishlist.schema';
import { WishlistItemStatus, WishlistVisibility } from './wishlist.types';
import { toWishlistView, type WishlistView } from './wishlist.views';

/**
 * Unambiguous alphabet (no 0/O, 1/l/I) at 16 chars ≈ 2^80 of entropy.
 *
 * A share slug is a bearer credential for an unlisted list, so it must be
 * unguessable — a sequential id or a short code would let anyone enumerate
 * other people's wishlists. The alphabet matters because these get read aloud
 * and retyped.
 */
const generateSlug = customAlphabet('23456789abcdefghijkmnpqrstuvwxyz', 16);

/** One person's lists. Generous, but not "someone is scripting us". */
const MAX_ACTIVE_WISHLISTS = 100;

@Injectable()
export class WishlistsService {
  private readonly logger = new Logger(WishlistsService.name);

  constructor(
    @InjectModel(Wishlist.name) private readonly model: Model<WishlistDocument>,
    @InjectModel(WishlistItem.name) private readonly items: Model<WishlistItemDocument>,
    private readonly access: AccessPolicyService,
    private readonly media: MediaService,
    private readonly wishmates: WishmatesService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get shareBaseUrl(): string {
    return this.config.get('app.webAppUrl', { infer: true }).replace(/\/$/, '');
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  /**
   * Loads a wishlist by id, or 404s.
   *
   * Note this does NOT authorize — callers pass the result to AccessPolicy.
   * Kept separate so "does it exist" and "may you see it" cannot drift apart.
   */
  async findOrFail(wishlistId: string): Promise<WishlistDocument> {
    if (!Types.ObjectId.isValid(wishlistId)) {
      throw new AppException(ErrorCode.WISHLIST_NOT_FOUND, 'Wishlist not found', 404);
    }
    const wishlist = await this.model.findById(wishlistId).exec();
    if (!wishlist) {
      throw new AppException(ErrorCode.WISHLIST_NOT_FOUND, 'Wishlist not found', 404);
    }
    return wishlist;
  }

  async findBySlug(slug: string): Promise<WishlistDocument | null> {
    return this.model.findOne({ 'share.slug': slug }).exec();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateWishlistDto): Promise<WishlistView> {
    const ownerId = new Types.ObjectId(userId);

    const active = await this.model.countDocuments({ ownerId, archivedAt: null }).exec();
    if (active >= MAX_ACTIVE_WISHLISTS) {
      throw new AppException(
        ErrorCode.WISHLIST_LIMIT_REACHED,
        `You can have at most ${MAX_ACTIVE_WISHLISTS} active wishlists`,
        409,
      );
    }

    const coverUrl = dto.coverMediaId ? await this.resolveCover(userId, dto.coverMediaId) : null;
    const forUserId = await this.resolveForUser(userId, dto.forUserId);

    const wishlist = await this.model.create({
      ownerId,
      title: dto.title,
      description: dto.description ?? null,
      occasionLabel: dto.occasionLabel ?? null,
      forUserId,
      visibility: dto.visibility ?? WishlistVisibility.PRIVATE,
      coverUrl,
      coverMediaId: dto.coverMediaId ? new Types.ObjectId(dto.coverMediaId) : null,
      chatEnabled: dto.chatEnabled ?? true,
      // Minted now, not on first share: the owner may flip to public at any
      // time, and a lazily-created slug would change the link under them.
      share: { slug: generateSlug(), passcodeHash: null, expiresAt: null, rotatedAt: new Date() },
    });

    const access = await this.access.resolve(wishlist, { userId });
    return toWishlistView(wishlist, access, this.shareBaseUrl);
  }

  /** The caller's own lists. Archived ones are excluded unless asked for. */
  async listMine(userId: string, includeArchived = false): Promise<WishlistView[]> {
    const wishlists = await this.model
      .find({
        ownerId: new Types.ObjectId(userId),
        ...(includeArchived ? {} : { archivedAt: null }),
      })
      .sort({ createdAt: -1 })
      .limit(MAX_ACTIVE_WISHLISTS)
      .exec();

    // The owner's rights are identical for every row, so this resolves once
    // rather than issuing a policy lookup per wishlist.
    return Promise.all(
      wishlists.map(async (w) =>
        toWishlistView(w, await this.access.resolve(w, { userId }), this.shareBaseUrl),
      ),
    );
  }

  /** Lists shared with the caller (accepted invites). */
  async listSharedWithMe(userId: string): Promise<WishlistView[]> {
    const participantIds = await this.model.db
      .collection('wishlist_participants')
      .distinct('wishlistId', {
        userId: new Types.ObjectId(userId),
        state: 'accepted',
        revokedAt: null,
      });

    const wishlists = await this.model
      .find({ _id: { $in: participantIds }, archivedAt: null })
      .sort({ updatedAt: -1 })
      .exec();

    return Promise.all(
      wishlists.map(async (w) =>
        toWishlistView(w, await this.access.resolve(w, { userId }), this.shareBaseUrl),
      ),
    );
  }

  async getOne(wishlistId: string, ctx: AccessContext): Promise<WishlistView> {
    const wishlist = await this.findOrFail(wishlistId);
    const access = await this.access.assertCanView(wishlist, ctx);
    return toWishlistView(wishlist, access, this.shareBaseUrl);
  }

  async update(
    wishlistId: string,
    ctx: AccessContext,
    dto: UpdateWishlistDto,
  ): Promise<WishlistView> {
    const wishlist = await this.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);
    this.assertNotArchived(wishlist);

    if (dto.title !== undefined) wishlist.title = dto.title;
    if (dto.description !== undefined) wishlist.description = dto.description;
    if (dto.occasionLabel !== undefined) wishlist.occasionLabel = dto.occasionLabel;
    if (dto.forUserId !== undefined) {
      wishlist.forUserId = await this.resolveForUser(ctx.userId!, dto.forUserId);
    }
    if (dto.chatEnabled !== undefined) wishlist.chatEnabled = dto.chatEnabled;

    if (dto.visibility !== undefined && dto.visibility !== wishlist.visibility) {
      this.assertVisibilityChangeIsSafe(wishlist, dto.visibility);
      wishlist.visibility = dto.visibility;
    }

    if (dto.coverMediaId !== undefined) {
      const previous = wishlist.coverMediaId;
      wishlist.coverUrl = dto.coverMediaId
        ? await this.resolveCover(ctx.userId!, dto.coverMediaId)
        : null;
      wishlist.coverMediaId = dto.coverMediaId ? new Types.ObjectId(dto.coverMediaId) : null;
      if (previous && previous.toString() !== dto.coverMediaId) {
        await this.media.markOrphaned(previous).catch(() => undefined);
      }
    }

    await wishlist.save();
    const access = await this.access.resolve(wishlist, ctx);
    return toWishlistView(wishlist, access, this.shareBaseUrl);
  }

  /**
   * Widening a private list to public is the single most dangerous edit in the
   * product: a surprise list, or one with reserved items, becomes readable by
   * anyone holding the old link. Rotating the slug means every link handed out
   * while it was private stops working, so exposure is a deliberate act rather
   * than a side effect of a toggle.
   */
  private assertVisibilityChangeIsSafe(wishlist: WishlistDocument, next: WishlistVisibility): void {
    const wasClosed =
      wishlist.visibility === WishlistVisibility.PRIVATE ||
      wishlist.visibility === WishlistVisibility.EVENT_ONLY;
    const nowOpen = next === WishlistVisibility.PUBLIC || next === WishlistVisibility.INVITE_ONLY;

    if (wasClosed && nowOpen) {
      wishlist.share.slug = generateSlug();
      wishlist.share.rotatedAt = new Date();
      this.logger.log(
        `Wishlist ${wishlist._id.toString()} opened (${wishlist.visibility} → ${next}); share slug rotated`,
      );
    }
  }

  /**
   * Archive rather than delete: gifts (Sprint 6) and chats (Sprint 8) reference
   * this row, and removing it would strand a gifter's history.
   */
  async archive(wishlistId: string, ctx: AccessContext): Promise<{ archivedAt: Date }> {
    const wishlist = await this.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);
    this.assertNotArchived(wishlist);

    const archivedAt = new Date();
    wishlist.archivedAt = archivedAt;
    // A dead link must stop working the moment the list is archived.
    wishlist.share.slug = generateSlug();
    wishlist.share.rotatedAt = archivedAt;
    await wishlist.save();

    return { archivedAt };
  }

  // ── Share links ───────────────────────────────────────────────────────────

  async configureShare(
    wishlistId: string,
    ctx: AccessContext,
    dto: ShareWishlistDto,
  ): Promise<NonNullable<WishlistView['share']>> {
    const wishlist = await this.findOrFail(wishlistId);
    await this.access.assertCanManage(wishlist, ctx);
    this.assertNotArchived(wishlist);

    if (dto.rotate) {
      wishlist.share.slug = generateSlug();
      wishlist.share.rotatedAt = new Date();
    }

    if (dto.passcode !== undefined) {
      wishlist.share.passcodeHash = dto.passcode
        ? AccessPolicyService.hashPasscode(dto.passcode)
        : null;
    }

    if (dto.expiresAt !== undefined) {
      const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw new AppException(ErrorCode.VALIDATION_FAILED, 'expiresAt must be in the future', 400);
      }
      wishlist.share.expiresAt = expiresAt;
    }

    await wishlist.save();

    return {
      slug: wishlist.share.slug,
      url: `${this.shareBaseUrl}/w/${wishlist.share.slug}`,
      hasPasscode: wishlist.share.passcodeHash !== null,
      expiresAt: wishlist.share.expiresAt,
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /**
   * Recomputes the denormalized counters from the items collection, which is
   * the source of truth. Called after every write that changes them.
   */
  async recount(wishlistId: Types.ObjectId): Promise<void> {
    const [counts] = await this.items
      .aggregate<{ itemCount: number; fulfilledCount: number }>([
        { $match: { wishlistId, archivedAt: null } },
        {
          $group: {
            _id: null,
            itemCount: { $sum: 1 },
            fulfilledCount: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      '$status',
                      [
                        WishlistItemStatus.FULFILLED,
                        WishlistItemStatus.COMPLETED,
                        WishlistItemStatus.GIFTED_OFFLINE,
                      ],
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ])
      .exec();

    await this.model
      .updateOne(
        { _id: wishlistId },
        {
          $set: {
            'stats.itemCount': counts?.itemCount ?? 0,
            'stats.fulfilledCount': counts?.fulfilledCount ?? 0,
          },
        },
      )
      .exec();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private assertNotArchived(wishlist: WishlistDocument): void {
    if (wishlist.archivedAt) {
      throw new AppException(
        ErrorCode.WISHLIST_ARCHIVED,
        'This wishlist is archived and cannot be changed',
        409,
      );
    }
  }

  /** Only media the caller owns, confirmed, and uploaded as a wishlist cover. */
  /**
   * The WishMate a list is for, checked rather than trusted.
   *
   * Only a current WishMate may be named: the picker offers nobody else, and
   * an id that arrived some other way must not let a list point at a stranger.
   * Nothing is granted or sent to the person named — it is a label the owner
   * chose, and they can pick it without anyone's say-so.
   */
  private async resolveForUser(
    userId: string,
    forUserId: string | null | undefined,
  ): Promise<Types.ObjectId | null> {
    if (!forUserId) return null;
    if (forUserId === userId) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'A list cannot be for yourself', 400);
    }
    const relationship = await this.wishmates.relationshipWith(userId, forUserId);
    if (relationship !== WishmateRelationship.WISHMATES) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'You can only make a list for one of your WishMates',
        400,
      );
    }
    return new Types.ObjectId(forUserId);
  }

  private async resolveCover(userId: string, mediaId: string): Promise<string | null> {
    const media = await this.media.getReadyOwned(userId, mediaId);
    if (media.purpose !== MediaPurpose.WISHLIST_COVER) {
      throw new AppException(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'This media was not uploaded as a wishlist cover',
        400,
      );
    }
    return media.url;
  }
}
