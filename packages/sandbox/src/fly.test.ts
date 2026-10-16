import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray, sql } from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import { getDb, type Db } from "@buildx/db";
import { user, workspaces } from "@buildx/db";
import type { Storage, StorageEnv } from "@buildx/storage";
import type { FlyApp, FlyClient, FlyMachine, FlyVolume, MachineConfig } from "./fly-client";
import {
  archive,
  createWorkspace,
  createWorkspaceApp,
  ensureRunning,
  reconcile,
  workspaceAppName,
  workspaceBackupKey,
  workspaceMachineConfig,
} from "./fly-manager";

/**
 * Phase 7 tests: fake Fly client + fake Storage + fake daemon HTTP server +
 * real-Postgres manager tests that skip when the DB is unreachable (quota.eston
 * pattern) + client retry tests against a local HTTP server.
 */

/* ─────────────────────────────── fake client ─────────────────────────────── */

interface FakeCall {
  op: string;
  args: unknown[];
}

/** In-memory Fly API whose call order is recorded for invariant assertions. */
class FakeFlyClient implements FlyClient {
  readonly orgSlug = "test-org";
  calls: FakeCall[] = [];
  private machines = new Map<string, FlyMachine>();
  private volumes = new Map<string, FlyVolume>();
  private apps = new Map<string, FlyApp>();
  private appIps = new Map<string, Array<{ ip: string; type?: string }>>();

  private record(op: string, args: unknown[]) {
    this.calls.push({ op, args });
  }

  createApp(input: { name: string; network?: string; vm?: unknown }) {
    this.record("createApp", [input]);
    const app: FlyApp = { id: `app-${input.name}`, name: input.name };
    this.apps.set(input.name, app);
    return Promise.resolve({ ...app });
  }

  getApp(name: string) {
    this.record("getApp", [name]);
    const app = this.apps.get(name);
    if (!app) throw new Error(`app ${name} not found`);
    return Promise.resolve({ ...app });
  }

  destroyApp(name: string) {
    this.record("destroyApp", [name]);
    this.apps.delete(name);
    return Promise.resolve();
  }

  listIpAssignments(name: string) {
    this.record("listIpAssignments", [name]);
    return Promise.resolve({ ips: this.appIps.get(name) ?? [] });
  }

  createVolume(appName: string, input: { name: string; region?: string; sizeGb: number }) {
    this.record("createVolume", [appName, input]);
    const volume: FlyVolume = {
      id: `vol-${input.name}`,
      name: input.name,
      region: input.region ?? "iad",
      state: "created",
      size_gb: input.sizeGb,
    };
    this.volumes.set(volume.id, volume);
    return Promise.resolve({ ...volume });
  }

  getVolume(appName: string, volumeId: string) {
    this.record("getVolume", [appName, volumeId]);
    const volume = this.volumes.get(volumeId);
    if (!volume) throw new Error(`volume ${volumeId} not found`);
    return Promise.resolve({ ...volume });
  }

  listVolumes(appName: string) {
    this.record("listVolumes", [appName]);
    return Promise.resolve([...this.volumes.values()].map((v) => ({ ...v })));
  }

  destroyVolume(appName: string, volumeId: string) {
    this.record("destroyVolume", [appName, volumeId]);
    this.volumes.delete(volumeId);
    return Promise.resolve();
  }

  createMachine(appName: string, input: { config: MachineConfig; region?: string }) {
    this.record("createMachine", [appName, input]);
    const machine: FlyMachine = {
      id: `mach-${randomUUID().slice(0, 8)}`,
      region: input.region ?? "iad",
      state: "started",
      private_ip: "127.0.0.1",
      config: input.config,
    };
    this.machines.set(machine.id, machine);
    return Promise.resolve({ ...machine });
  }

