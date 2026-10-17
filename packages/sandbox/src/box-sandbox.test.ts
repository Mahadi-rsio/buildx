import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Box } from "@upstash/box";
import { BoxError } from "@upstash/box";
import { BoxSandbox } from "./box-sandbox";

interface BoxMockOptions {
  /** Replacement for `session.wait()`; defaults to resolving `0` after 5ms. */
  wait?: () => Promise<number>;
  /** Chunk emitted to the session's stdout callback at creation time. */
  stdout?: Uint8Array;
  /** Chunk emitted to the session's stderr callback at creation time. */
  stderr?: Uint8Array;
}

/** Default synchronous chunks emitted when a session is created. */
const DEFAULT_STDOUT = Buffer.from("hello world");
const DEFAULT_STDERR = Buffer.from("error message");

/**
 * Build a mock Box with enough of the SDK surface for BoxSandbox to work.
 * `wait` lets tests control when (and with what code) `session.wait()`
 * resolves — used to exercise the exit-marker and timeout paths.
 */
function makeMockBox(options: BoxMockOptions = {}): Box {
  const stdout = options.stdout ?? DEFAULT_STDOUT;
  const stderr = options.stderr ?? DEFAULT_STDERR;
  const storage = new Map<string, string>([
    ["/workspace/home/README.md", "hello world"],
  ]);
  return {
    files: {
      stat: async (path: string, _options?: { follow?: boolean }) => {
        const content = storage.get(path);
        if (content === undefined) {
          return { type: "directory" as const, mod_time: new Date().toISOString() };
        }
        return {
          type: "file" as const,
          size: content.length,
          mod_time: new Date().toISOString(),
        };
      },
      read: async (
        path: string,
        options?: { encoding?: string; offset?: number; length?: number },
      ) => {
        const content = storage.get(path) ?? "";
        if (options?.encoding === "base64") {
          return Buffer.from(content).toString("base64");
        }
        return content;
      },
      write: async (options: { path: string; content: string; encoding?: string }) => {
        storage.set(options.path, options.content);
      },
      list: async (path: string) => {
        const dir = path.replace(/\/$/, "");
        const prefix = dir === "/workspace/home" ? "/workspace/home/" : `${dir}/`;
        const entries = new Map<string, { name: string; is_dir: boolean }>();
        for (const key of storage.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rel = key.slice(prefix.length);
          const first = rel.split("/")[0];
          if (!entries.has(first)) {
            entries.set(first, {
              name: first,
              is_dir: rel.includes("/"),
            });
          }
        }
        return [...entries.entries()].map(([name, e]) => ({
          name,
          path: `${path === "/" ? "" : path}/${name}`,
          size: storage.get(`${prefix}${name}`)?.length ?? 0,
          is_dir: e.is_dir,
          mod_time: new Date().toISOString(),
        }));
      },
      mkdir: async () => {},
      rename: async () => {},
      remove: async () => {},
      upload: async () => {},
      download: async () => {},
    },
    exec: {
      session: async (opts: {
        cmd?: string;
        cwd?: string;
        env?: string[];
        onStdout?: (data: Uint8Array) => void;
        onStderr?: (data: Uint8Array) => void;
      }) => {
        if (opts.onStdout) {
          opts.onStdout(stdout);
        }
        if (opts.onStderr) {
          opts.onStderr(stderr);
        }
        let resolveWait: ((code: number) => void) | undefined;
        const wait = () =>
          options.wait
            ? options.wait()
            : new Promise<number>((resolve) => {
                resolveWait = resolve;
                setTimeout(() => resolve(0), 5);
              });
        return {
          pid: 1234,
          execId: "exec-1",
          write: async (_data: string | Uint8Array) => {},
          endStdin: async () => {},
          resize: async (_rows: number, _cols: number) => {},
          terminate: async (_graceMs?: number) => {
            if (resolveWait) resolveWait(124);
          },
          kill: async (_sig?: string) => {},
          wait,
          close: async () => {},
        };
      },
      command: async (_cmd: string) => {
        return {
          exitCode: 0,
          output: "command output",
          error: "",
          status: "completed" as const,
        };
      },
      stream: async () => {},
      code: async () => {},
    },
    snapshot: async (_options: { name: string }) => {
      return { id: "snap-" + randomUUID() };
    },
    getPublicURL: async (port: number, _options?: {
      bearerToken?: boolean;
      basicAuth?: boolean;
    }) => {
      return { url: `https://preview.example.com:${port}` };
    },
    pause: async () => {},
    delete: async () => {
      storage.clear();
    },
  } as unknown as Box;
}

