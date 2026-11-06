import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  AppPlatform,
  DEFAULT_STORE_URLS,
  planFromPlay,
  updateStatusFor,
  type AdminAppVersionView,
  type AdminPlaySyncView,
  type AppVersionCheckView,
  type PlaySyncState,
} from './app-version.types';
import type { UpdateAppVersionPolicyDto } from './dto/app-version.dto';
import {
  AppVersionPolicy,
  type AppVersionPolicyDocument,
} from './schemas/app-version-policy.schema';
import { PlayStoreClient, PlayStoreError } from './play-store.client';

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
  private readonly logger = new Logger(AppVersionService.name);

  constructor(
    @InjectModel(AppVersionPolicy.name)
    private readonly policies: Model<AppVersionPolicyDocument>,
    private readonly cache: CacheService,
    private readonly play: PlayStoreClient,
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
    return this.view(platform, doc);
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
    return this.view(platform, doc);
  }

  // ── Google Play ──────────────────────────────────────────────────────────

  /** Whether the server has a Play service account to read with. */
  get playConnected(): boolean {
    return this.play.configured;
  }

  /**
   * Reads Play's production track and, when a newer build is out to
   * everyone, makes it the latest version, with Play's "What's new" text as
   * the prompt's message. The forced minimum is never touched: forcing stays
   * a person's decision. A failed read is kept, to show in the panel, and
   * changes nothing else.
   */
  async syncFromPlay(): Promise<{
    before: AdminAppVersionView;
    after: AdminAppVersionView;
    advanced: boolean;
  }> {
    const platform = AppPlatform.ANDROID;
    if (!this.play.configured) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'Google Play is not connected. Set PLAY_CLIENT_EMAIL and PLAY_PRIVATE_KEY on the server.',
        409,
      );
    }
    const current = await this.policies.findOne({ platform }).exec();
    const before = this.view(platform, current);
    const now = new Date();

    let state: PlaySyncState;
    let set: Record<string, unknown> = {};
    try {
      const releases = await this.play.productionReleases();
      const plan = planFromPlay(releases, current?.latestVersionCode ?? 0);
      state = {
        checkedAt: now,
        ok: true,
        error: null,
        liveVersionCode: plan.live?.versionCode ?? null,
        liveVersionName: plan.live?.versionName ?? null,
        rolloutVersionCode: plan.rollout?.versionCode ?? null,
        rolloutVersionName: plan.rollout?.versionName ?? null,
        rolloutFraction: plan.rollout?.userFraction ?? null,
        advancedAt: plan.advanceTo ? now : (current?.playSync?.advancedAt ?? null),
      };
      if (plan.advanceTo) {
        set = {
          latestVersionCode: plan.advanceTo.versionCode,
          latestVersionName: plan.advanceTo.versionName,
          // The old message was about the old version.
          message: plan.advanceTo.notes,
        };
        this.logger.log(`Play: latest Android version is now build ${plan.advanceTo.versionCode}`);
      }
    } catch (e) {
      const error = e instanceof PlayStoreError ? e.message : 'Reading Google Play failed';
      if (!(e instanceof PlayStoreError)) this.logger.error('Play sync failed', e as Error);
      state = {
        ...(current?.playSync ?? {
          liveVersionCode: null,
          liveVersionName: null,
          rolloutVersionCode: null,
          rolloutVersionName: null,
          rolloutFraction: null,
          advancedAt: null,
        }),
        checkedAt: now,
        ok: false,
        error,
      };
    }

    const doc = await this.policies
      .findOneAndUpdate(
        { platform },
        { $set: { ...set, playSync: state } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    if (Object.keys(set).length > 0) await this.cache.del(cacheKey(platform));
    return { before, after: this.view(platform, doc), advanced: Object.keys(set).length > 0 };
  }

  private playView(platform: AppPlatform, state: PlaySyncState | null): AdminPlaySyncView {
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
    return {
      connected: platform === AppPlatform.ANDROID && this.play.configured,
      checkedAt: iso(state?.checkedAt),
      ok: state ? state.ok : null,
      error: state?.error ?? null,
      liveVersionCode: state?.liveVersionCode ?? null,
      liveVersionName: state?.liveVersionName ?? null,
      rolloutVersionCode: state?.rolloutVersionCode ?? null,
      rolloutVersionName: state?.rolloutVersionName ?? null,
      rolloutPercent:
        state?.rolloutFraction == null ? null : Math.round(state.rolloutFraction * 1000) / 10,
      advancedAt: iso(state?.advancedAt),
    };
  }

  private view(platform: AppPlatform, doc: AppVersionPolicyDocument | null): AdminAppVersionView {
    const p = doc ?? EMPTY;
    const play = this.playView(platform, doc?.playSync ?? null);
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
      play,
    };
  }
}