  getMachine(appName: string, machineId: string) {
    this.record("getMachine", [appName, machineId]);
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`machine ${machineId} not found`);
    return Promise.resolve({ ...machine });
  }

  listMachines(appName: string) {
    this.record("listMachines", [appName]);
    return Promise.resolve([...this.machines.values()].map((m) => ({ ...m })));
  }

  startMachine(appName: string, machineId: string) {
    this.record("startMachine", [appName, machineId]);
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`machine ${machineId} not found`);
    return Promise.resolve({ ...machine });
  }

  stopMachine(appName: string, machineId: string) {
    this.record("stopMachine", [appName, machineId]);
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`machine ${machineId} not found`);
    return Promise.resolve({ ...machine });
  }

  destroyMachine(appName: string, machineId: string, input?: { force?: boolean }) {
    this.record("destroyMachine", [appName, machineId, input]);
    this.machines.delete(machineId);
    return Promise.resolve();
  }

  waitForState(appName: string, machineId: string) {
    this.record("waitForState", [appName, machineId]);
    return Promise.resolve({ ok: true, state: "started" });
  }

  acquireLease(appName: string, machineId: string) {
    this.record("acquireLease", [appName, machineId]);
    return Promise.resolve({ nonce: "nonce-1", expires_at: Date.now() / 1000 + 60 });
  }

  updateMachine(appName: string, machineId: string, input: { config: MachineConfig; leaseNonce: string }) {
    this.record("updateMachine", [appName, machineId, input]);
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`machine ${machineId} not found`);
    const updated: FlyMachine = { ...machine, config: input.config };
    this.machines.set(machineId, updated);
    return Promise.resolve({ ...updated });
  }

  releaseLease(appName: string, machineId: string, nonce: string) {
    this.record("releaseLease", [appName, machineId, nonce]);
    return Promise.resolve();
  }
}

/* ─────────────────────────────── fake storage ─────────────────────────────── */

/** In-memory Storage recording operations; sizes default to the daemon's. */
class FakeStorage implements Storage {
  readonly config = {} as StorageEnv;
  calls: { op: string; args: unknown[] }[] = [];
  /** The byte size `head` reports (kept in sync with the fake daemon). */
  size = 1024;
  missing = new Set<string>();

  async presignPut(key: string) {
    this.calls.push({ op: "presignPut", args: [key] });
    return `https://fake-storage/put/${encodeURIComponent(key)}`;
  }

  async presignGet(key: string) {
    this.calls.push({ op: "presignGet", args: [key] });
    return `https://fake-storage/get/${encodeURIComponent(key)}`;
  }

  async head(key: string) {
    this.calls.push({ op: "head", args: [key] });
    if (this.missing.has(key)) return null;
    return { key, bucket: "b", size: this.size, lastModified: new Date() };
  }

  async copy(sourceKey: string, destKey: string) {
    this.calls.push({ op: "copy", args: [sourceKey, destKey] });
  }

  async delete(key: string) {
    this.calls.push({ op: "delete", args: [key] });
  }

  async rotate(key: string) {
    this.calls.push({ op: "rotate", args: [key] });
    return { moved: true, prevKey: `${key}.prev` };
  }

  async list() {
    this.calls.push({ op: "list", args: [] });
    return [];
  }
}

