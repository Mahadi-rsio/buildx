import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { LazySandbox } from "./lazy-sandbox";

let server: Server;
let baseUrl = "";
let execCalls = 0;
let healthCalls = 0;

before(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      healthCalls += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/exec") {
      execCalls += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      res.end(`${JSON.stringify({ stream: "stdout", data: "ok\n" })}\n${JSON.stringify({ exit: 0 })}\n`);
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("start does not resolve daemon connection", async () => {
  let resolves = 0;
  const sandbox = new LazySandbox({
    resolve: async () => {
      resolves += 1;
      return { baseUrl, token: "token" };
    },
  });
  await sandbox.start();
  assert.equal(resolves, 0);
});

test("first tool call resolves once and reuses the daemon connection", async () => {
  let resolves = 0;
  execCalls = 0;
  healthCalls = 0;

  const sandbox = new LazySandbox({
    resolve: async () => {
      resolves += 1;
      return { baseUrl, token: "token" };
    },
  });

  let output = "";
  for await (const chunk of sandbox.exec("echo hi")) {
    output += chunk.data;
  }
  assert.equal(output.trim(), "ok");
  assert.equal(resolves, 1);
  assert.equal(execCalls, 1);
  assert.equal(healthCalls, 0);

  for await (const _chunk of sandbox.exec("echo again")) {
    // drain
  }
  assert.equal(resolves, 1);
  assert.equal(execCalls, 2);
});

test("destroy calls onDestroy only after a lazy connection was resolved", async () => {
  let resolves = 0;
  const destroyed: string[] = [];
  const sandbox = new LazySandbox({
    resolve: async () => {
      resolves += 1;
      return { baseUrl, token: "token" };
    },
    onDestroy: async (connection) => {
      destroyed.push(connection.baseUrl);
    },
  });

  await sandbox.destroy();
  assert.equal(resolves, 0);
  assert.equal(destroyed.length, 0);

  for await (const _chunk of sandbox.exec("echo once")) {
    // drain
  }
  await sandbox.destroy();
  assert.equal(resolves, 1);
  assert.deepEqual(destroyed, [baseUrl]);
});
