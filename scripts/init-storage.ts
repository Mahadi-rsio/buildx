import {
  loadStorageEnv,
  createS3Client,
  ensureBuckets,
  assertBucketReachable,
  loadRootEnv,
} from "@buildx/storage";

// Root scripts usually run via `pnpm ... --env-file`, but calling this
// explicitly also covers direct `node scripts/init-storage.ts`.
loadRootEnv();

async function main(): Promise<void> {
  const config = loadStorageEnv();
  const client = createS3Client(config);

  const { existed, created } = await ensureBuckets(client, config);
  for (const bucket of created) {
    console.log(`created bucket  ${bucket}`);
  }
  for (const bucket of existed) {
    console.log(`bucket exists  ${bucket}`);
  }

  for (const bucket of [...created, ...existed]) {
    await assertBucketReachable(client, bucket);
    console.log(`reachable      ${bucket}`);
  }

  client.destroy();
}

main().catch((err) => {
  console.error("storage:init failed:", err);
  process.exit(1);
});