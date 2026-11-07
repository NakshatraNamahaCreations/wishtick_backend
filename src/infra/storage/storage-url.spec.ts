import { Logger } from '@nestjs/common';
import { deleteStoredUrl, keyAfterBase } from './storage-url';
import type { IStorageProvider } from './storage.port';

const BASE = 'https://wishtickmedia.b-cdn.net';

describe('keyAfterBase', () => {
  it('finds the key behind one of our URLs', () => {
    expect(keyAfterBase(`${BASE}/banners/abc.webp`, BASE)).toBe('banners/abc.webp');
    expect(keyAfterBase(`${BASE}/banners/abc.webp`, `${BASE}/`)).toBe('banners/abc.webp');
  });

  it('drops a query string or fragment', () => {
    expect(keyAfterBase(`${BASE}/blog/a.webp?v=2`, BASE)).toBe('blog/a.webp');
    expect(keyAfterBase(`${BASE}/blog/a.webp#top`, BASE)).toBe('blog/a.webp');
  });

  it('leaves anything that is not ours alone', () => {
    expect(keyAfterBase('https://m.media-amazon.com/images/x.jpg', BASE)).toBeNull();
    // A lookalike host must not pass as ours.
    expect(keyAfterBase(`${BASE}.evil.example/banners/a.webp`, BASE)).toBeNull();
    expect(keyAfterBase('', BASE)).toBeNull();
    expect(keyAfterBase(`${BASE}/x.webp`, '')).toBeNull();
  });

  it('refuses a key that climbs out of its folder, or names nothing', () => {
    expect(keyAfterBase(`${BASE}/banners/../users/1/p.png`, BASE)).toBeNull();
    expect(keyAfterBase(`${BASE}/`, BASE)).toBeNull();
    expect(keyAfterBase(`${BASE}//banners/a.webp`, BASE)).toBeNull();
  });
});

describe('deleteStoredUrl', () => {
  const logger = new Logger('test');
  let logError: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    logError = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  const storage = (deleteImpl: () => Promise<void> = () => Promise.resolve()) =>
    ({
      keyFromPublicUrl: (url: string) => keyAfterBase(url, BASE),
      delete: jest.fn(deleteImpl),
    }) as unknown as IStorageProvider & { delete: jest.Mock };

  it('deletes the object behind our URL', async () => {
    const s = storage();
    await deleteStoredUrl(s, `${BASE}/banners/a.webp`, logger);
    expect(s.delete).toHaveBeenCalledWith('banners/a.webp');
  });

  it('does nothing for a URL that is not ours, or none', async () => {
    const s = storage();
    await deleteStoredUrl(s, 'https://shop.example/a.jpg', logger);
    await deleteStoredUrl(s, null, logger);
    expect(s.delete).not.toHaveBeenCalled();
  });

  it('logs a failed delete rather than throwing', async () => {
    const s = storage(() => Promise.reject(new Error('down')));
    await expect(deleteStoredUrl(s, `${BASE}/blog/a.webp`, logger)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });
});
