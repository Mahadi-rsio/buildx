import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Box } from "@upstash/box";
import { BoxSandbox } from "./box-sandbox";

/**
 * Build a mock Box with enough of the SDK surface for BoxSandbox to work.
 * `sessionWait` lets tests control when `session.wait()` resolves (used to
 * exercise the timeout path).
 */
function makeMockBox(sessionWait?: () => Promise<number>): Box {
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
          opts.onStdout(Buffer.from("hello world"));
        }
        if (opts.onStderr) {
          opts.onStderr(Buffer.from("error message"));
        }
        let resolveWait: ((code: number) => void) | undefined;
        const wait = () =>
          sessionWait
            ? sessionWait()
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

function makeSandbox(sessionWait?: () => Promise<number>): BoxSandbox {
  mockBox = makeMockBox(sessionWait);
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
  const s = makeSandbox(() => new Promise<number>(() => {}));
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