import { S3Client } from "@aws-sdk/client-s3";
import type { StorageEnv } from "./config";

/**
 * Create an unsigned S3 client for server-side operations in the web backend.
 * Uses the internal `S3_ENDPOINT` (127.0.0.1:9000 in dev). `forcePathStyle`
 * is required for MinIO/R2-style endpoints.
 */
export function createS3Client(config: StorageEnv): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Create an S3 client used only to *sign* presigned URLs for sandboxes (Fly
 * Machines). The signing endpoint (`S3_PUBLIC_ENDPOINT`) must be reachable from
 * those machines; the credential material never leaves the web backend — the
 * URL is time-limited and signed by the Fly-side instance's own key only.
 */
export function createS3SigningClient(config: StorageEnv): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_PUBLIC_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });
}