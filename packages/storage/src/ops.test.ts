import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createS3Client } from "./client";
import { loadStorageEnv, type StorageEnv } from "./config";
import { ensureBuckets } from "./init";
import { createStorage, type Storage } from "./ops";

/**
 * These run against a REAL MinIO from docker compose (`pnpm infra:up`), not a
 * mock: presigning is host-sensitive and only a real server proves the signed
 * host matches the host the sandbox calls. When MinIO is unreachable the suite
 * skips rather than failing, so `pnpm test` still works without infra.
 */
const prefix = `tests/${Date.now()}-${Math.random().toString(36).slice(2)}`;
let config: StorageEnv | undefined;
let storage: Storage | undefined;
let skipReason: string | false;

try {
  config = loadStorageEnv();
  const probe = createS3Client(config);
  await ensureBuckets(probe, config);
  storage = createStorage(config);
  skipReason = false;
} catch (error) {
  skipReason = `MinIO unavailable: ${(error as Error).message}`;
}

const key = (name: string) => `${prefix}/${name}`;

after(async () => {
  if (!storage) return;
  const entries = await storage.list(prefix).catch(() => []);
  await Promise.all(entries.map((entry) => storage.delete(entry.key)));
});

test("presigned PUT then GET round-trips a file", { skip: skipReason }, async () => {
  const target = key("hello.txt");
  const body = "hello from buildx";

  const putUrl = await storage!.presignPut(target);
  const putRes = await fetch(putUrl, { method: "PUT", body });
  assert.equal(putRes.status, 200);

  const info = await storage!.head(target);
  assert.ok(info, "object should exist after PUT");
  assert.equal(info.size, Buffer.byteLength(body));

  const getUrl = await storage!.presignGet(target);
  const getRes = await fetch(getUrl);
  assert.equal(getRes.status, 200);
  assert.equal(await getRes.text(), body);
});

test("a presigned URL expires", { skip: skipReason }, async () => {
  const target = key("expiring.txt");
  const putUrl = await storage!.presignPut(target);
  await fetch(putUrl, { method: "PUT", body: "expiring" });

  const getUrl = await storage!.presignGet(target, { expiresIn: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2200));

  const res = await fetch(getUrl);
  assert.equal(res.status, 403);
});

test("a URL for key A cannot read key B", { skip: skipReason }, async () => {
  const a = key("a.txt");
  const b = key("b.txt");
  for (const [target, body] of [
    [a, "secret-a"],
    [b, "secret-b"],
  ] as const) {
    await fetch(await storage!.presignPut(target), { method: "PUT", body });
  }

  const signedForA = await storage!.presignGet(a);
  const tampered = signedForA.replace(a, b);
  assert.notEqual(tampered, signedForA, "test setup: keys must differ in the URL");

  const res = await fetch(tampered);
  assert.equal(res.status, 403);
});

test("copy, rotate, list and delete work", { skip: skipReason }, async () => {
  const source = key("source.txt");
  const dest = key("nested/dest.txt");
  await fetch(await storage!.presignPut(source), { method: "PUT", body: "v1" });

  await storage!.copy(source, dest);
  assert.equal((await storage!.head(dest))?.size, 2);

  const rotated = await storage!.rotate(dest);
  assert.equal(rotated.moved, true);
  assert.equal(rotated.prevKey, `${dest}.prev`);
  assert.equal(await storage!.head(dest), null);
  assert.equal((await storage!.head(`${dest}.prev`))?.size, 2);

  const listed = await storage!.list(key("nested"));
  assert.deepEqual(
    listed.map((entry) => entry.key),
    [`${dest}.prev`],
  );

  await storage!.delete(`${dest}.prev`);
  assert.equal(await storage!.head(`${dest}.prev`), null);
});

test("rotate reports a miss for a missing key", { skip: skipReason }, async () => {
  const result = await storage!.rotate(key("does-not-exist.txt"));
  assert.deepEqual(result, {
    moved: false,
    prevKey: `${key("does-not-exist.txt")}.prev`,
  });
});

test("putObject/getObject round-trips a bounded skill artifact", { skip: skipReason }, async () => {
  const target = key("skill/manifest.json");
  const body = new TextEncoder().encode('{"name":"demo"}');
  await storage!.putObject(target, body, { contentType: "application/json" });
  const loaded = await storage!.getObject(target);
  assert.deepEqual(loaded, body);
  await assert.rejects(
    storage!.getObject(target, { maxBytes: 2 }),
    /exceeds 2 bytes/,
  );
  assert.equal(await storage!.getObject(key("missing.json")), null);
});
