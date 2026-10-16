import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * End-to-end tests for the sandbox-daemon (services/sandbox-daemon/server.mjs).
 * The daemon is spawned as a real child process; tests cover fail-closed auth,
 * the init handshake, path-traversal rejection, exec timeouts/output caps, and
 * the sync/restore tar.zst round-trip.
 */

const DAEMON_PATH = fileURLToPath(
  new URL("../../../services/sandbox-daemon/server.mjs", import.meta.url),
);

const zstdAvailable = spawnSync("zstd", ["--version"], { stdio: "ignore" })
  .status === 0;
const ZSTD_TAG = zstdAvailable
  ? false
  : "zstd not installed locally; skipping tar.zst tests";

interface TestDaemon {
  child: ChildProcess;
  port: number;
  workspace: string;
  baseUrl: string;
  waitReady: Promise<void>;
  stop: () => Promise<void>;
}

let daemon: TestDaemon | undefined;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
    srv.on("error", rej);
  });
}

async function startDaemon(opts: { token?: string; workspace?: string }): Promise<TestDaemon> {
  const port = await freePort();
  const workspace = opts.workspace ?? (await mkdtemp(join(tmpdir(), "bxd-")));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.SANDBOX_PORT = String(port);
  env.WORKSPACE_ROOT = workspace;
  if (opts.token !== undefined) env.SANDBOX_TOKEN = opts.token;
  const child = spawn(process.execPath, [DAEMON_PATH], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (d) => stdout.push(d.toString()));
  child.stderr.on("data", (d) => stderr.push(d.toString()));

  const ready = new Promise<void>((res, rej) => {
    const check = setInterval(() => {
      if (stdout.join("").includes("sandbox-daemon listening")) {
        clearInterval(check);
        res();
      }
    }, 20);
    child.on("exit", (code) => {
      clearInterval(check);
      rej(
        new Error(
          `daemon exited early (code ${code}) ${stderr.join("")}`.trim(),
        ),
      );
    });
    setTimeout(() => {
      clearInterval(check);
      rej(new Error(`daemon did not start: ${stderr.join("")}`.trim()));
    }, 10_000).unref();
  });

  return {
    child,
    port,
    workspace,
    baseUrl: `http://127.0.0.1:${port}`,
    waitReady: ready,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await new Promise<void>((res) => child.on("exit", () => res()));
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json as Record<string, unknown> };
}

