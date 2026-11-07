import type { Logger } from '@nestjs/common';
import type { IStorageProvider } from './storage.port';

/**
 * The key after [base] in [url], or null when [url] does not start with it.
 *
 * Query strings and fragments are dropped — a CDN URL may carry a cache
 * buster — and a key that tries to climb out of its folder (`..`) or is empty
 * is refused, so a URL can never name an object it does not plainly point at.
 */
export function keyAfterBase(url: string, base: string): string | null {
  if (!url || !base) return null;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length).split(/[?#]/, 1)[0];
  if (!key || key.startsWith('/') || key.split('/').includes('..')) return null;
  return key;
}

/**
 * Deletes the object behind one of our own public URLs. Anything else — a
 * shop's photo, a URL from before a domain change — is left alone.
 *
 * Never throws: a picture that could not be deleted is a few kilobytes of
 * storage, while failing the admin's delete over it would leave the banner or
 * post they meant to remove still standing. Failures are logged.
 */
export async function deleteStoredUrl(
  storage: IStorageProvider,
  url: string | null | undefined,
  logger: Logger,
): Promise<void> {
  if (!url) return;
  const key = storage.keyFromPublicUrl(url);
  if (!key) return;
  try {
    await storage.delete(key);
    logger.log(`Deleted ${key} from storage`);
  } catch (err) {
    logger.error(`Could not delete ${key}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
