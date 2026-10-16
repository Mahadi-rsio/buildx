#!/usr/bin/env node
/*
 * sandbox-daemon — zero-dependency HTTP service that runs inside the Fly
 * sandbox image (arcetecture.md §2.3). It exposes a small, token-authenticated
 * API the orchestrator uses to run commands and touch files in /workspace,
 * plus init/sync so a workspace can be restored from and archived to S3:
 *
 *   GET  /health, /healthz          liveness + tool presence (no auth)
 *   POST /init                      bootstrap-token auth; body { token,
 *                                   restoreUrl }. Sets the per-workspace token
 *                                   and (optionally) restores a tar.zst backup.
 *   POST /exec                      run a command (streams NDJSON lines)
 *   GET  /fs?path=…  (+ &offset=&limit=) list dir or read a file
 *   PUT  /fs                        write a file  { path, content }
 *   POST /sync                      body { uploadUrl }; tar.zst of /workspace
 *                                   uploaded, returns { size, sha256 }
 *
 * Security model:
 *   - Refuses to start without SANDBOX_TOKEN (fail closed).
 *   - Before /init only /health, /healthz and /init are accepted; everything
 *     else is 409. /init is itself protected by the bootstrap token. Per-
 *     workspace tokens are compared in constant time (timingSafeEqual).
 *   - All paths are scoped to $WORKSPACE_ROOT (default /workspace); traversal
 *     is rejected. tar restore/pack never touches anything outside the root.
 *   - Per-command timeout, max output cap, and process-tree cleanup on
 *     timeout/cancellation.
 * Written as plain Node ESM on purpose so the Docker image needs no node_modules.
 */

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const PORT = Number(process.env.SANDBOX_PORT || 8080);
const TOKEN = process.env.SANDBOX_TOKEN || "";
const WORKSPACE_ROOT = resolve(process.env.WORKSPACE_ROOT || "/workspace");

if (!TOKEN) {
  process.stderr.write(
    "sandbox-daemon: refusing to start — SANDBOX_TOKEN is empty (fail closed)\n",
  );
  process.exit(1);
}

export const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MiB for file writes
export const MAX_READ_BYTES = 4 * 1024 * 1024; // 4 MiB per file read
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024; // 32 MiB per exec
const MAX_EXEC_MS = 10 * 60 * 1000; // hard wall-clock cap per command
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024; // 200 MiB per backup
const MAX_TRANSFER_MS = 15 * 60 * 1000; // cap for tar + upload
const RESTORE_RETRIES = 3;

/** Directories excluded from backups (phase.md §5). */
const BACKUP_EXCLUDES = [
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  ".cache",
  ".pnpm-store",
  ".git",
  ".env",
  ".env.*",
];

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
  "zstd",
  "tar",
];

const state = {
  initialized: false,
  /** Per-workspace token set by /init; never logged. */
  activeToken: null,
  lastActivityAt: null,
};

function digest(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  return createHash("sha256").update(token).digest();
}

/** Constant-time comparison of two bearer tokens (fixed-length digests). */
function tokensEqual(a, b) {
  const ha = digest(a);
  const hb = digest(b);
  if (!ha || !hb) return false;
  return timingSafeEqual(ha, hb);
}

function reply(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function touch() {
  state.lastActivityAt = new Date().toISOString();
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

/** Read the bearer token out of an Authorization header. */
function bearer(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+?)\s*$/.exec(header);
  return match ? match[1] : "";
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

async function health() {
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
  return {
    ok: true,
    pid: process.pid,
    workspace: WORKSPACE_ROOT,
    initialized: state.initialized,
    lastActivityAt: state.lastActivityAt,
    tools,
  };
}

/** Download `url` into `dest`, streaming from a ReadableStream body. */
async function downloadTo(url, dest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_TRANSFER_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) {
      throw new Error(`restore download failed: HTTP ${res.status}`);
    }
    const file = createWriteStream(dest);
    await new Promise((resolve, reject) => {
      Readable.fromWeb(res.body).pipe(file);
      file.on("finish", resolve);
      file.on("error", reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a tar.zst archive into `cwd`. */
function extractTar(cwd, archive) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-I", "zstd", "-xf", archive, "-C", cwd, "--no-same-owner"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("restore extraction timed out"));
    }, MAX_TRANSFER_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`restore extraction failed (tar exit ${code})`));
    });
  });
}

/**
 * Validate archive entries so no absolute path or `..` traversal can escape the
 * workspace root while tar extracts.
 */
function validateArchiveEntries(archive) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-I", "zstd", "-tf", archive], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (errOut += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `archive listing failed (tar exit ${code}): ${errOut.trim()}`,
          ),
        );
        return;
      }
      for (const line of out.split("\n")) {
        const entry = line.trim();
        if (!entry) continue;
        const norm = entry.replace(/^\.\//, "");
        if (entry.startsWith("/") || norm.split(sep).includes("..")) {
          reject(new Error(`archive entry escapes workspace root: ${entry}`));
          return;
        }
      }
      resolve();
    });
  });
}

