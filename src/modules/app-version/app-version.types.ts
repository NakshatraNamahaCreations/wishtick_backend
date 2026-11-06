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
