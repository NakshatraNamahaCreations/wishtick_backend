import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model } from 'mongoose';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import {
  WishlistItem,
  type WishlistItemDocument,
} from 'src/modules/wishlists/schemas/wishlist-item.schema';
import { GroupGiftCardRenderer } from './group-gift-card.renderer';
import { GroupGift, type GroupGiftDocument } from './schemas/group-gift.schema';

/**
 * Renders and stores a group gift's progress-bar OG card.
 *
 * Content-addressed by a hash of the *mutable* progress (collected, target,
 * status), so a share card always reflects the current total AND repeats are
 * free: the same progress renders to the same immutable URL, `head()` finds it,
 * and we skip the raster. Called on create and lazily when the public preview is
 * fetched — never per-contribution, since rasterizing is CPU work and a hundred
 * concurrent contributions must not become a hundred concurrent renders.
 */
@Injectable()
export class GroupGiftPreviewService {
  private readonly logger = new Logger(GroupGiftPreviewService.name);

  constructor(
    @InjectModel(GroupGift.name) private readonly groupGiftModel: Model<GroupGiftDocument>,
    @InjectModel(WishlistItem.name) private readonly itemModel: Model<WishlistItemDocument>,
    @Inject(STORAGE) private readonly storage: IStorageProvider,
    private readonly renderer: GroupGiftCardRenderer,
  ) {}

  /**
   * Ensures a current progress card exists and returns its URL, persisting it
   * onto the group gift. Returns the existing URL on any failure — a missing
   * share card degrades the preview, it does not fail the request.
   */
  async refresh(gift: GroupGiftDocument): Promise<string | null> {
    try {
      const item = await this.itemModel.findById(gift.itemId).exec();
      const title = item?.title?.trim() || 'A group gift';

      const percent =
        gift.targetAmountMinor <= 0
          ? 0
          : Math.min(100, Math.round((gift.collectedAmountMinor / gift.targetAmountMinor) * 100));

      const content = {
        title,
        amountLine: `${GroupGiftPreviewService.formatMinor(
          gift.collectedAmountMinor,
          gift.currency,
        )} of ${GroupGiftPreviewService.formatMinor(gift.targetAmountMinor, gift.currency)} raised`,
        percent,
        contributorLine: GroupGiftPreviewService.contributorLine(gift.contributorCount),
        message: gift.message,
      };

      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            t: title,
            c: gift.collectedAmountMinor,
            g: gift.targetAmountMinor,
            n: gift.contributorCount,
            s: gift.status,
            m: gift.message,
          }),
        )
        .digest('hex')
        .slice(0, 16);
      const storageKey = `group-gifts/${gift._id.toString()}/progress-${fingerprint}.png`;

      const url = this.storage.getPublicUrl(storageKey);
      const existing = await this.storage.head(storageKey);
      if (!existing.exists) {
        const png = this.renderer.render(content);
        await this.storage.putObject(storageKey, png, 'image/png');
      }

      if (gift.ogImageUrl !== url) {
        await this.groupGiftModel
          .updateOne({ _id: gift._id }, { $set: { ogImageUrl: url } })
          .exec();
        gift.ogImageUrl = url;
      }
      return url;
    } catch (err) {
      this.logger.error(
        `Failed to render group-gift card for ${gift._id.toString()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return gift.ogImageUrl;
    }
  }

  /** Minor units → a currency string. Assumes 2-decimal currencies (INR/USD); MVP scope. */
  private static formatMinor(minor: number, currency: string): string {
    try {
      return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
    } catch {
      return `${(minor / 100).toFixed(2)} ${currency}`;
    }
  }

  private static contributorLine(count: number): string {
    if (count === 0) return 'Be the first to chip in';
    if (count === 1) return '1 person has chipped in';
    return `${count} people have chipped in`;
  }
}
