import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  AppPlatform,
  DEFAULT_STORE_URLS,
  updateStatusFor,
  type AdminAppVersionView,
  type AppVersionCheckView,
} from './app-version.types';
import type { UpdateAppVersionPolicyDto } from './dto/app-version.dto';
import {
  AppVersionPolicy,
  type AppVersionPolicyDocument,
} from './schemas/app-version-policy.schema';

const cacheKey = (platform: AppPlatform): string => `app-version:v1:${platform}`;

/**
 * Every launch and every return to the app asks, so the policy is cached.
 * A save clears it at once, so the minute only matters if Redis misses a
 * delete.
 */
const CACHE_TTL = 60;

/** The fields the rule reads, cached as they are. */
interface Policy {
  latestVersionCode: number;
  latestVersionName: string | null;
  minVersionCode: number;
  minVersionName: string | null;
  storeUrl: string | null;
  message: string | null;
}

const EMPTY: Policy = {
  latestVersionCode: 0,
  latestVersionName: null,
  minVersionCode: 0,
  minVersionName: null,
  storeUrl: null,
  message: null,
};

/**
 * The app's update prompt and force update. The admin panel sets, per
 * platform, the newest build and the lowest build allowed to run. The app
 * asks with its own build number and is told `ok`, `optional` or `required`.
 */
@Injectable()
export class AppVersionService {
  constructor(
    @InjectModel(AppVersionPolicy.name)
    private readonly policies: Model<AppVersionPolicyDocument>,
    private readonly cache: CacheService,
  ) {}

  // ── App ──────────────────────────────────────────────────────────────────

  async check(platform: AppPlatform, versionCode: number): Promise<AppVersionCheckView> {
    const policy = await this.policy(platform);
    return {
      status: updateStatusFor(versionCode, policy),
      latestVersionCode: policy.latestVersionCode,
      latestVersionName: policy.latestVersionName,
      minVersionCode: policy.minVersionCode,
      storeUrl: policy.storeUrl ?? DEFAULT_STORE_URLS[platform],
      message: policy.message,
    };
  }

  private async policy(platform: AppPlatform): Promise<Policy> {
    const cached = await this.cache.get<Policy>(cacheKey(platform));
    if (cached) return cached;
    const doc = await this.policies.findOne({ platform }).lean().exec();
    const policy: Policy = doc
      ? {
          latestVersionCode: doc.latestVersionCode,
          latestVersionName: doc.latestVersionName,
          minVersionCode: doc.minVersionCode,
          minVersionName: doc.minVersionName,
          storeUrl: doc.storeUrl,
          message: doc.message,
        }
      : EMPTY;
    await this.cache.set(cacheKey(platform), policy, CACHE_TTL);
    return policy;
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  async adminList(): Promise<AdminAppVersionView[]> {
    return Promise.all(Object.values(AppPlatform).map((p) => this.adminGet(p)));
  }

  async adminGet(platform: AppPlatform): Promise<AdminAppVersionView> {
    const doc = await this.policies.findOne({ platform }).exec();
    return AppVersionService.view(platform, doc);
  }

  async update(
    platform: AppPlatform,
    dto: UpdateAppVersionPolicyDto,
    adminId: string,
  ): Promise<AdminAppVersionView> {
    if (dto.minVersionCode > dto.latestVersionCode) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'The forced minimum cannot be above the latest version in the store',
        400,
      );
    }
    const forced = dto.minVersionCode > 0;
    const doc = await this.policies
      .findOneAndUpdate(
        { platform },
        {
          $set: {
            latestVersionCode: dto.latestVersionCode,
            latestVersionName: dto.latestVersionName ?? null,
            minVersionCode: dto.minVersionCode,
            // A name for a minimum that is off would only mislead.
            minVersionName: forced ? (dto.minVersionName ?? null) : null,
            storeUrl: dto.storeUrl ?? null,
            message: dto.message ?? null,
            updatedBy: Types.ObjectId.isValid(adminId) ? new Types.ObjectId(adminId) : null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    await this.cache.del(cacheKey(platform));
    return AppVersionService.view(platform, doc);
  }

  private static view(
    platform: AppPlatform,
    doc: AppVersionPolicyDocument | null,
  ): AdminAppVersionView {
    const p = doc ?? EMPTY;
    return {
      platform,
      latestVersionCode: p.latestVersionCode,
      latestVersionName: p.latestVersionName,
      minVersionCode: p.minVersionCode,
      minVersionName: p.minVersionName,
      storeUrl: p.storeUrl ?? DEFAULT_STORE_URLS[platform],
      message: p.message,
      forced: p.minVersionCode > 0,
      updatedBy: doc?.updatedBy ? doc.updatedBy.toString() : null,
      updatedAt: doc?.updatedAt ? doc.updatedAt.toISOString() : null,
    };
  }
}
