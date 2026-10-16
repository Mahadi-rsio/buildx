import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3Client } from "@aws-sdk/client-s3";
import { createS3Client, createS3SigningClient } from "./client";
import { loadStorageEnv, type StorageEnv } from "./config";

/** Presigned URLs are never valid for longer than 15 minutes (arcetecture.md §9). */
export const MAX_PRESIGN_SECONDS = 15 * 60;
/** Comfortable default: long enough for a slow upload, short enough to be safe. */
export const DEFAULT_PRESIGN_SECONDS = 10 * 60;
/** Hard cap on a single workspace backup archive (plan phase 5). */
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

export interface PresignOptions {
  /** Lifetime in seconds; clamped to [1, MAX_PRESIGN_SECONDS]. */
  expiresIn?: number;
  /** Bucket override (defaults to S3_BUCKET_WORKSPACES). */
  bucket?: string;
}

export interface ObjectInfo {
  key: string;
  bucket: string;
  size: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
}

export interface ListEntry {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface RotateResult {
  /** False when the source key did not exist (nothing to rotate). */
  moved: boolean;
  /** The `.prev` key the object was moved to. */
  prevKey: string;
}

/**
 * Thin, provider-agnostic wrapper over S3. Two clients are used on purpose:
 * metadata mutations go through the internal endpoint, while presigned URLs are
 * signed against the public endpoint a sandbox can actually reach (the signed
 * host must match the host the caller uses, or MinIO rejects the signature).
 */
export interface Storage {
  presignPut(key: string, options?: PresignOptions): Promise<string>;
  presignGet(key: string, options?: PresignOptions): Promise<string>;
  head(key: string, bucket?: string): Promise<ObjectInfo | null>;
  copy(sourceKey: string, destKey: string, bucket?: string): Promise<void>;
  delete(key: string, bucket?: string): Promise<void>;
  rotate(key: string, bucket?: string): Promise<RotateResult>;
  list(prefix: string, bucket?: string): Promise<ListEntry[]>;
  readonly config: StorageEnv;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function clampExpiry(expiresIn: number | undefined): number {
  const value = Math.floor(expiresIn ?? DEFAULT_PRESIGN_SECONDS);
  return Math.min(Math.max(value, 1), MAX_PRESIGN_SECONDS);
}

/**
 * Build a `Storage` from the environment (or an explicit config). The two S3
 * clients are created once and reused.
 */
export function createStorage(
  config: StorageEnv = loadStorageEnv(),
): Storage {
  const internal: S3Client = createS3Client(config);
  const signing: S3Client = createS3SigningClient(config);
  const defaultBucket = config.S3_BUCKET_WORKSPACES;

  async function head(
    key: string,
    bucket: string,
  ): Promise<ObjectInfo | null> {
    try {
      const result = await internal.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        key,
        bucket,
        size: result.ContentLength ?? 0,
        etag: result.ETag,
        contentType: result.ContentType,
        lastModified: result.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function copy(
    sourceKey: string,
    destKey: string,
    bucket: string,
  ): Promise<void> {
    await internal.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: destKey,
        CopySource: `${bucket}/${sourceKey}`,
      }),
    );
  }

  return {
    config,

    async presignPut(key, options = {}) {
      return getSignedUrl(
        signing,
        new PutObjectCommand({
          Bucket: options.bucket ?? defaultBucket,
          Key: key,
        }),
        { expiresIn: clampExpiry(options.expiresIn) },
      );
    },

    async presignGet(key, options = {}) {
      return getSignedUrl(
        signing,
        new GetObjectCommand({
          Bucket: options.bucket ?? defaultBucket,
          Key: key,
        }),
        { expiresIn: clampExpiry(options.expiresIn) },
      );
    },

    head: (key, bucket = defaultBucket) => head(key, bucket),

    copy: (sourceKey, destKey, bucket = defaultBucket) =>
      copy(sourceKey, destKey, bucket),

    async delete(key, bucket = defaultBucket) {
      await internal.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    },

    async rotate(key, bucket = defaultBucket) {
      const existing = await head(key, bucket);
      const prevKey = `${key}.prev`;
      if (!existing) return { moved: false, prevKey };
      await copy(key, prevKey, bucket);
      await internal.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
      return { moved: true, prevKey };
    },

    async list(prefix, bucket = defaultBucket) {
      const entries: ListEntry[] = [];
      let token: string | undefined;
      do {
        const page = await internal.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key) continue;
          entries.push({
            key: item.Key,
            size: item.Size ?? 0,
            lastModified: item.LastModified,
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return entries;
    },
  };
}