/* ─────────────────────────────── fake daemon ─────────────────────────────── */

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Minimal sandbox-daemon HTTP server: /health, /init, /sync, /fs. */
class FakeDaemon {
  private server: Server;
  private initialized = false;
  private syncCalls = 0;
  private initCalls = 0;
  private readonly calls: { op: string; args: unknown[] }[] = [];
  /** Set to reject /sync with 500 (simulate an upload failure). */
  failSync = false;
  /** Bytes both /sync reports and storage.head must observe. */
  syncSize = 1024;

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(8080, "127.0.0.1", resolve));
  }

  reset() {
    this.initialized = false;
    this.syncCalls = 0;
    this.initCalls = 0;
    this.calls.length = 0;
    this.failSync = false;
    this.syncSize = 1024;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  callsFor(op: string) {
    return this.calls.filter((c) => c.op === op);
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if ((path === "/health" || path === "/healthz") && req.method === "GET") {
      this.calls.push({ op: "health", args: [] });
      return this.json(res, 200, {
        ok: true,
        initialized: this.initialized,
        lastActivityAt: null,
      });
    }

    if (path === "/init" && req.method === "POST") {
      this.calls.push({ op: "init", args: [] });
      this.initCalls += 1;
      if (this.initialized) {
        return this.json(res, 409, { error: "already_initialized" });
      }
      const body = await readBody(req);
      this.initialized = true;
      void body; // the per-workspace token is what the manager persists.
      return this.json(res, 200, { ok: true, initialized: true });
    }

    if (path === "/sync" && req.method === "POST") {
      this.calls.push({ op: "sync", args: [] });
      this.syncCalls += 1;
      if (this.failSync) {
        return this.json(res, 500, { error: "sync failed (fake)" });
      }
      return this.json(res, 200, {
        ok: true,
        size: this.syncSize,
        sha256: "a".repeat(64),
      });
    }

    if (path === "/exec" && req.method === "POST") {
      this.calls.push({ op: "exec", args: [] });
      // NDJSON: single line with exit 0 (no lockfiles → no installs happen).
      const payload = `${JSON.stringify({ exit: 0 })}\n`;
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      res.end(payload);
      return;
    }

    if (path === "/fs") {
      this.calls.push({ op: "fs", args: [url.searchParams.get("path")] });
      // No lockfiles in the test workspaces → 404 so installs are skipped.
      return this.json(res, 404, { error: "not found" });
    }

    return this.json(res, 404, { error: "not found" });
  }
}

/* ─────────────────────────────── pure tests ─────────────────────────────── */

test("workspaceAppName is a stable, unique, ≤30-char slug", () => {
  const a = workspaceAppName("My Dev Box", "12345678-1234-1234-1234-1234567890ab");
  const b = workspaceAppName("My Dev Box", "12345678-1234-1234-1234-1234567890ab");
  const c = workspaceAppName("My Dev Box", "99999999-1234-1234-1234-1234567890ab");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.length <= 30, `app name is ${a.length} chars`);
  assert.match(a, /^[a-z0-9-]+$/);
});

test("workspaceMachineConfig matches the phase requirement", () => {
  const config = workspaceMachineConfig({
    image: "registry.local/buildx/daemon:latest",
    volumeId: "vol-123",
    env: { FOO: "bar" },
  });
  assert.equal(config.guest?.cpu_kind, "shared");
  assert.equal(config.guest?.cpus, 1);
  assert.equal(config.guest?.memory_mb, 1024);
  assert.equal(config.init?.swap_size_mb, 1024);
  assert.deepEqual(config.mounts, [{ volume: "vol-123", path: "/workspace" }]);
  assert.deepEqual(config.services, []);
  assert.deepEqual(config.restart, { policy: "no" });
  assert.deepEqual(config.env, { FOO: "bar" });
});

test("workspaceMachineConfig honours memory/cpu overrides", () => {
  const config = workspaceMachineConfig({
    image: "img",
    volumeId: "vol",
    memoryMb: 2048,
    cpus: 2,
  });
  assert.equal(config.guest?.cpus, 2);
  assert.equal(config.guest?.memory_mb, 2048);
});

/* ───────────────────────── client retries (local server) ───────────────────────── */

interface ServerlessClientArgs {
  server: Server;
  statuses: number[];
  retryAfter?: string;
  headers?: Record<string, string>;
  onRequest?: (n: number) => void;
}