/** Restore a tar.zst archive into the workspace root. */
async function restoreArchive(restoreUrl) {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "buildx-restore-"));
  const archive = join(dir, "restore.tar.zst");
  try {
    await downloadTo(restoreUrl, archive);
    await validateArchiveEntries(archive);
    await extractTar(WORKSPACE_ROOT, archive);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Create a tar.zst of /workspace, excluding node_modules, build dirs, and
 * secret files (phase.md §5). Returns the temp archive path + its dir.
 */
async function createBackup() {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "buildx-backup-"));
  const archive = join(dir, "backup.tar.zst");
  const excludes = BACKUP_EXCLUDES.map((e) => `--exclude=${e}`);
  const child = spawn(
    "tar",
    ["-I", "zstd", "-cf", archive, ...excludes, "-C", WORKSPACE_ROOT, "."],
    { stdio: ["ignore", "pipe", "pipe"], cwd: WORKSPACE_ROOT },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), MAX_TRANSFER_MS);
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  const code = await new Promise((res) => child.on("exit", res));
  clearTimeout(timer);
  if (code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`backup tar failed (exit ${code}): ${stderr.join("")}`);
  }
  const info = await stat(archive);
  if (info.size > MAX_BACKUP_BYTES) {
    await rm(dir, { recursive: true, force: true });
    const err = new Error(
      `backup too large: ${info.size} bytes exceeds ${MAX_BACKUP_BYTES}`,
    );
    err.status = 413;
    err.size = info.size;
    throw err;
  }
  return { archive, dir };
}

function fileSha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** POST /init — set per-workspace token, optionally restore a backup. */
async function handleInit(req, res) {
  if (state.initialized) {
    reply(res, 409, { error: "already_initialized" });
    return;
  }
  if (!tokensEqual(bearer(req), TOKEN)) {
    reply(res, 401, { error: "unauthorized" });
    return;
  }
  const body = JSON.parse(await readBody(req, 1024 * 1024));
  const { token, restoreUrl } = body;
  if (typeof token !== "string" || token.length < 16) {
    reply(res, 400, { error: "token must be a string of >= 16 chars" });
    return;
  }
  if (typeof restoreUrl === "string" && restoreUrl.length > 0) {
    let lastError;
    for (let attempt = 0; attempt < RESTORE_RETRIES; attempt += 1) {
      try {
        await restoreArchive(restoreUrl);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
  }

  state.activeToken = token;
  state.initialized = true;
  state.lastActivityAt = new Date().toISOString();
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  reply(res, 200, { ok: true, workspace: WORKSPACE_ROOT });
}

/** POST /sync — archive /workspace and upload it to a presigned PUT URL. */
async function handleSync(req, res) {
  const body = JSON.parse(await readBody(req, 1024 * 1024));
  const { uploadUrl } = body;
  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    reply(res, 400, { error: "missing `uploadUrl`" });
    return;
  }
  const { archive, dir } = await createBackup();
  try {
    const sha256 = await fileSha256(archive);
    const info = await stat(archive);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_TRANSFER_MS);
    let uploadRes;
    try {
      uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(info.size),
        },
        body: Readable.toWeb(createReadStream(archive)),
        duplex: "half",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!uploadRes.ok) {
      throw new Error(`backup upload failed: HTTP ${uploadRes.status}`);
    }
    reply(res, 200, { ok: true, size: info.size, sha256 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** POST /exec — run a shell command, streaming NDJSON chunks then exit. */
async function handleExec(req, res) {
  const body = JSON.parse(await readBody(req, 1024 * 1024));
  const { cmd, cwd, env, timeoutMs } = body;
  if (typeof cmd !== "string" || cmd.length === 0) {
    reply(res, 400, { error: "missing or empty `cmd`" });
    return;
  }
  touch();
  const root = resolve(WORKSPACE_ROOT);
  const workingDir = cwd ? resolveInRoot(`${cwd}`) : root;

  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const send = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // Client went away; the child is reaped below.
    }
  };

  const effMs = Math.min(
    typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : MAX_EXEC_MS,
    MAX_EXEC_MS,
  );

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

  let finished = false;
  let outputBytes = 0;
  let truncated = false;
  const killTree = () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };

  const onClientGone = () => {
    if (!finished) killTree();
  };
  res.on("close", onClientGone);

  const onChunk = (stream) => (data) => {
    const str = data.toString();
    outputBytes += Buffer.byteLength(str);
    if (outputBytes > MAX_OUTPUT_BYTES && !truncated) {
      truncated = true;
      send({ stream: "stderr", data: "\n[output truncated]\n" });
      killTree();
      return;
    }
    if (truncated) return;
    send({ stream, data: str });
  };

  child.stdout?.on("data", onChunk("stdout"));
  child.stderr?.on("data", onChunk("stderr"));
  child.on("error", (err) =>
    send({ stream: "stderr", data: `${err.message}\n` }),
  );

  const timer = setTimeout(() => {
    send({ stream: "stderr", data: `\n[timed out after ${effMs}ms]\n` });
    killTree();
  }, effMs);

  const code = await new Promise((resolveExit) => {
    child.on("close", (exitCode) => resolveExit(exitCode));
  });
  finished = true;
  clearTimeout(timer);
  res.removeListener("close", onClientGone);
  send({ exit: typeof code === "number" ? code : 1 });
  res.end();
}

/** GET /fs — list a directory or read a file (optionally line-ranged). */
async function handleFsGet(req, res, url) {
  touch();
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
  touch();
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

    if (
      req.method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/healthz")
    ) {
      reply(res, 200, await health());
      return;
    }
    if (req.method === "POST" && url.pathname === "/init") {
      await handleInit(req, res);
      return;
    }

    // Everything below requires the daemon to be initialized.
    if (!state.initialized) {
      reply(res, 409, { error: "not_initialized", path: url.pathname });
      return;
    }
    if (!tokensEqual(bearer(req), state.activeToken)) {
      reply(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      await handleExec(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/sync") {
      await handleSync(req, res);
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