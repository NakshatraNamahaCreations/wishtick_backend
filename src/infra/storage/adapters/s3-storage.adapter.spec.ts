import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { AppConfig } from 'src/config/configuration';
import { S3StorageAdapter } from './s3-storage.adapter';

const CDN = 'https://wishtickmedia.b-cdn.net';

/** The adapter over a fake S3 client, with config as the deploy sets it. */
const adapterWith = (opts: { purgeKey?: string; publicBaseUrl?: string } = {}) => {
  const config = {
    get: (key: string) =>
      ({
        'storage.s3': {
          bucket: 'wishtick',
          region: 'sg',
          publicBaseUrl: opts.publicBaseUrl ?? CDN,
        },
        'storage.cdnPurgeApiKey': opts.purgeKey ?? '',
      })[key],
  } as unknown as ConfigService<AppConfig, true>;
  const adapter = new S3StorageAdapter(config);
  const send = jest.fn().mockResolvedValue({});
  Object.defineProperty(adapter, 'client', { get: () => ({ send }) });
  return { adapter, send };
};

describe('S3StorageAdapter', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('maps its own public URLs back to keys, and nobody else’s', () => {
    const { adapter } = adapterWith();
    expect(adapter.keyFromPublicUrl(adapter.getPublicUrl('banners/a.webp'))).toBe('banners/a.webp');
    expect(adapter.keyFromPublicUrl('https://shop.example/banners/a.webp')).toBeNull();
  });

  it('deletes the object, then clears the CDN copy of it', async () => {
    const { adapter, send } = adapterWith({ purgeKey: 'account-key' });

    await adapter.delete('banners/a.webp');

    expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.bunny.net/purge?url=${encodeURIComponent(`${CDN}/banners/a.webp`)}&async=true`,
    );
    expect(init).toMatchObject({ method: 'POST', headers: { AccessKey: 'account-key' } });
  });

  it('skips the purge with no API key, or no CDN in front', async () => {
    await adapterWith().adapter.delete('banners/a.webp');
    await adapterWith({ purgeKey: 'k', publicBaseUrl: '' }).adapter.delete('banners/a.webp');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed purge does not fail the delete', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const { adapter } = adapterWith({ purgeKey: 'k' });
    await expect(adapter.delete('banners/a.webp')).resolves.toBeUndefined();

    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(adapter.delete('banners/a.webp')).resolves.toBeUndefined();
  });
});
