import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import { STORAGE, type IStorageProvider } from 'src/infra/storage/storage.port';
import type { CreateHomeBannerDto, UpdateHomeBannerDto } from './dto/home-banner.dto';
import {
  BANNER_IMAGE_MAX_BYTES,
  BANNERS_PER_PLACEMENT,
  BannerPlacement,
  type AdminBannerView,
  type HomeBannerView,
  type HomeBannersView,
} from './home-banner.types';
import { HomeBanner, type HomeBannerDocument } from './schemas/home-banner.schema';

const LIVE_CACHE_KEY = 'home-banners:v1:live';

/**
 * Every Home opens with this read, so it is cached — briefly, because a
 * banner's start and end times move it in and out on their own, with no write
 * to clear the cache. A minute is the most a scheduled banner can run late.
 */
const LIVE_CACHE_TTL = 60;

/**
 * Home's two ad carousels — "Exclusive Offers" and "Special Offers for You" —
 * as the admin panel sets them up and the app shows them.
 */
@Injectable()
export class PromotionsService {
  constructor(
    @InjectModel(HomeBanner.name) private readonly banners: Model<HomeBannerDocument>,
    private readonly cache: CacheService,
    @Inject(STORAGE) private readonly storage: IStorageProvider,
  ) {}

  /** Where our banner pictures live; only these may be put on a banner. */
  private get imageBase(): string {
    return this.storage.getPublicUrl('banners/');
  }

  // ── App ──────────────────────────────────────────────────────────────────

  /** Both carousels, live banners only, in order. */
  async live(now = new Date()): Promise<HomeBannersView> {
    const cached = await this.cache.get<HomeBannersView>(LIVE_CACHE_KEY);
    if (cached) return cached;

    const rows = await this.banners
      .find({
        active: true,
        $and: [
          { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
          { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
        ],
      })
      .sort({ position: 1, createdAt: -1 })
      .exec();
    const of = (placement: BannerPlacement): HomeBannerView[] =>
      rows
        .filter((b) => b.placement === placement)
        .slice(0, BANNERS_PER_PLACEMENT)
        .map((b) => PromotionsService.view(b));
    const view: HomeBannersView = {
      exclusiveOffers: of(BannerPlacement.EXCLUSIVE_OFFERS),
      specialOffers: of(BannerPlacement.SPECIAL_OFFERS),
    };
    await this.cache.set(LIVE_CACHE_KEY, view, LIVE_CACHE_TTL);
    return view;
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  async adminList(placement?: BannerPlacement): Promise<AdminBannerView[]> {
    const filter: FilterQuery<HomeBanner> = placement ? { placement } : {};
    const rows = await this.banners
      .find(filter)
      .sort({ placement: 1, position: 1, createdAt: -1 })
      .exec();
    const now = new Date();
    return rows.map((b) => PromotionsService.adminView(b, now));
  }

  async adminGet(id: string): Promise<AdminBannerView> {
    return PromotionsService.adminView(await this.find(id), new Date());
  }

  async create(input: CreateHomeBannerDto, adminId: string): Promise<AdminBannerView> {
    const startsAt = PromotionsService.date(input.startsAt);
    const endsAt = PromotionsService.date(input.endsAt);
    PromotionsService.checkWindow(startsAt, endsAt);
    const banner = await this.banners.create({
      placement: input.placement,
      title: input.title ?? '',
      subtitle: input.subtitle ?? null,
      imageUrl: this.checkImage(input.imageUrl),
      linkUrl: input.linkUrl ?? null,
      position: input.position ?? 0,
      active: input.active ?? true,
      startsAt,
      endsAt,
      createdBy: Types.ObjectId.isValid(adminId) ? new Types.ObjectId(adminId) : null,
    });
    await this.changed();
    return PromotionsService.adminView(banner, new Date());
  }

  async update(id: string, input: UpdateHomeBannerDto): Promise<AdminBannerView> {
    const banner = await this.find(id);
    if (input.placement !== undefined) banner.placement = input.placement;
    if (input.title !== undefined) banner.title = input.title;
    if (input.subtitle !== undefined) banner.subtitle = input.subtitle ?? null;
    if (input.imageUrl !== undefined) banner.imageUrl = this.checkImage(input.imageUrl);
    if (input.linkUrl !== undefined) banner.linkUrl = input.linkUrl ?? null;
    if (input.position !== undefined) banner.position = input.position;
    if (input.active !== undefined) banner.active = input.active;
    if (input.startsAt !== undefined) banner.startsAt = PromotionsService.date(input.startsAt);
    if (input.endsAt !== undefined) banner.endsAt = PromotionsService.date(input.endsAt);
    PromotionsService.checkWindow(banner.startsAt, banner.endsAt);
    await banner.save();
    await this.changed();
    return PromotionsService.adminView(banner, new Date());
  }

  /** Deletes a banner for good. Its picture stays in storage, unreferenced. */
  async remove(id: string): Promise<AdminBannerView> {
    const banner = await this.find(id);
    const snapshot = PromotionsService.adminView(banner, new Date());
    await banner.deleteOne();
    await this.changed();
    return snapshot;
  }

  /** Stores a banner picture. WebP only: the panel converts and shrinks it first. */
  async uploadImage(body: Buffer): Promise<{ url: string }> {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'No picture was sent', 400);
    }
    if (body.length > BANNER_IMAGE_MAX_BYTES) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'The picture must be 2 MB or smaller',
        413,
      );
    }
    const isWebp =
      body.subarray(0, 4).toString('latin1') === 'RIFF' &&
      body.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!isWebp) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Pictures are uploaded as WebP', 415);
    }
    const key = `banners/${randomUUID()}.webp`;
    await this.storage.putObject(key, body, 'image/webp');
    return { url: this.storage.getPublicUrl(key) };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async find(id: string): Promise<HomeBannerDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Banner not found', 404);
    }
    const banner = await this.banners.findById(id).exec();
    if (!banner) throw new AppException(ErrorCode.NOT_FOUND, 'Banner not found', 404);
    return banner;
  }

  /** A write shows on Home at once, not a minute later. */
  private async changed(): Promise<void> {
    await this.cache.del(LIVE_CACHE_KEY);
  }

  private checkImage(url: string): string {
    if (!url.startsWith(this.imageBase)) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'The picture must be one uploaded here',
        400,
      );
    }
    return url;
  }

  private static date(value: string | null | undefined): Date | null {
    return value ? new Date(value) : null;
  }

  private static checkWindow(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'A banner must end after it starts', 400);
    }
  }

  private static view(b: HomeBannerDocument): HomeBannerView {
    return {
      id: b._id.toString(),
      placement: b.placement,
      title: b.title,
      subtitle: b.subtitle ?? null,
      imageUrl: b.imageUrl,
      linkUrl: b.linkUrl ?? null,
    };
  }

  private static adminView(b: HomeBannerDocument, now: Date): AdminBannerView {
    const started = !b.startsAt || b.startsAt <= now;
    const notEnded = !b.endsAt || b.endsAt > now;
    return {
      ...PromotionsService.view(b),
      position: b.position,
      active: b.active,
      startsAt: b.startsAt ?? null,
      endsAt: b.endsAt ?? null,
      live: b.active && started && notEnded,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }
}