async function execLines(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ lines: unknown[]; status: number }> {
  const res = await fetch(`${baseUrl}/exec`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    lines: (await res.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  };
}

before(async () => {
  daemon = await startDaemon({ token: "bootstrap-token-1234567890" });
  await daemon.waitReady;
});

after(async () => {
  await daemon?.stop();
});

test("refuses to start without SANDBOX_TOKEN", async () => {
  const result = spawnSync(process.execPath, [DAEMON_PATH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SANDBOX_TOKEN: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /refusing to start/);
});

test("rejects everything except /health and /init before /init", async () => {
  const probe = daemon!;
  const health = await call(probe.baseUrl, "GET", "/health");
  assert.equal(health.status, 200);

  for (const [method, path, body] of [
    ["POST", "/exec", { cmd: "echo hi" }],
    ["GET", "/fs?path=.", undefined],
    ["PUT", "/fs", { path: "x", content: "y" }],
    ["POST", "/sync", { uploadUrl: "http://127.0.0.1:9/nope" }],
  ] as const) {
    const res = await call(probe.baseUrl, method, path, body);
    assert.equal(
      res.status,
      409,
      `${method} ${path} should be 409 before init`,
    );
  }

  const badInit = await call(
    probe.baseUrl,
    "POST",
    "/init",
    { token: "workspace-token-1234567890" },
    "wrong-bootstrap",
  );
  assert.equal(badInit.status, 401);
});

test("init sets the per-workspace token; re-init is rejected", async () => {
  const probe = daemon!;
  const token = "workspace-token-1234567890";
  const init = await call(
    probe.baseUrl,
    "POST",
    "/init",
    { token },
    "bootstrap-token-1234567890",
  );
  assert.equal(init.status, 200);

  const reinit = await call(
    probe.baseUrl,
    "POST",
    "/init",
    { token: "another-1234567890" },
    "bootstrap-token-1234567890",
  );
  assert.equal(reinit.status, 409);
});

test("post-init endpoints require the per-workspace token", async () => {
  const probe = daemon!;
  const noAuth = await call(probe.baseUrl, "POST", "/exec", { cmd: "echo hi" });
  assert.equal(noAuth.status, 401);
  const badAuth = await call(
    probe.baseUrl,
    "POST",
    "/exec",
    { cmd: "echo hi" },
    "WRONG-token-1234567890",
  );
  assert.equal(badAuth.status, 401);
});

test("exec streams stdout and exit", async () => {
  const probe = daemon!;
  const token = "workspace-token-1234567890";
  const { status, lines } = await execLines(probe.baseUrl, token, {
    cmd: "echo hi && printf err >&2",
  });
  assert.equal(status, 200);
  const out = lines
    .filter((l): l is { stream: string; data: string } => "stream" in (l as object))
    .map((l) => l.data)
    .join("");
  assert.match(out, /hi/);
  assert.match(out, /err/);
  const exitLine = lines.find((l) => "exit" in (l as object)) as {
    exit: number;
  };
  assert.equal(exitLine.exit, 0);
});

test("exec timeout kills the process tree", async () => {
  const probe = daemon!;
  const token = "workspace-token-1234567890";
  const started = Date.now();
  const { lines } = await execLines(probe.baseUrl, token, {
    cmd: "sleep 30",
    timeoutMs: 300,
  });
  assert.ok(Date.now() - started < 5000, "should not hang 30s");
  const serialized = lines.map((l) => JSON.stringify(l)).join("\n");
  assert.ok(
    serialized.includes("timed out"),
    `expected timeout notice, got: ${serialized}`,
  );
});

test("path traversal is rejected for /fs read, /fs write, and exec cwd", async () => {
  const probe = daemon!;
  const token = "workspace-token-1234567890";

  const readEsc = await call(
    probe.baseUrl,
    "GET",
    "/fs?path=../../etc/passwd",
    undefined,
    token,
  );
  assert.equal(readEsc.status, 400);

  const writeEsc = await call(
    probe.baseUrl,
    "PUT",
    "/fs",
    { path: "../evil.txt", content: "x" },
    token,
  );
  assert.equal(writeEsc.status, 400);

  const cwdEsc = await call(
    probe.baseUrl,
    "POST",
    "/exec",
    { cmd: "pwd", cwd: "../../.." },
    token,
  );
  assert.equal(cwdEsc.status, 400);
});

test("file round-trip against a real workspace root", async () => {
  const probe = daemon!;
  const token = "workspace-token-1234567890";

  const put = await call(
    probe.baseUrl,
    "PUT",
    "/fs",
    { path: "src/hello.txt", content: "hello world" },
    token,
  );
  assert.equal(put.status, 200);

  const get = await call(
    probe.baseUrl,
    "GET",
    "/fs?path=src/hello.txt",
    undefined,
    token,
  );
  assert.equal(get.status, 200);
  assert.equal(get.body.content, "hello world");
});

test("health reports initialized state and tools", async () => {
  const probe = daemon!;
  const health = await call(probe.baseUrl, "GET", "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.initialized, true);
  const tools = health.body.tools as Record<string, boolean>;
  assert.equal(tools.node, true);
  assert.equal(tools.python3, true);
});

test("sync uploads a tar.zst and reports size + sha256", { skip: ZSTD_TAG }, async () => {
  const probe = daemon!;
  const token = "workspace-token-1234567890";

  await writeFile(join(probe.workspace, "payload.txt"), "sync me\n");
  await mkdir(join(probe.workspace, "node_modules"), { recursive: true });
  await writeFile(
    join(probe.workspace, "node_modules/excluded.txt"),
    "should not be archived\n",
  );

  const uploaded: Buffer[] = [];
  const srv = createServer((req, res) => {
    req.on("data", (c) => uploaded.push(c));
    req.on("end", () => {
      res.writeHead(200);
      res.end();
    });
  });
  const srvPort = await freePort();
  await new Promise<void>((res) => srv.listen(srvPort, "127.0.0.1", () => res()));

  try {
    const sync = await call(
      probe.baseUrl,
      "POST",
      "/sync",
      { uploadUrl: `http://127.0.0.1:${srvPort}/backup.tar.zst` },
      token,
    );
    assert.equal(sync.status, 200);
    const { size, sha256 } = sync.body as { size: number; sha256: string };
    const body = Buffer.concat(uploaded);
    assert.equal(body.length, size);
    assert.equal(
      createHash("sha256").update(body).digest("hex"),
      sha256,
    );
    assert.equal(body.includes(Buffer.from("should not be archived")), false);
  } finally {
    srv.close();
  }
});

test("restore via /init extracts a tar.zst into the workspace", { skip: ZSTD_TAG }, async () => {
  const src = await mkdtemp(join(tmpdir(), "bxd-src-"));
  const archive = join(tmpdir(), `bxd-${Date.now()}.tar.zst`);
  await mkdir(join(src, "app"));
  await writeFile(join(src, "app", "main.py"), "print('restored')\n");

  const tar = spawnSync(
    "tar",
    ["-I", "zstd", "-cf", archive, "-C", src, "."],
    { stdio: "ignore" },
  );
  assert.equal(tar.status, 0);

  const uploads = new Map<string, Buffer>();
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      uploads.set(req.url ?? "/", Buffer.concat(chunks));
      if (req.method === "GET") {
        createReadStream(archive).pipe(res);
      } else {
        res.writeHead(200);
        res.end();
      }
    });
  });
  const srvPort = await freePort();
  await new Promise<void>((res) => srv.listen(srvPort, "127.0.0.1", () => res()));

  const restored = await startDaemon({
    token: "bootstrap-two-1234567890",
    workspace: undefined,
  });
  try {
    await restored.waitReady;
    const init = await call(
      restored.baseUrl,
      "POST",
      "/init",
      {
        token: "restore-token-1234567890",
        restoreUrl: `http://127.0.0.1:${srvPort}/restore.tar.zst`,
      },
      "bootstrap-two-1234567890",
    );
    assert.equal(
      init.status,
      200,
      `init failed: ${JSON.stringify(init.body)}`,
    );

    const get = await call(
      restored.baseUrl,
      "GET",
      "/fs?path=app/main.py",
      undefined,
      "restore-token-1234567890",
    );
    assert.equal(get.status, 200);
    assert.equal(get.body.content, "print('restored')\n");
  } finally {
    srv.close();
    await restored.stop();
    await rm(src, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
});

test("restore rejects archive entries escaping the workspace root", { skip: ZSTD_TAG }, async () => {
  const src = await mkdtemp(join(tmpdir(), "bxd-evil-"));
  const archive = join(tmpdir(), `bxd-evil-${Date.now()}.tar.zst`);
  await writeFile(join(src, "../evil.txt"), "boom\n");
  const tar = spawnSync(
    "tar",
    ["-I", "zstd", "-cf", archive, "-C", src, "-P", "../evil.txt"],
    { stdio: "ignore" },
  );
  assert.equal(tar.status, 0);

  const srv = createServer((_req, res) => {
    const stream = createReadStream(archive);
    stream.pipe(res);
  });
  const srvPort = await freePort();
  await new Promise<void>((res) => srv.listen(srvPort, "127.0.0.1", () => res()));

  const daemon2 = await startDaemon({ token: "bootstrap-evil-1234567890" });
  try {
    await daemon2.waitReady;
    const init = await call(
      daemon2.baseUrl,
      "POST",
      "/init",
      {
        token: "evil-token-1234567890",
        restoreUrl: `http://127.0.0.1:${srvPort}/evil.tar.zst`,
      },
      "bootstrap-evil-1234567890",
    );
    assert.equal(
      init.status,
      500,
      `evil init failed unexpectedly: ${JSON.stringify(init.body)}`,
    );
  } finally {
    srv.close();
    await daemon2.stop();
    await rm(src, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
});