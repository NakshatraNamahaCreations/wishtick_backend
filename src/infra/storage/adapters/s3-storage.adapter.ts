import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from 'src/config/configuration';
import type { IStorageProvider, PresignedUpload, StoredObjectInfo } from '../storage.port';

@Injectable()
export class S3StorageAdapter implements IStorageProvider {
  private readonly logger = new Logger(S3StorageAdapter.name);
  private cachedClient: S3Client | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get bucket(): string {
    return this.config.get('storage.s3', { infer: true }).bucket;
  }

  private get publicBaseUrl(): string {
    return this.config.get('storage.s3', { infer: true }).publicBaseUrl;
  }

  /**
   * Built on first use, not in the constructor.
   *
   * StorageModule instantiates both adapters so it can pick one, so an eager
   * S3Client here throws "Region is missing" and takes down every local-driver
   * boot — a dev box has no reason to hold AWS config. Constructing an adapter
   * must stay free; only *using* it may require configuration.
   */
  private get client(): S3Client {
    if (this.cachedClient) return this.cachedClient;

    const s3 = this.config.get('storage.s3', { infer: true });
    if (!s3.region || !s3.bucket) {
      // Joi already requires both when STORAGE_DRIVER=s3, so reaching this means
      // the s3 adapter is being used under the local driver.
      throw new Error('S3 storage requires S3_REGION and S3_BUCKET');
    }

    this.cachedClient = new S3Client({
      region: s3.region,
      ...(s3.endpoint ? { endpoint: s3.endpoint, forcePathStyle: s3.forcePathStyle } : {}),
      // Since ~3.729 the SDK computes a CRC32 on every PutObject and folds
      // `x-amz-checksum-*` / `x-amz-sdk-checksum-algorithm` into the signature.
      // A phone PUTting to a presigned URL sends neither, so on any provider
      // that does not implement them the signature simply cannot match. AWS is
      // unaffected either way, which is why this is off by default.
      ...(s3.requestChecksums
        ? {}
        : {
            requestChecksumCalculation: 'WHEN_REQUIRED' as const,
            responseChecksumValidation: 'WHEN_REQUIRED' as const,
          }),
      // Fall through to the default provider chain (IAM role, env, SSO) when no
      // static key is configured — long-lived keys in env are the worse option,
      // so they must be opt-in rather than required.
      ...(s3.accessKeyId && s3.secretAccessKey
        ? { credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } }
        : {}),
    });
    return this.cachedClient;
  }

  async createUploadUrl(input: {
    storageKey: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload> {
    // ContentLength is deliberately NOT signed.
    //
    // It used to be, set to `maxBytes`, to refuse an oversized upload at the
    // edge. That cannot work: SigV4 binds an *exact* length, not a ceiling, so
    // the only file it would have accepted is one exactly maxBytes long —
    // every real upload is smaller. A max-size *range* needs a POST policy
    // (`content-length-range`), which presigned PUT has no equivalent of.
    //
    // The real control is `MediaService.confirm`, which HEADs the stored object
    // and deletes it if it exceeds the limit. That has always been the check
    // that counts, because everything said at upload-url time is a claim.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.storageKey,
      ContentType: input.contentType,
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: input.ttlSeconds });

    return {
      uploadUrl,
      storageKey: input.storageKey,
      requiredHeaders: { 'Content-Type': input.contentType },
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000),
    };
  }

  async head(storageKey: string): Promise<StoredObjectInfo> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      return {
        exists: true,
        sizeBytes: res.ContentLength,
        contentType: res.ContentType,
      };
    } catch (err) {
      // A missing object is the normal "client never uploaded" case, not an error.
      if (this.isNotFound(err)) return { exists: false };
      this.logger.error(
        `HEAD failed for ${storageKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  async putObject(storageKey: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: body,
        ContentType: contentType,
        // Server-generated artwork is content-addressed by the caller, so a
        // given key's bytes never change and it can be cached forever.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async getObject(storageKey: string): Promise<{ body: Buffer; contentType: string }> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
    const body = Buffer.from(await res.Body!.transformToByteArray());
    return { body, contentType: res.ContentType ?? 'application/octet-stream' };
  }

  getPublicUrl(storageKey: string): string {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
    }
    const s3 = this.config.get('storage.s3', { infer: true });
    return `https://${this.bucket}.s3.${s3.region}.amazonaws.com/${storageKey}`;
  }

  async delete(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }

  private isNotFound(err: unknown): boolean {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
  }
}