function startServerWith(args: ServerlessClientArgs): Promise<void> {
  let n = 0;
  args.server.on("request", (_req, res) => {
    const status = args.statuses[Math.min(n, args.statuses.length - 1)];
    args.onRequest?.(n);
    n += 1;
    if (args.retryAfter) res.setHeader("retry-after", args.retryAfter);
    if (args.headers) {
      for (const [k, v] of Object.entries(args.headers)) res.setHeader(k, v);
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(status === 200 ? JSON.stringify({ id: "app-1", name: "n" }) : "{}");
  });
  return new Promise((resolve) => args.server.listen(0, resolve));
}

async function clientFor(
  server: Server,
  opts: { maxRetries?: number; retryBaseMs?: number; concurrency?: number; fetchImpl?: typeof fetch } = {},
): Promise<FlyClient> {
  const port = (server.address() as { port: number }).port;
  const { MachinesApiClient } = await import("./fly-client");
  return new MachinesApiClient({
    token: "t",
    orgSlug: "o",
    baseUrl: `http://127.0.0.1:${port}`,
    maxRetries: opts.maxRetries ?? 3,
    retryBaseMs: opts.retryBaseMs ?? 1,
    concurrency: opts.concurrency ?? 8,
    fetchImpl: opts.fetchImpl,
  });
}

test("request retries 5xx with backoff then succeeds", async (t) => {
  const server = createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let n = 0;
  await startServerWith({
    server,
    statuses: [503, 503, 503, 503, 503, 200],
    onRequest: () => { n += 1; },
  });
  const client = await clientFor(server, { maxRetries: 5 });
  const app = await client.getApp("n");
  assert.equal(app.id, "app-1");
  assert.equal(n, 6, "initial request + 5 retries, then success");
});

test("retry-after header takes priority over backoff", async (t) => {
  const server = createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let n = 0;
  await startServerWith({
    server,
    statuses: [429, 200],
    retryAfter: "0",
    onRequest: () => { n += 1; },
  });
  const client = await clientFor(server, { maxRetries: 2, retryBaseMs: 60_000 });
  const before = Date.now();
  await client.getApp("n");
  assert.ok(Date.now() - before < 1000, "honoured Retry-After instead of sleeping 60s");
  assert.equal(n, 2);
});

test("409 and other 4xx are not retried", async (t) => {
  const server = createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let n = 0;
  await startServerWith({ server, statuses: [409], onRequest: () => { n += 1; } });
  const { FlyApiError } = await import("./fly-client");
  const client = await clientFor(server, { maxRetries: 3 });
  await assert.rejects(() => client.getApp("n"), FlyApiError);
  assert.equal(n, 1, "no retry on 409");
});

test("concurrency limiter bounds concurrent requests", async () => {
  const { ConcurrencyLimiter } = await import("./fly-client");
  const limiter = new ConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;
  const worker = async (id: number) =>
    limiter.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return id;
    });
  const results = await Promise.all([worker(1), worker(2), worker(3), worker(4), worker(5)]);
  assert.deepEqual(new Set(results), new Set([1, 2, 3, 4, 5]));
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
});

/* ──────────────────────────── manager + DB tests ──────────────────────────── */

loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
let daemon: FakeDaemon | undefined;
const createdUsers: string[] = [];

try {
  db = getDb({ fresh: true });
  await db.execute(sql`SELECT 1`);
  skipReason = false;
} catch (error) {
  skipReason = `Postgres unavailable: ${(error as Error).message}`;
}

// One shared fake daemon on 127.0.0.1:8080 serves /health, /init, /sync, /exec,
// /fs for every manager test (`ensureRunning` waits on it). Tests reset its
// per-test state (initialized flag, failure knobs, call log) as needed.
if (!skipReason) {
  daemon = new FakeDaemon();
  await daemon.listen();
}

async function newUser(verified = false): Promise<string> {
  const id = randomUUID();
  await db!.insert(user).values({
    id,
    name: "Test User",
    email: `${id}@test.local`,
    emailVerified: verified,
  });
  createdUsers.push(id);
  return id;
}

async function newArchivedWorkspace(userId: string, name: string): Promise<string> {
  const rows = await db!
    .insert(workspaces)
    .values({ userId, name, status: "archived", lastActiveAt: new Date(), lastSyncedAt: new Date() })
    .returning({ id: workspaces.id });
  return rows[0].id;
}