let mockBox: Box;

function makeSandbox(options: BoxMockOptions = {}): BoxSandbox {
  mockBox = makeMockBox(options);
  return new BoxSandbox({
    name: "test-box",
    apiKey: "dummy-key",
    box: mockBox,
  });
}

test("BoxSandbox.start() is a no-op when box is pre-attached", async () => {
  const s = makeSandbox();
  await s.start();
  assert.ok(s["box"], "box should be attached after start");
});

test("BoxSandbox.exec streams chunks", async () => {
  const s = makeSandbox();
  await s.start();

  const chunks: ExecChunk[] = [];
  for await (const chunk of s.exec("echo hello world", { timeoutMs: 5000 })) {
    chunks.push(chunk);
  }

  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks.find((c) => c.stream === "stdout")?.data, "hello world");
  assert.strictEqual(chunks.find((c) => c.stream === "stderr")?.data, "error message");
});

test("BoxSandbox.exec with timeout throws", async () => {
  // session.wait() never resolves on its own; only terminate() (triggered by
  // the timeout timer) resolves it.
  const s = makeSandbox({ wait: () => new Promise<number>(() => {}) });
  await s.start();

  let threw = false;
  try {
    for await (const _ of s.exec("sleep 99999", { timeoutMs: 50 })) {
      // consume
    }
  } catch (e) {
    threw = true;
    assert.strictEqual((e as Error).message, "command timed out after 50ms");
  }
  assert.strictEqual(threw, true);
});

test("BoxSandbox.readFile returns file content", async () => {
  const s = makeSandbox();
  await s.start();

  const content = await s.readFile("README.md");
  assert.strictEqual(content, "hello world");
});

test("BoxSandbox.readFile with line range", async () => {
  const s = makeSandbox();
  await s.start();

  await s.writeFile("test.txt", "line1\nline2\nline3\nline4\nline5");

  const rangeContent = await s.readFile("test.txt", { offset: 1, limit: 2 });
  assert.strictEqual(rangeContent, "line2\nline3");
});

test("BoxSandbox.writeFile creates/overwrites file", async () => {
  const s = makeSandbox();
  await s.start();

  await s.writeFile("new.txt", "new content");
  const content = await s.readFile("new.txt");
  assert.strictEqual(content, "new content");
});

test("BoxSandbox.exec emits an exit marker for non-zero exit codes", async () => {
  const s = makeSandbox({ wait: async () => 7 });
  await s.start();

  const chunks: ExecChunk[] = [];
  for await (const chunk of s.exec("false")) {
    chunks.push(chunk);
  }

  assert.strictEqual(chunks.length, 3);
  const marker = chunks.at(-1);
  assert.strictEqual(marker?.stream, "stderr");
  assert.match(marker?.data ?? "", /command exited with code 7/);
});

