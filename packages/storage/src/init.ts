import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { StorageEnv } from "./config";

/** The two buckets BuildX needs to exist (arcetecture.md §9.3). */
export const REQUIRED_BUCKETS = [
  "S3_BUCKET_WORKSPACES",
  "S3_BUCKET_DB_BACKUPS",
] as const satisfies readonly (keyof StorageEnv)[];

/**
 * Ensure the configured buckets exist. Idempotent — safe to run on every boot /
 * deploy / `pnpm storage:init`. Returns the buckets that already existed vs.
 * the ones created.
 */
export async function ensureBuckets(
  client: S3Client,
  config: StorageEnv,
): Promise<{ existed: string[]; created: string[] }> {
  const existed: string[] = [];
  const created: string[] = [];

  const list = await client.send(new ListBucketsCommand({}));
  const names = new Set(list.Buckets?.map((b) => b.Name) ?? []);

  for (const key of REQUIRED_BUCKETS) {
    const bucket = config[key];
    if (names.has(bucket)) {
      existed.push(bucket);
      continue;
    }
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    created.push(bucket);
  }

  return { existed, created };
}

/** Assert that a bucket is reachable and owned by us (thrown by HeadBucket on 403/404). */
export async function assertBucketReachable(
  client: S3Client,
  bucket: string,
): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}