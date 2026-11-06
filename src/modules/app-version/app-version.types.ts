/** The stores the app ships to. Each has its own policy. */
export enum AppPlatform {
  ANDROID = 'android',
  IOS = 'ios',
}

/**
 * What a build is told when it asks.
 *  * `ok`: it is the latest, or newer (a build still in testing).
 *  * `optional`: a newer one is out. The app offers it once per version, with
 *    "Later".
 *  * `required`: the admin has forced an update and this build is below the
 *    minimum. The app is blocked until it is updated.
 */
export type UpdateStatus = 'ok' | 'optional' | 'required';

/** The app's answer to "should I update?". */
export interface AppVersionCheckView {
  status: UpdateStatus;
  latestVersionCode: number;
  latestVersionName: string | null;
  /** 0 when no update is forced. */
  minVersionCode: number;
  storeUrl: string;
  message: string | null;
}

/** One platform's policy, as the admin panel shows it. */
export interface AdminAppVersionView {
  platform: AppPlatform;
  latestVersionCode: number;
  latestVersionName: string | null;
  minVersionCode: number;
  minVersionName: string | null;
  storeUrl: string;
  message: string | null;
  /** True when some builds are being forced to update. */
  forced: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  /** The Google Play sync: Android only; never connected for iOS. */
  play: AdminPlaySyncView;
}

/** What the last read of Google Play found, as the admin panel shows it. */
export interface AdminPlaySyncView {
  /** A service account is set up on the server. */
  connected: boolean;
  checkedAt: string | null;
  /** Null before the first check. */
  ok: boolean | null;
  error: string | null;
  /** The newest build out to everyone on production. */
  liveVersionCode: number | null;
  liveVersionName: string | null;
  /** A staged rollout still under way, if any, and how far it has got. */
  rolloutVersionCode: number | null;
  rolloutVersionName: string | null;
  rolloutPercent: number | null;
  /** When a sync last moved the latest version forward. */
  advancedAt: string | null;
}

/** What is kept on the policy between checks. */
export interface PlaySyncState {
  checkedAt: Date;
  ok: boolean;
  error: string | null;
  liveVersionCode: number | null;
  liveVersionName: string | null;
  rolloutVersionCode: number | null;
  rolloutVersionName: string | null;
  rolloutFraction: number | null;
  advancedAt: Date | null;
}

/** A Play release, as far as the rule needs it. */
interface ReleaseLike {
  versionCode: number;
  versionName: string | null;
  status: string;
  userFraction: number | null;
  notes: string | null;
}

/** What one read of Play means for the policy. */
export interface PlayPlan<R extends ReleaseLike = ReleaseLike> {
  /** The newest release out to everyone. */
  live: R | null;
  /** A staged rollout above it, still under way. */
  rollout: R | null;
  /** Set when the live build is newer than the latest version on file. */
  advanceTo: R | null;
}

/**
 * Only a release out to 100% becomes the latest version. Offering a build
 * that Play is still holding back would send people to a listing with no
 * update on it. And the latest version only ever moves up: a build set by
 * hand above what Play has is left alone.
 */
export function planFromPlay<R extends ReleaseLike>(
  releases: R[],
  latestVersionCode: number,
): PlayPlan<R> {
  const newest = (list: R[]): R | null =>
    list.reduce<R | null>((a, r) => (!a || r.versionCode > a.versionCode ? r : a), null);
  const live = newest(releases.filter((r) => r.status === 'completed'));
  const rollout = newest(
    releases.filter(
      (r) =>
        (r.status === 'inProgress' || r.status === 'halted') &&
        r.versionCode > (live?.versionCode ?? 0),
    ),
  );
  return {
    live,
    rollout,
    advanceTo: live && live.versionCode > latestVersionCode ? live : null,
  };
}

/** Where each store's listing is when the panel has not set one. */
export const DEFAULT_STORE_URLS: Record<AppPlatform, string> = {
  [AppPlatform.ANDROID]: 'https://play.google.com/store/apps/details?id=com.wishtick.wishtick',
  [AppPlatform.IOS]: 'https://apps.apple.com/app/wishtick',
};

/** Store links must be the store's own, never somewhere else. */
export const STORE_URL_PATTERN =
  /^https:\/\/(play\.google\.com\/store\/apps\/details\?id=[\w.]+.*|apps\.apple\.com\/.+)$/;

/**
 * The decision, kept pure so it is tested on its own. Forced first: a build
 * below the minimum is blocked even if it is also merely out of date.
 */
export function updateStatusFor(
  versionCode: number,
  policy: { latestVersionCode: number; minVersionCode: number },
): UpdateStatus {
  if (policy.minVersionCode > 0 && versionCode < policy.minVersionCode) return 'required';
  if (versionCode < policy.latestVersionCode) return 'optional';
  return 'ok';
}