test("BoxSandbox.exec throws AbortError when the signal is already aborted", async () => {
  const s = makeSandbox();
  await s.start();

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    async () => {
      for await (const _ of s.exec("sleep 10", { signal: controller.signal })) {
        // consume
      }
    },
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("BoxSandbox.exec marks an abort mid-run with AbortError", async () => {
  // wait() never resolves on its own; only terminate (from abort) resolves it.
  const s = makeSandbox({ wait: () => new Promise<number>(() => {}) });
  await s.start();

  const controller = new AbortController();
  const promise = (async () => {
    for await (const _ of s.exec("sleep 10", { signal: controller.signal })) {
      // consume
    }
  })();

  controller.abort();

  await assert.rejects(promise, (error: unknown) => (error as Error).name === "AbortError");
});

test("BoxSandbox.exec caps output with a truncation marker", async () => {
  const payload = Buffer.from("x".repeat(400 * 1024));
  const s = makeSandbox({ stdout: payload, stderr: Buffer.alloc(0) });
  await s.start();

  let stdoutBytes = 0;
  let sawMarker = false;
  for await (const chunk of s.exec("dump")) {
    if (chunk.stream === "stdout") stdoutBytes += Buffer.byteLength(chunk.data, "utf8");
    if (chunk.stream === "stderr" && /output truncated/.test(chunk.data)) {
      sawMarker = true;
    }
  }

  // Head (64KiB) + tail (256KiB) survive; the middle is elided with a marker.
  assert.equal(stdoutBytes, (64 + 256) * 1024);
  assert.equal(sawMarker, true);
});

test("BoxSandbox.start creates the box when getByName returns 404", async () => {
  const created = makeMockBox({ wait: async () => 0 });
  const originalGet = Box.getByName;
  const originalCreate = Box.create;
  Box.getByName = async () => {
    throw new BoxError("box not found", 404);
  };
  Box.create = async () => created;
  try {
    const s = new BoxSandbox({ name: "brand-new", apiKey: "k" });
    await s.start();
    assert.strictEqual(s["box"], created);
  } finally {
    Box.getByName = originalGet;
    Box.create = originalCreate;
  }
});

test("BoxSandbox.start rethrows non-404 errors from getByName", async () => {
  const originalGet = Box.getByName;
  Box.getByName = async () => {
    throw new BoxError("unauthorized", 401);
  };
  try {
    const s = new BoxSandbox({ name: "forbidden", apiKey: "k" });
    await assert.rejects(() => s.start(), /unauthorized/);
  } finally {
    Box.getByName = originalGet;
  }
});

test("BoxSandbox.startBackground returns log path", async () => {
  const s = makeSandbox();
  await s.start();

  const procId = await s.startBackground("echo hello");
  assert.ok(procId.startsWith("..buildx/bg-"));
  assert.ok(procId.endsWith(".log"));
});

test("BoxSandbox.checkpoint returns snapshot id", async () => {
  const s = makeSandbox();
  await s.start();

  const id = await s.checkpoint("my-checkpoint");
  assert.ok(id.startsWith("snap-"));
});

test("BoxSandbox.restore swaps box reference", async () => {
  const s = makeSandbox();
  await s.start();

  const freshMock = makeMockBox();
  const original = Box.fromSnapshot;
  Box.fromSnapshot = async () => freshMock;
  try {
    await s.restore("snap-fake-id");
  } finally {
    Box.fromSnapshot = original;
  }

  assert.strictEqual(s["box"], freshMock);
  const content = await s.readFile("README.md");
  assert.strictEqual(content, "hello world");
});

test("BoxSandbox.suspend catches errors gracefully", async () => {
  const s = makeSandbox();
  await s.start();

  await s.suspend();
});

test("BoxSandbox.destroy deletes the box", async () => {
  const s = makeSandbox();
  await s.start();

  await s.destroy();

  let threw = false;
  try {
    await s.readFile("anything");
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, true);
});

test("BoxSandbox.previewUrl returns public URL", async () => {
  const s = makeSandbox();
  await s.start();

  const url = await s.previewUrl(3000);
  assert.strictEqual(url, "https://preview.example.com:3000");
});

test("BoxSandbox.listDir lists entries", async () => {
  const s = makeSandbox();
  await s.start();

  const entries = await s.listDir(".");
  assert.ok(entries.some((e) => e.name === "README.md"));
});

test("BoxSandbox.readInfo returns metadata", async () => {
  const s = makeSandbox();
  await s.start();

  const info = await s.readInfo("README.md");
  assert.strictEqual(info.binary, false);
  assert.strictEqual(info.content, "hello world");
  assert.ok(info.size > 0);
});

test("BoxSandbox.listFiles recursively lists files", async () => {
  const s = makeSandbox();
  await s.start();

  const files = await s.listFiles();
  assert.ok(files.some((f) => f.path === "README.md"));
});

test("BoxSandbox.stat classifies entries", async () => {
  const s = makeSandbox();
  await s.start();

  const file = await s.stat("README.md");
  assert.deepStrictEqual(file, { type: "file" });
  const missing = await s.stat("nope.txt");
  assert.ok(missing === null || missing.type === "dir");
});

test("BoxSandbox.resolve rejects path traversal", async () => {
  const s = makeSandbox();
  await s.start();

  let threw = false;
  try {
    s.resolve("../../../etc/passwd");
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, true);
});

test("BoxSandbox.resolve returns clean path", async () => {
  const s = makeSandbox();
  await s.start();

  assert.strictEqual(s.resolve("src/components"), "src/components");
  assert.strictEqual(s.resolve("./relative"), "relative");
  assert.strictEqual(s.resolve(""), "");
});

// Silence TS: ExecChunk is a local type used in assertions above.
type ExecChunk = { stream: "stdout" | "stderr"; data: string };