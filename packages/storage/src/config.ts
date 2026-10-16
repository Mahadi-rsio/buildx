import { z } from "zod";
import { loadRootEnv } from "./env";

/**
 * Env configuration for the storage layer. Everything comes from the
 * environment — no defaults that would silently talk to the wrong bucket, no
 * hardcoded credentials.
 */
export const storageEnvSchema = z.object({
  /** Internal, server-side S3 endpoint (MinIO on 127.0.0.1 in dev). */
  S3_ENDPOINT: z.string().min(1).default("http://127.0.0.1:9000"),
  /** Endpoint handed to sandboxes for presigned URLs — must be internet-reachable. */
  S3_PUBLIC_ENDPOINT: z.string().min(1).default("http://127.0.0.1:9000"),
  S3_REGION: z.string().min(1).default("us-east-1"),
  /** `POST /api/...` root creds in dev; dedicated scoped service account in prod. */
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** MinIO requires path-style addressing (`/bucket/key`, not virtual host). */
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  S3_BUCKET_WORKSPACES: z.string().min(1).default("buildx-workspaces"),
  S3_BUCKET_DB_BACKUPS: z.string().min(1).default("buildx-db-backups"),
});
export type StorageEnv = z.infer<typeof storageEnvSchema>;

/**
 * Parse storage config from the environment. Blank strings are treated as
 * unset. In dev the S3 access key may be omitted in favor of the MinIO root
 * credentials (`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`); production must set a
 * dedicated S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY scoped to the two buckets.
 */
export function loadStorageEnv(
  source: Record<string, string | undefined> = process.env,
): StorageEnv {
  loadRootEnv();

  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    cleaned[key] = value === "" ? undefined : value;
  }

  const s3Key = cleaned.S3_ACCESS_KEY_ID ?? cleaned.MINIO_ROOT_USER;
  const s3Secret = cleaned.S3_SECRET_ACCESS_KEY ?? cleaned.MINIO_ROOT_PASSWORD;
  if (!s3Key || !s3Secret) {
    throw new Error(
      "S3 credentials missing: set S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (or MinIO root creds) in .env",
    );
  }

  return storageEnvSchema.parse({
    ...cleaned,
    S3_ACCESS_KEY_ID: s3Key,
    S3_SECRET_ACCESS_KEY: s3Secret,
  });
}