import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import type { AppConfig } from 'src/config/configuration';
import type { IStorageProvider, PresignedUpload, StoredObjectInfo } from '../storage.port';

interface SidecarMeta {
  contentType: string;
  sizeBytes: number;
}

/**
 * Dev/test storage: signed uploads that land on local disk, served back by this
 * API. It exists so the upload flow can be exercised end to end without AWS
 * credentials — the alternative (stubbing uploads in dev) would leave the one
 * flow most likely to break untested until staging.
 *
 * The signing here mirrors S3's contract deliberately: URL expiry and a
 * signature binding key + content-type + size. If dev could PUT anything
 * anywhere, dev would not be testing the same rules production enforces.
 *
 * Never used in production — StorageModule refuses to select it there.
 */
@Injectable()
export class LocalStorageAdapter implements IStorageProvider {
  private readonly baseDir: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.baseDir = path.resolve(config.get('storage.localDir', { infer: true }));
  }

  createUploadUrl(input: {
    storageKey: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload> {
    const expiresAtMs = Date.now() + input.ttlSeconds * 1_000;
    const signature = this.sign(input.storageKey, input.contentType, input.maxBytes, expiresAtMs);

    const appUrl = this.config.get('app.appUrl', { infer: true }).replace(/\/$/, '');
    const apiPrefix = this.config.get('app.apiPrefix', { infer: true });
    const query = new URLSearchParams({
      contentType: input.contentType,
      maxBytes: String(input.maxBytes),
      expires: String(expiresAtMs),
      signature,
    });

    return Promise.resolve({
      uploadUrl: `${appUrl}/${apiPrefix}/v1/media/local/${input.storageKey}?${query.toString()}`,
      storageKey: input.storageKey,
      requiredHeaders: { 'Content-Type': input.contentType },
      expiresAt: new Date(expiresAtMs),
    });
  }

  async head(storageKey: string): Promise<StoredObjectInfo> {
    const filePath = this.resolveKey(storageKey);
    try {
      const stat = await fs.stat(filePath);
      const meta = await this.readMeta(storageKey);
      return {
        exists: true,
        sizeBytes: stat.size,
        contentType: meta?.contentType,
      };
    } catch {
      return { exists: false };
    }
  }

  async putObject(storageKey: string, body: Buffer, contentType: string): Promise<void> {
    // No signature check: this is the server writing its own bytes, not a
    // client redeeming an upload URL. resolveKey still applies, so a malformed
    // key cannot escape the base directory.
    const filePath = this.resolveKey(storageKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    await fs.writeFile(
      `${filePath}.meta.json`,
      JSON.stringify({ contentType, sizeBytes: body.length }),
    );
  }

  getPublicUrl(storageKey: string): string {
    const appUrl = this.config.get('app.appUrl', { infer: true }).replace(/\/$/, '');
    const apiPrefix = this.config.get('app.apiPrefix', { infer: true });
    return `${appUrl}/${apiPrefix}/v1/media/local/${storageKey}`;
  }

  async delete(storageKey: string): Promise<void> {
    const filePath = this.resolveKey(storageKey);
    await Promise.all([
      fs.rm(filePath, { force: true }),
      fs.rm(`${filePath}.meta.json`, { force: true }),
    ]);
  }

  // ── Used by LocalUploadController ─────────────────────────────────────────

  /** Validates the signed-URL params, then writes the body. Throws on any mismatch. */
  async acceptUpload(input: {
    storageKey: string;
    contentType: string;
    maxBytes: number;
    expiresAtMs: number;
    signature: string;
    body: Buffer;
  }): Promise<void> {
    if (Number.isNaN(input.expiresAtMs) || input.expiresAtMs < Date.now()) {
      throw new AppException(ErrorCode.MEDIA_URL_EXPIRED, 'This upload link has expired', 410);
    }

    const expected = this.sign(
      input.storageKey,
      input.contentType,
      input.maxBytes,
      input.expiresAtMs,
    );
    if (!LocalStorageAdapter.safeEqual(expected, input.signature)) {
      // Every signed parameter is covered, so tampering with the key, the type,
      // the size cap, or the expiry all land here.
      throw new AppException(ErrorCode.MEDIA_SIGNATURE_INVALID, 'Invalid upload signature', 403);
    }

    if (input.body.length > input.maxBytes) {
      throw new AppException(
        ErrorCode.MEDIA_TOO_LARGE,
        `File exceeds the ${input.maxBytes} byte limit for this upload`,
        413,
      );
    }

    const filePath = this.resolveKey(input.storageKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, input.body);
    await fs.writeFile(
      `${filePath}.meta.json`,
      JSON.stringify({ contentType: input.contentType, sizeBytes: input.body.length }),
    );
  }

  async read(storageKey: string): Promise<{ body: Buffer; contentType: string } | null> {
    const filePath = this.resolveKey(storageKey);
    try {
      const [body, meta] = await Promise.all([fs.readFile(filePath), this.readMeta(storageKey)]);
      return { body, contentType: meta?.contentType ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async getObject(storageKey: string): Promise<{ body: Buffer; contentType: string }> {
    const found = await this.read(storageKey);
    if (!found) {
      throw new AppException(ErrorCode.NOT_FOUND, `Object not found: ${storageKey}`, 404);
    }
    return found;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async readMeta(storageKey: string): Promise<SidecarMeta | null> {
    try {
      const raw = await fs.readFile(`${this.resolveKey(storageKey)}.meta.json`, 'utf8');
      return JSON.parse(raw) as SidecarMeta;
    } catch {
      return null;
    }
  }

  private sign(key: string, contentType: string, maxBytes: number, expiresAtMs: number): string {
    const secret = this.config.get('storage.signingSecret', { infer: true });
    return createHmac('sha256', secret)
      .update(`${key}|${contentType}|${maxBytes}|${expiresAtMs}`)
      .digest('hex');
  }

  /**
   * Maps a storage key to a path, refusing anything that escapes the base
   * directory. The signature already covers the key, but this must hold on its
   * own: a key like `../../../etc/passwd` reaching `fs.writeFile` is arbitrary
   * file write, and defence here does not depend on the signing secret staying
   * secret.
   */
  private resolveKey(storageKey: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(storageKey) || storageKey.includes('..')) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Invalid storage key', 400);
    }
    const resolved = path.resolve(this.baseDir, storageKey);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + path.sep)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Invalid storage key', 400);
    }
    return resolved;
  }

  private static safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
