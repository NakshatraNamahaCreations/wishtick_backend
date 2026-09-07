export const STORAGE = Symbol('STORAGE');

export interface PresignedUpload {
  /** Where the client PUTs the bytes. Short-lived. */
  uploadUrl: string;
  /** Opaque object key the client echoes back to /media/confirm. */
  storageKey: string;
  /** Headers the client MUST send for the signature to validate. */
  requiredHeaders: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
}

/**
 * Object storage behind one interface so the app never learns whether it is
 * talking to S3 or to a dev machine's disk.
 *
 * Uploads are always presigned and direct-to-storage: routing file bytes
 * through the API would tie up a Node process per upload and cap file size at
 * whatever the request body limit is.
 */
export interface IStorageProvider {
  createUploadUrl(input: {
    storageKey: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload>;

  /**
   * Confirms the object actually landed and reports what was really stored.
   *
   * This is the security-critical call: everything the client told us at
   * upload-url time was a *claim*. Only storage knows the true size and type,
   * and a client that promised a 2 MB JPEG can still PUT a 50 MB executable.
   */
  head(storageKey: string): Promise<StoredObjectInfo>;

  /**
   * Writes an object the SERVER generated, rather than one a client uploads.
   *
   * Presigning exists to keep user file bytes out of the API process. That
   * reasoning does not apply to something we produced ourselves (a rendered
   * invite card, a compiled reel): there is no client to hand a URL to, the
   * bytes are already in memory, and issuing a presigned URL to ourselves would
   * be a pointless round trip. Callers must therefore be the ones deciding the
   * content type — nothing here is validated, because nothing here is untrusted.
   */
  putObject(storageKey: string, body: Buffer, contentType: string): Promise<void>;

  /**
   * Reads an object's bytes back.
   *
   * The reels worker needs the raw wish media on the box to ffprobe and
   * normalize it — presigned URLs get bytes TO storage, this gets them back.
   * Throws (not null) when the key is missing: a compile that lost an input
   * should fail loudly, not render a hole.
   */
  getObject(storageKey: string): Promise<{ body: Buffer; contentType: string }>;

  /** Publicly readable URL, or a signed one for private buckets. */
  getPublicUrl(storageKey: string): string;

  delete(storageKey: string): Promise<void>;
}
