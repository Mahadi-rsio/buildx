#!/usr/bin/env node
/*
 * sandbox-daemon — zero-dependency HTTP service that runs inside the Fly
 * sandbox image (arcetecture.md §2.3). It exposes a small, token-authenticated
 * API the orchestrator uses to run commands and touch files in /workspace:
 *
 *   GET  /healthz                        liveness + tool presence
 *   POST /exec                           run a command (streams NDJSON lines)
 *   GET  /fs?path=…  (+ &offset=&limit=) list dir or read a file
 *   PUT  /fs                             write a file  { path, content }
 *
 * All endpoints except /healthz require `Authorization: Bearer $SANDBOX_TOKEN`.
 * Requests are scoped to $WORKSPACE_ROOT (default /workspace); path traversal
 * is rejected. Written as plain Node ESM on purpose so the Docker image needs
 * no node_modules at all.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PORT = Number(process.env.SANDBOX_PORT || 8080);
const TOKEN = process.env.SANDBOX_TOKEN || "";
const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || "/workspace");
export const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MiB for file writes
export const MAX_READ_BYTES = 4 * 1024 * 1024; // 4 MiB per file read

export const TOOL_LIST = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "bun",
  "python3",
  "pip3",
  "git",
  "curl",
  "rg",
  "fd",
  "jq",
  "gcc",
  "make",
  "ssh",
];

function reply(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** Resolve `rel` inside the workspace root, rejecting traversal. */
function resolveInRoot(rel) {
  const root = resolve(WORKSPACE_ROOT);
  const target = resolve(root, rel || "");
  const r = relative(root, target);
  if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) {
    const err = new Error(`path escapes workspace root: ${rel}`);
    err.status = 400;
    throw err;
  }
  return target;
}

function auth(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${TOKEN}`;
}

/** Collect a request body, rejecting anything over the byte cap. */
function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        rej(new Error(`body exceeds ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

async function healthz() {
  const tools = {};
  const check = (cmd, args = ["--version"]) =>
    new Promise((res) => {
      const child = spawn(cmd, args, {
        stdio: ["ignore", "ignore", "inherit"],
        shell: false,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        res(false);
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        res(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        res(code === 0);
      });
    });
  for (const tool of TOOL_LIST) {
    tools[tool] = await check(tool);
  }
  return { ok: true, pid: process.pid, workspace: WORKSPACE_ROOT, tools };
}

/** POST /exec — run a shell command, streaming NDJSON chunks then exit. */
async function handleExec(req, res) {
  const body = JSON.parse(await readBody(req, 1024 * 1024));
  const { cmd, cwd, env, timeoutMs } = body;
  if (typeof cmd !== "string" || cmd.length === 0) {
    reply(res, 400, { error: "missing or empty `cmd`" });
    return;
  }

  const root = resolve(WORKSPACE_ROOT);
  const workingDir = cwd ? resolveInRoot(`${cwd}`) : root;

  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const send = (obj) => void res.write(`${JSON.stringify(obj)}\n`);

  const child = spawn(cmd, {
    shell: true,
    cwd: workingDir,
    env: {
      HOME: process.env.HOME || "/root",
      PATH: process.env.PATH,
      ...env,
    },
    detached: true,
  });

  const killTree = () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };

  const timer =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? setTimeout(killTree, timeoutMs)
      : undefined;

  child.stdout?.on("data", (data) =>
    send({ stream: "stdout", data: data.toString() }),
  );
  child.stderr?.on("data", (data) =>
    send({ stream: "stderr", data: data.toString() }),
  );
  child.on("error", (err) =>
    send({ stream: "stderr", data: `${err.message}\n` }),
  );
  const finished = new Promise((resolveExit) => {
    child.on("close", (code) => resolveExit(code));
  });
  const code = await finished;
  if (timer) clearTimeout(timer);
  send({ exit: typeof code === "number" ? code : 1 });
  res.end();
}

/** GET /fs — list a directory or read a file (optionally line-ranged). */
async function handleFsGet(req, res, url) {
  const rel = url.searchParams.get("path")?.trim() || "";
  if (rel.includes("\0")) {
    reply(res, 400, { error: "nul byte in path" });
    return;
  }
  const target = resolveInRoot(rel);
  let info;
  try {
    info = await stat(target);
  } catch {
    reply(res, 404, { error: "not_found", path: rel });
    return;
  }

  if (info.isDirectory()) {
    const dirents = await readdir(target, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (entry) => {
        const meta = entry.isDirectory()
          ? null
          : await stat(join(target, entry.name)).catch(() => null);
        return {
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
          size: meta?.isFile() ? meta.size : undefined,
          mtime: meta?.mtimeMs,
        };
      }),
    );
    reply(res, 200, { path: rel, type: "dir", entries });
    return;
  }

  if (info.size > MAX_READ_BYTES) {
    reply(res, 413, { error: "file_too_large", path: rel, size: info.size });
    return;
  }

  const buffer = await readFile(target);
  const binary = buffer.includes(0);
  let content = buffer.toString("utf8");

  const offset = Number(url.searchParams.get("offset") || "0");
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw !== null) {
    const lines = content.split("\n");
    const limit = Number(limitRaw || "0");
    const end = limit > 0 ? offset + limit : undefined;
    content = lines.slice(offset, end).join("\n");
  }

  reply(res, 200, {
    path: rel,
    type: "file",
    content,
    binary,
    size: info.size,
    mtime: info.mtimeMs,
  });
}

/** PUT /fs — write a file. Body: { path, content }. */
async function handleFsPut(req, res) {
  const body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
  const rel = body.path;
  if (typeof rel !== "string" || rel.length === 0) {
    reply(res, 400, { error: "missing `path`" });
    return;
  }
  const target = resolveInRoot(rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body.content ?? "", "utf8");
  reply(res, 200, {
    path: rel,
    bytes: Buffer.byteLength(body.content ?? "", "utf8"),
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      reply(res, 200, await healthz());
      return;
    }

    if (!auth(req)) {
      reply(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      await handleExec(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/fs") {
      await handleFsGet(req, res, url);
      return;
    }
    if (req.method === "PUT" && url.pathname === "/fs") {
      await handleFsPut(req, res);
      return;
    }
    reply(res, 404, { error: "not_found", path: url.pathname });
  } catch (error) {
    const status = error.status || 500;
    reply(res, status, { error: error.message || String(error) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(
    `sandbox-daemon listening on :${PORT} (workspace ${WORKSPACE_ROOT})\n`,
  );
});