async function ensureFlyApp(fly: FakeFlyClient, workspaceId: string, name: string): Promise<string> {
  const { appName } = await createWorkspaceApp(db!, fly, { workspaceId, name });
  return appName;
}

after(async () => {
  if (daemon) await daemon.close();
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

/* ───────────────────── createWorkspace (Phase 7) ───────────────────── */

test("createWorkspace requires a verified email and an app-owned name", { skip: skipReason }, async () => {
  const unverified = await newUser(false);
  await assert.rejects(
    () => createWorkspace(db!, new FakeFlyClient(), { userId: unverified, name: "Box" }),
    /verified email/,
  );

  const verified = await newUser(true);
  const fly = new FakeFlyClient();
  const result = await createWorkspace(db!, fly, { userId: verified, name: "Box" });

  assert.match(result.appName, /^bwx-box-/);
  const [row] = await db!
    .select()
    .from(workspaces)
    .where(eq(workspaces.userId, verified));
  assert.equal(row.status, "archived", "fresh workspace is archived with no resources");
  assert.equal(row.flyMachineId, null);
  assert.equal(row.flyVolumeId, null);
  assert.ok(row.lastActiveAt && row.lastSyncedAt, "freshly archived workspace has timestamps");

  // A second workspace for the same user is rejected (UNIQUE user_id).
  await assert.rejects(
    () => createWorkspace(db!, fly, { userId: verified, name: "Box Two" }),
    /already has a workspace/,
  );
});

test("createWorkspaceApp writes appName before calling Fly and verifies no public IP", { skip: skipReason }, async () => {
  const userId = await newUser();
  const workspaceId = await newArchivedWorkspace(userId, "Signature Project");
  const fly = new FakeFlyClient();

  const result = await ensureFlyApp(fly, workspaceId, "Signature Project");

  assert.match(result, /^bwx-signature-project-/);
  const [row] = await db!.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.equal(row.flyApp, result, "DB knows the app before it exists on Fly");

  const createIndex = fly.calls.findIndex((c) => c.op === "createApp");
  const ipIndex = fly.calls.findIndex((c) => c.op === "listIpAssignments");
  assert.ok(createIndex >= 0 && ipIndex > createIndex, "ip check runs after create");
});

test("createWorkspaceApp with existing pointers is idempotent", { skip: skipReason }, async () => {
  const userId = await newUser();
  const workspaceId = await newArchivedWorkspace(userId, "name");
  const fly = new FakeFlyClient();

  await ensureFlyApp(fly, workspaceId, "name");
  const callsAfterFirst = fly.calls.length;
  const appName = await ensureFlyApp(fly, workspaceId, "name");
  assert.ok(
    fly.calls.length >= callsAfterFirst + 1,
    "second call re-verifies (getApp) instead of recreating",
  );
  assert.match(appName, /^bwx-name-/);
});

/* ─────────────────────────── ensureRunning (Phase 7) ─────────────────────────── */

test("ensureRunning creates volume before machine and records IDs immediately", { skip: skipReason }, async () => {
  const fly = new FakeFlyClient();
  const storage = new FakeStorage();
  const userId = await newUser(true);
  const workspaceId = await newArchivedWorkspace(userId, "restore-me");
  await ensureFlyApp(fly, workspaceId, "restore-me");

  const result = await ensureRunning(db!, fly, {
    workspaceId,
    image: "img:latest",
    storage,
  });

  assert.equal(result.volumeId.startsWith("vol-"), true);
  assert.equal(result.machineId.startsWith("mach-"), true);
  assert.equal(result.baseUrl, "http://127.0.0.1:8080");
  assert.ok(result.token.length > 0, "returns the active daemon token");

  const volumeIdx = fly.calls.findIndex((c) => c.op === "createVolume");
  const machineIdx = fly.calls.findIndex((c) => c.op === "createMachine");
  assert.ok(volumeIdx >= 0 && machineIdx > volumeIdx, "volume before machine");

  const [row] = await db!.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.ok(row.flyVolumeId && row.flyMachineId);
  assert.equal(row.status, "running");
  assert.ok(row.region, "region persisted after restore");
  assert.ok(row.daemonTokenEncrypted, "per-workspace token persisted after /init");
});

test("ensureRunning mounts the volume at /workspace and is idempotent", { skip: skipReason }, async () => {
  const fly = new FakeFlyClient();
  const storage = new FakeStorage();
  const userId = await newUser(true);
  const workspaceId = await newArchivedWorkspace(userId, "mount");
  const appName = await ensureFlyApp(fly, workspaceId, "mount");

  const first = await ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage });
  const machinesAfterFirst = fly.calls.filter((c) => c.op === "createMachine").length;
  const volumesAfterFirst = fly.calls.filter((c) => c.op === "createVolume").length;

  // Second call while running must NOT boot a second machine/volume.
  const second = await ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage });
  assert.equal(second.machineId, first.machineId);
  assert.equal(second.volumeId, first.volumeId);
  assert.equal(fly.calls.filter((c) => c.op === "createMachine").length, machinesAfterFirst);
  assert.equal(fly.calls.filter((c) => c.op === "createVolume").length, volumesAfterFirst);

  const machine = await fly.getMachine(appName, first.machineId);
  assert.deepEqual(machine.config?.mounts, [{ volume: first.volumeId, path: "/workspace" }]);
});

