import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LocalSandbox } from "./local";
import type { ExecChunk } from "./index";

let dir: string;
let sandbox: LocalSandbox;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "buildx-sandbox-"));
  sandbox = new LocalSandbox({ rootDir: dir });
  await sandbox.start();
});

after(async () => {
  await sandbox.destroy();
  await rm(dir, { recursive: true, force: true });
});

test("writeFile then readFile round-trips", async () => {
  await sandbox.writeFile("a/b.txt", "hello\nworld\n");
  assert.equal(await sandbox.readFile("a/b.txt"), "hello\nworld\n");
});

test("readFile supports line ranges", async () => {
  await sandbox.writeFile("lines.txt", "l0\nl1\nl2\nl3\nl4");
  assert.equal(
    await sandbox.readFile("lines.txt", { offset: 1, limit: 2 }),
    "l1\nl2",
  );
});

test("readFile rejects path traversal", async () => {
  await assert.rejects(
    () => sandbox.readFile("../escape.txt"),
    /escapes sandbox root/,
  );
});

test("writeFile rejects path traversal", async () => {
  await assert.rejects(
    () => sandbox.writeFile("../escape.txt", "x"),
    /escapes sandbox root/,
  );
});

test("exec streams stdout", async () => {
  let out = "";
  for await (const chunk of sandbox.exec("echo hi")) {
    out += chunk.data;
  }
  assert.equal(out.trim(), "hi");
});

test("exec respects cwd", async () => {
  await sandbox.writeFile("sub/marker.txt", "x");
  let out = "";
  for await (const chunk of sandbox.exec("ls", { cwd: "sub" })) {
    out += chunk.data;
  }
  assert.equal(out.trim(), "marker.txt");
});

test("exec with a timeout does not hang", async () => {
  const started = Date.now();
  for await (const _chunk of sandbox.exec("sleep 5", { timeoutMs: 200 })) {
    // drain
  }
  assert.ok(Date.now() - started < 3000, "command should be killed by timeout");
});

test("exec throws AbortError when the signal aborts mid-command", async () => {
  const controller = new AbortController();
  const promise = (async () => {
    for await (const _chunk of sandbox.exec("sleep 30", {
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  controller.abort();

  await assert.rejects(
    promise,
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("exec emits an exit marker for non-zero exit codes", async () => {
  const chunks: ExecChunk[] = [];
  for await (const chunk of sandbox.exec("exit 3")) {
    chunks.push(chunk);
  }
  const marker = chunks.at(-1);
  assert.strictEqual(marker?.stream, "stderr");
  assert.match(marker?.data ?? "", /command exited with code 3/);
});
