import assert from "node:assert/strict";
import { test } from "node:test";
import { Box } from "@upstash/box";
import { BoxSandbox } from "./box-sandbox";
import { LazyBoxSandbox } from "./lazy-box";

const storage = new Map<string, string>();

function makeBox(name = "test-box"): BoxSandbox {
  const mock: unknown = {
    files: {
      write: async (options: { path: string; content: string }) => {
        storage.set(options.path, options.content);
      },
      read: async (path: string, options?: { encoding?: string }) => {
        const content = storage.get(path) ?? "";
        if (options?.encoding === "base64") {
          return Buffer.from(content).toString("base64");
        }
        return content;
      },
      stat: async (path: string) => {
        if (storage.has(path)) {
          return {
            type: "file",
            size: storage.get(path)?.length ?? 0,
            mod_time: new Date().toISOString(),
            inode: 1,
            version: "v1",
          };
        }
        return {
          type: "directory",
          size: 0,
          mod_time: new Date().toISOString(),
          inode: 1,
          version: "v1",
        };
      },
    },
    snapshot: async () => ({ id: "snap-1" }),
    pause: async () => {},
    delete: async () => {
      storage.clear();
    },
    exec: {
      session: async () => ({
        pid: 1,
        execId: "e1",
        write: async () => {},
        endStdin: async () => {},
        resize: async () => {},
        terminate: async () => {},
        kill: async () => {},
        wait: async () => 0,
        close: async () => {},
      }),
      command: async () => ({
        exitCode: 0,
        output: "cmd",
        error: "",
        status: "completed",
      }),
      stream: async () => {},
      code: async () => {},
    },
  };
  return new BoxSandbox({
    name,
    apiKey: "dummy-key",
    box: mock as Box,
  });
}

test("LazyBoxSandbox.start() is a no-op until first operation", async () => {
  let resolved = 0;
  const sandbox = new LazyBoxSandbox({
    resolve: async () => {
      resolved++;
      const box = makeBox();
      await box.start();
      return box;
    },
  });

  await sandbox.start();
  assert.strictEqual(resolved, 0, "box must not resolve on start");
});

test("LazyBoxSandbox resolves once and reuses the instance", async () => {
  let resolved = 0;
  const sandbox = new LazyBoxSandbox({
    resolve: async () => {
      resolved++;
      const box = makeBox();
      await box.start();
      return box;
    },
  });

  await sandbox.writeFile("notes.txt", "hello");
  await sandbox.readFile("notes.txt");
  await sandbox.checkpoint("c1");

  assert.strictEqual(resolved, 1, "box must resolve exactly once");
});

test("LazyBoxSandbox onDestroy pauses instead of deleting", async () => {
  const pauses: string[] = [];
  const sandbox = new LazyBoxSandbox({
    resolve: async () => {
      const box = makeBox();
      await box.start();
      const original = box.destroy.bind(box);
      box.destroy = async () => {
        pauses.push("delete");
        return original();
      };
      box.suspend = async () => {
        pauses.push("suspend");
      };
      return box;
    },
    onDestroy: async (box) => {
      await box.suspend();
    },
  });

  await sandbox.writeFile("notes.txt", "hello");
  await sandbox.destroy();

  assert.deepStrictEqual(pauses, ["suspend"]);
});