/* ──────────────────────────── concurrent ensureRunning ──────────────────────────── */

test("two concurrent ensureRunning calls create exactly one machine", { skip: skipReason }, async () => {
  const fly = new FakeFlyClient();
  const storage = new FakeStorage();
  const userId = await newUser(true);
  const workspaceId = await newArchivedWorkspace(userId, "concurrent");
  await ensureFlyApp(fly, workspaceId, "concurrent");

  // Wait long enough for the first to claim "restoring"; the second must wait.
  const [a, b] = await Promise.all([
    ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage }),
    ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage }),
  ]);

  assert.equal(a.machineId, b.machineId);
  const machines = fly.calls.filter((c) => c.op === "createMachine");
  const volumes = fly.calls.filter((c) => c.op === "createVolume");
  assert.equal(machines.length, 1, `expected one createMachine, got ${machines.length}`);
  assert.equal(volumes.length, 1, `expected one createVolume, got ${volumes.length}`);
});

/* ───────────────────────────────── archive ─────────────────────────────── */

test("archive destroys machine then volume and clears pointers (nothing changed)", { skip: skipReason }, async () => {
  const fly = new FakeFlyClient();
  const storage = new FakeStorage();
  const userId = await newUser(true);
  const workspaceId = await newArchivedWorkspace(userId, "archive-me");
  await ensureFlyApp(fly, workspaceId, "archive-me");
  await ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage });

  // Nothing changed (freshly archived workspace → skip the upload), but the
  // backup pointer is set so the volume may be destroyed.
  await db!
    .update(workspaces)
    .set({ backupSha256: "b".repeat(64), lastActiveAt: new Date(0), lastSyncedAt: new Date(0) })
    .where(eq(workspaces.id, workspaceId));

  const result = await archive(db!, fly, { workspaceId, storage });
  assert.equal(result.destroyedMachine, true);
  assert.equal(result.destroyedVolume, true);

  const [row] = await db!.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.equal(row.flyMachineId, null);
  assert.equal(row.flyVolumeId, null);
  assert.equal(row.status, "archived");

  // Machine went away before the volume (volume cannot be destroyed while attached).
  const machineDestroy = fly.calls.findIndex((c) => c.op === "destroyMachine");
  const volumeDestroy = fly.calls.findIndex((c) => c.op === "destroyVolume");
  assert.ok(volumeDestroy > machineDestroy, "machine destroyed before volume");
});

test("archive with changed files syncs via the daemon, verifies, rotates", { skip: skipReason }, async () => {
  daemon!.reset();
  const fly = new FakeFlyClient();
  const storage = new FakeStorage();
  storage.size = daemon!.syncSize; // head() must match what /sync reports
  const userId = await newUser(true);
  const workspaceId = await newArchivedWorkspace(userId, "arc-sync");
  await ensureFlyApp(fly, workspaceId, "arc-sync");
  await ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage });

  // Real activity: lastActiveAt newer than lastSyncedAt → a real sync is due.
  await db!.update(workspaces).set({ lastActiveAt: new Date(Date.now() + 60_000) })
    .where(eq(workspaces.id, workspaceId));

  await archive(db!, fly, { workspaceId, storage });

  assert.equal(daemon!.callsFor("sync").length, 1, "daemon /sync called once");
  assert.equal(daemon!.callsFor("init").length, 1, "/init happened on restore only");

  const key = workspaceBackupKey(workspaceId);
  const putOps = storage.calls.filter((c) => c.op === "presignPut");
  assert.ok(
    putOps.some((c) => c.args[0] === `${key}.tmp`),
    "upload URL targets the .tmp key before verification",
  );
  assert.ok(storage.calls.some((c) => c.op === "rotate"), "last backup rotated to .prev");
  assert.ok(storage.calls.some((c) => c.op === "copy"), "verified .tmp promoted to key");
  assert.ok(storage.calls.some((c) => c.op === "delete"), ".tmp removed after rotate+copy");

  const [row] = await db!.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.equal(row.status, "archived");
  assert.equal(row.backupSha256, "a".repeat(64), "verified sha256 persisted");
  assert.equal(row.backupBytes, storage.size, "verified size persisted");
  assert.ok(row.lastSyncedAt, "lastSyncedAt updated after sync");
});

test("archive with failed sync deletes nothing and marks archive_failed", { skip: skipReason }, async () => {
  daemon!.reset();
  daemon!.failSync = true;
  const fly = new FakeFlyClient();
  const storage = new FakeStorage();
  const userId = await newUser(true);
  const workspaceId = await newArchivedWorkspace(userId, "arc-fail");
  await ensureFlyApp(fly, workspaceId, "arc-fail");
  await ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage });
  await db!.update(workspaces).set({ lastActiveAt: new Date(Date.now() + 60_000) })
    .where(eq(workspaces.id, workspaceId));

  await assert.rejects(() => archive(db!, fly, { workspaceId, storage }), /sync/);

  const [row] = await db!.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.equal(row.status, "archive_failed");
  assert.ok(row.flyMachineId, "machine NOT destroyed on failed sync");
  assert.ok(row.flyVolumeId, "volume NOT deleted on failed sync");
  assert.equal(fly.calls.filter((c) => c.op === "destroyMachine").length, 0);
  assert.equal(fly.calls.filter((c) => c.op === "destroyVolume").length, 0);
  // The backup object was never touched: no rotate/copy/delete.
  assert.equal(storage.calls.filter((c) => c.op === "rotate").length, 0);
  assert.equal(storage.calls.filter((c) => c.op === "copy").length, 0);
  assert.equal(storage.calls.filter((c) => c.op === "delete").length, 0);
});

test("reconcile clears stale machine and volume pointers", { skip: skipReason }, async () => {
  const fly = new FakeFlyClient();
  const storage = new FakeStorage();
  const userId = await newUser(true);
  const workspaceId = await newArchivedWorkspace(userId, "recon");
  await ensureFlyApp(fly, workspaceId, "recon");
  await ensureRunning(db!, fly, { workspaceId, image: "img:latest", storage });

  const result = await reconcile(db!, fly, workspaceId);
  assert.equal(result.staleMachine, false);
  assert.equal(result.staleVolume, false);
  assert.ok(result.appName);
});