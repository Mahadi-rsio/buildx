import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "@buildx/db";
import type { Db } from "@buildx/db";
import { usageSessions, user, workspaces } from "@buildx/db";
import { hasCpuBudget, openUsageSession } from "@buildx/db";
import type { WorkspaceStatus } from "@buildx/db";
import type { Storage } from "@buildx/storage";
import { daemonInit, daemonSync, waitForDaemonHealth } from "./daemon-client";
import { DaemonSandbox } from "./daemon";
import type { FlyClient, FlyMachine, FlyVolume, MachineConfig } from "./fly-client";
import { FlyApiError } from "./fly-client";

/**
 * Orchestration for workspace lifecycle on Fly Machines (phase.md §6–§7,
 * arcetecture.md §2.4). The hard invariant: **the DB is written before a Fly
 * resource is created and immediately after it is updated** — a crash at any
 * point never leaves a live resource the DB cannot see. Every function is
 * idempotent enough to be re-run after a partial failure.
 */

/** Sanitised app name: lowercase alnum + dashes, unique per workspace, ≤ 30 chars. */
export function workspaceAppName(
  name: string,
  workspaceId: string,
): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const ws = workspaceId.replace(/[^a-z0-9]+/g, "").slice(0, 8);
  const core = (base || "ws") + "-" + ws;
  return `bwx-${core}`.slice(0, 30).replace(/-+$/g, "");
}

export interface WorkspaceMachineConfigInput {
  image: string;
  volumeId: string;
  env?: Record<string, string>;
  /** Optional override, e.g. per-task memory upgrades. */
  memoryMb?: number;
  /** Optional override, e.g. per-task CPU upgrades. */
  cpus?: number;
}

/** The canonical machine shape for a workspace (phase.md §6). */
export function workspaceMachineConfig(
  input: WorkspaceMachineConfigInput,
): MachineConfig {
  return {
    image: input.image,
    guest: {
      cpu_kind: "shared",
      cpus: input.cpus ?? 1,
      memory_mb: input.memoryMb ?? 1024,
    },
    init: { swap_size_mb: 1024 },
    env: input.env,
    mounts: [{ volume: input.volumeId, path: "/workspace" }],
    services: [],
    restart: { policy: "no" },
  };
}

/** Slice of a workspace row the manager needs; keeps callers decoupled. */
export interface WorkspaceRef {
  id: string;
  userId: string;
  status: string;
  flyApp: string | null;
  flyVolumeId: string | null;
  flyMachineId: string | null;
  region: string | null;
  daemonTokenEncrypted: string | null;
  lastActiveAt: Date | null;
  lastSyncedAt: Date | null;
  backupBytes: number | null;
  backupSha256: string | null;
  imageDigest: string | null;
  lockfileHash: string | null;
}

async function getWorkspace(db: Db, id: string): Promise<WorkspaceRef> {
  const rows = await db
    .select({
      id: workspaces.id,
      userId: workspaces.userId,
      status: workspaces.status,
      flyApp: workspaces.flyApp,
      flyVolumeId: workspaces.flyVolumeId,
      flyMachineId: workspaces.flyMachineId,
      region: workspaces.region,
      daemonTokenEncrypted: workspaces.daemonTokenEncrypted,
      lastActiveAt: workspaces.lastActiveAt,
      lastSyncedAt: workspaces.lastSyncedAt,
      backupBytes: workspaces.backupBytes,
      backupSha256: workspaces.backupSha256,
      imageDigest: workspaces.imageDigest,
      lockfileHash: workspaces.lockfileHash,
    })
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!rows[0]) throw new Error(`workspace ${id} not found`);
  return rows[0];
}

export interface CreateWorkspaceInput {
  userId: string;
  name: string;
}

export interface CreateWorkspaceResult {
  workspaceId: string;
  appName: string;
}

const DEFAULT_REGION = "sin";
const FALLBACK_REGION = "iad";

/** Volume name: stable per workspace, matches Fly's allowed charset. */
export function workspaceVolumeName(workspaceId: string): string {
  return `ws-${workspaceId.replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
}

/** S3 key layout for a workspace backup + rotate partner (keep last 2). */
export function workspaceBackupKey(workspaceId: string): string {
  return `workspaces/${workspaceId}/backup.tar.zst`;
}

/** The daemon inside `machine` lives at its private IP + daemon port. */
export function daemonBaseUrlFor(machine: {
  private_ip?: string | null;
  id?: string;
}, port = 8080): string {
  if (!machine.private_ip) {
    throw new Error(`machine ${machine.id ?? "?"} has no private_ip`);
  }
  return `http://${machine.private_ip}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCapacityFailure(error: unknown): boolean {
  if (!(error instanceof FlyApiError)) return false;
  if (error.status >= 500) return true;
  return /capacity|insufficient|unavailable|no space|region/i.test(error.message);
}

/** Wait before re-reading a workspace row that another caller is mutating. */
const STATUS_POLL_MS = 500;
/** How long an ensureRunning call will wait for a concurrent restore/archive. */
const WAIT_STATUS_TIMEOUT_MS = 10 * 60 * 1000;

/** Atomic multi-source claim: works when status is one of `from`. */
async function claimStatus(
  db: Db,
  workspaceId: string,
  from: WorkspaceStatus[],
  to: WorkspaceStatus,
): Promise<boolean> {
  const rows = await db
    .update(workspaces)
    .set({ status: to, updatedAt: sql`now()` })
    .where(and(eq(workspaces.id, workspaceId), inArray(workspaces.status, from)))
    .returning({ id: workspaces.id });
  return rows.length === 1;
}

/** Poll until the workspace is in one of `statuses` or the deadline passes. */
async function waitForStatus(
  db: Db,
  workspaceId: string,
  statuses: WorkspaceStatus[],
  timeoutMs: number,
): Promise<WorkspaceRef> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const workspace = await getWorkspace(db, workspaceId);
    if (statuses.includes(workspace.status as WorkspaceStatus)) return workspace;
    if (Date.now() >= deadline) {
      throw new Error(
        `workspace ${workspaceId} still ${workspace.status} after ${timeoutMs}ms`,
      );
    }
    await sleep(STATUS_POLL_MS);
  }
}

/** Close every open usage session for a workspace (machine teardown). */
async function closeOpenUsageSessions(db: Db, workspaceId: string): Promise<void> {
  await db
    .update(usageSessions)
    .set({ endedAt: sql`now()` })
    .where(
      and(
        eq(usageSessions.workspaceId, workspaceId),
        isNull(usageSessions.endedAt),
      ),
    );
}

/** Open a usage session unless one is still open (restore must not double-bill). */
async function openSessionIfNone(
  db: Db,
  input: { userId: string; workspaceId: string; machineId: string },
): Promise<void> {
  const open = await db
    .select({ id: usageSessions.id })
    .from(usageSessions)
    .where(
      and(
        eq(usageSessions.workspaceId, input.workspaceId),
        isNull(usageSessions.endedAt),
      ),
    );
  if (open.length > 0) return;
  await openUsageSession(db, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    machineId: input.machineId,
  });
}

function generateToken(): string {
  return `tok_${randomBytes(32).toString("hex")}`;
}

/** Mark the backup step failed and short-circuit out of archive. */
async function markArchiveFailed(db: Db, workspaceId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ status: "archive_failed", updatedAt: sql`now()` })
    .where(eq(workspaces.id, workspaceId));
}

const INSTALL_BY_LOCKFILE: Array<{ lockfile: string; cmd: string; timeoutMs: number }> = [
  { lockfile: "pnpm-lock.yaml", cmd: "pnpm install", timeoutMs: 10 * 60 * 1000 },
  { lockfile: "package-lock.json", cmd: "npm install", timeoutMs: 20 * 60 * 1000 },
  { lockfile: "yarn.lock", cmd: "yarn install --immutable", timeoutMs: 20 * 60 * 1000 },
  { lockfile: "bun.lockb", cmd: "bun install", timeoutMs: 20 * 60 * 1000 },
];

function lockfileHash(lockfile: string, content: string): string {
  return createHash("sha256")
    .update(lockfile)
    .update("\0")
    .update(content)
    .digest("hex");
}

/**
 * After `/init`, install dependencies only when the lockfile has never been
 * installed here or its content hash changed since the last install.
 */
async function installDepsIfChanged(
  db: Db,
  workspaceId: string,
  daemon: DaemonSandbox,
  currentHash: string | null,
): Promise<void> {
  let chosen: (typeof INSTALL_BY_LOCKFILE)[number] | undefined;
  let content = "";
  for (const candidate of INSTALL_BY_LOCKFILE) {
    try {
      const result = await daemon.readInfo(candidate.lockfile);
      if (result.type === "file") {
        chosen = candidate;
        content = result.content;
        break;
      }
    } catch {
      // No such lockfile on this workspace; try the next package manager.
    }
  }
  if (!chosen) return;

  const hash = lockfileHash(chosen.lockfile, content);
  if (hash === currentHash) return;

  for await (const _chunk of daemon.exec(chosen.cmd, { timeoutMs: chosen.timeoutMs })) {
    // Drain the stream so the command runs to completion.
  }

  await db
    .update(workspaces)
    .set({ lockfileHash: hash, updatedAt: sql`now()` })
    .where(eq(workspaces.id, workspaceId));
}

/**
 * Create a workspace: verified email + no existing workspace (UNIQUE user_id),
 * then a `creating` row BEFORE the Fly app is made (phase.md §145–147). Ends
 * `archived` with an empty/inital backup; a fresh workspace is "nothing to
 * sync" and has no machine/volume yet.
 */
export async function createWorkspace(
  db: Db,
  fly: FlyClient,
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  const [existing] = await db
    .select({
      id: user.id,
      emailVerified: user.emailVerified,
    })
    .from(user)
    .where(eq(user.id, input.userId));

  if (!existing) throw new Error(`user ${input.userId} not found`);
  if (!existing.emailVerified) {
    throw new Error("workspace creation requires a verified email");
  }

  const [owned] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.userId, input.userId));
  if (owned) throw new Error("user already has a workspace");

  const inserted = await db
    .insert(workspaces)
    .values({ userId: input.userId, name: input.name, status: "creating" })
    .returning({ id: workspaces.id });
  const workspaceId = inserted[0].id;

  try {
    const { appName } = await createWorkspaceApp(db, fly, { workspaceId, name: input.name });
    await db
      .update(workspaces)
      .set({
        status: "archived",
        lastActiveAt: sql`now()`,
        lastSyncedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(workspaces.id, workspaceId));
    return { workspaceId, appName };
  } catch (error) {
    await db
      .update(workspaces)
      .set({ status: "error", updatedAt: sql`now()` })
      .where(eq(workspaces.id, workspaceId));
    throw error;
  }
}

export interface CreateWorkspaceAppInput {
  workspaceId: string;
  /** Human name used for the slug (stable across restarts). */
  name: string;
  sizeGb?: number;
}

export interface CreateWorkspaceAppResult {
  appName: string;
  appId: string;
}

/**
 * Provision the dedicated Fly app for a workspace: private network scoped to
 * the app, no public IP (the orchestrator talks to the machine over WireGuard
 * / the daemon). DB is written before createApp; a crash can only leave a
 * "creating" row, never an untracked app.
 */
export async function createWorkspaceApp(
  db: Db,
  fly: FlyClient,
  input: CreateWorkspaceAppInput,
): Promise<CreateWorkspaceAppResult> {
  const workspace = await getWorkspace(db, input.workspaceId);
  if (workspace.flyApp) {
    // Already provisioned (retry after crash). Verify it is still there.
    const app = await fly.getApp(workspace.flyApp);
    return { appName: app.name, appId: app.id };
  }

  const appName = workspaceAppName(input.name, input.workspaceId);
  // DB write FIRST: the row always knows what the app should be.
  await db
    .update(workspaces)
    .set({ flyApp: appName, updatedAt: sql`now()` })
    .where(eq(workspaces.id, input.workspaceId));

  const app = await fly.createApp({ name: appName, network: appName });
  const publicIps = await fly.listIpAssignments(appName);
  // TODO(verify): IP-assignment envelope shape; assertion below is best-effort.
  const ips = publicIps.ips ?? [];
  if (ips.length > 0) {
    throw new Error(
      `workspace app ${appName} unexpectedly has public IPs: ` +
        ips.map((ip) => ip.ip).join(", "),
    );
  }

  return { appName, appId: app.id };
}

export interface EnsureRunningInput {
  workspaceId: string;
  /** Daemon image to boot the workspace machine from. */
  image: string;
  /** Storage backing the presigned restore URL handed to /init. */
  storage: Storage;
}

export interface EnsureRunningResult {
  machineId: string;
  volumeId: string;
  region: string;
  /** Daemon base URL + active token for the sandbox (phase 8 lazy sandbox). */
  baseUrl: string;
  token: string;
}

/**
 * The restore half of the lifecycle (phase.md §148–152): volume (1 GB, `sin`
 * with an `iad` fallback on capacity failure) → machine WITH the volume mount
 * → wait started → poll daemon `/health` → `/init` with a presigned restore
 * URL + a fresh per-workspace token → install deps only if the lockfile hash
 * changed → open a usage session → `running`.
 *
 * Every pointer is written to the DB immediately after its resource is created,
 * so a crash anywhere here is recoverable by re-running `ensureRunning` after
 * the status has been reverted to `archived`.
 */
async function doRestore(
  db: Db,
  fly: FlyClient,
  input: EnsureRunningInput,
): Promise<EnsureRunningResult> {
  try {
    return await doRestoreInner(db, fly, input);
  } catch (error) {
    // Revert so the next ensureRunning re-claims and recovers idempotently via
    // the already-persisted flyVolumeId / flyMachineId / daemonToken pointers.
    await db
      .update(workspaces)
      .set({ status: "archived", updatedAt: sql`now()` })
      .where(eq(workspaces.id, input.workspaceId));
    throw error;
  }
}

async function doRestoreInner(
  db: Db,
  fly: FlyClient,
  input: EnsureRunningInput,
): Promise<EnsureRunningResult> {
  const workspace = await getWorkspace(db, input.workspaceId);
  if (!workspace.flyApp) {
    throw new Error(`workspace ${input.workspaceId} has no flyApp yet`);
  }
  if (!(await hasCpuBudget(db, workspace.userId))) {
    throw new Error("monthly CPU budget exhausted");
  }

  // 1. Volume (1 GB, region fallback on capacity failure) — record immediately.
  let volumeId = workspace.flyVolumeId;
  if (!volumeId) {
    const regions = [workspace.region ?? DEFAULT_REGION, FALLBACK_REGION];
    let volume: FlyVolume | undefined;
    for (let i = 0; i < regions.length; i += 1) {
      try {
        volume = await fly.createVolume(workspace.flyApp, {
          name: workspaceVolumeName(workspace.id),
          region: regions[i],
          sizeGb: 1,
        });
        break;
      } catch (error) {
        if (i === regions.length - 1 || !isCapacityFailure(error)) throw error;
      }
    }
    volumeId = volume!.id;
    await db
      .update(workspaces)
      .set({ flyVolumeId: volumeId, updatedAt: sql`now()` })
      .where(eq(workspaces.id, input.workspaceId));
  }

  // 2. Machine WITH the volume mount + bootstrap SANDBOX_TOKEN — record immediately.
  const region = workspace.region ?? DEFAULT_REGION;
  let bootstrapToken = workspace.daemonTokenEncrypted;
  let machineId = workspace.flyMachineId;
  if (!machineId) {
    bootstrapToken = generateToken();
    // Persist the bootstrap BEFORE createMachine so a crash keeps it recoverable.
    await db
      .update(workspaces)
      .set({ daemonTokenEncrypted: bootstrapToken, updatedAt: sql`now()` })
      .where(eq(workspaces.id, input.workspaceId));
    const machine = await fly.createMachine(workspace.flyApp, {
      region,
      config: workspaceMachineConfig({
        image: input.image,
        volumeId,
        env: { SANDBOX_TOKEN: bootstrapToken },
      }),
    });
    machineId = machine.id;
    await db
      .update(workspaces)
      .set({ flyMachineId: machineId, region, updatedAt: sql`now()` })
      .where(eq(workspaces.id, input.workspaceId));
    const waitResult = await fly.waitForState(workspace.flyApp, machineId, {
      state: "started",
      timeout: 60,
    });
    if (waitResult.ok === false) {
      throw new Error(
        `machine ${machineId} did not start (state=${waitResult.state ?? "unknown"})`,
      );
    }
  }

  // 3. Wait for the daemon, then /init (or reuse an already-rotated token).
  const machineInfo = await fly.getMachine(workspace.flyApp, machineId);
  const baseUrl = daemonBaseUrlFor(machineInfo);
  // Only restore from a backup that actually exists; a fresh workspace skips it.
  const current = await getWorkspace(db, input.workspaceId);
  const health = await waitForDaemonHealth(baseUrl, 30_000);

  let token = current.daemonTokenEncrypted;
  if (health.initialized && token) {
    // /init already ran; reuse the rotated per-workspace token.
  } else if (health.initialized) {
    throw new Error(
      "sandbox daemon initialized but no token persisted; " +
        "the reconciler must destroy this stuck machine",
    );
  } else {
    if (!bootstrapToken) {
      throw new Error(
        `workspace ${input.workspaceId} has no bootstrap token for /init`,
      );
    }
    token = generateToken();
    const restoreUrl =
      current.backupSha256 != null
        ? await input.storage.presignGet(workspaceBackupKey(input.workspaceId))
        : "";
    await daemonInit({ baseUrl, bootstrapToken, token, restoreUrl });
    await db
      .update(workspaces)
      .set({ daemonTokenEncrypted: token, updatedAt: sql`now()` })
      .where(eq(workspaces.id, input.workspaceId));
  }

  // 4. Deps (only if the lockfile hash changed), then open a usage session.
  const daemon = new DaemonSandbox({ baseUrl, token });
  await installDepsIfChanged(db, input.workspaceId, daemon, current.lockfileHash);
  await openSessionIfNone(db, {
    userId: current.userId,
    workspaceId: input.workspaceId,
    machineId,
  });

  await db
    .update(workspaces)
    .set({ status: "running", lastActiveAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(workspaces.id, input.workspaceId));

  return {
    machineId,
    volumeId,
    region: machineInfo.region ?? region,
    baseUrl,
    token,
  };
}

/**
 * Idempotent guarantee that a workspace is running; called before every
 * sandbox-touching tool call (phase.md §148). `running` → touch
 * `last_active_at`. `archived`/`archive_failed` → claim `restoring` and restore.
 * `restoring`/`archiving` by another caller → wait, then re-evaluate.
 */
export async function ensureRunning(
  db: Db,
  fly: FlyClient,
  input: EnsureRunningInput,
): Promise<EnsureRunningResult> {
  for (;;) {
    const workspace = await getWorkspace(db, input.workspaceId);

    if (workspace.status === "running") {
      await db
        .update(workspaces)
        .set({ lastActiveAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(workspaces.id, input.workspaceId));
      if (!workspace.flyMachineId || !workspace.flyVolumeId) {
        throw new Error(
          `workspace ${input.workspaceId} is running without machine/volume pointers`,
        );
      }
      if (!workspace.daemonTokenEncrypted) {
        throw new Error(
          `workspace ${input.workspaceId} has no daemon token; reconciler must recover it`,
        );
      }
      const machine = await fly.getMachine(workspace.flyApp!, workspace.flyMachineId);
      return {
        machineId: workspace.flyMachineId,
        volumeId: workspace.flyVolumeId,
        region: workspace.region ?? machine.region ?? DEFAULT_REGION,
        baseUrl: daemonBaseUrlFor(machine),
        token: workspace.daemonTokenEncrypted,
      };
    }

    if (workspace.status === "archived" || workspace.status === "archive_failed") {
      if (
        !(await claimStatus(db, input.workspaceId, ["archived", "archive_failed"], "restoring"))
      ) {
        continue; // another caller claimed; re-read the new status
      }
      return doRestore(db, fly, input);
    }

    if (workspace.status === "restoring" || workspace.status === "archiving") {
      await waitForStatus(
        db,
        input.workspaceId,
        ["running", "archived"],
        WAIT_STATUS_TIMEOUT_MS,
      );
      continue;
    }

    throw new Error(
      `workspace ${input.workspaceId} cannot be ensured running from ${workspace.status}`,
    );
  }
}

export interface ArchiveInput {
  workspaceId: string;
  /** Storage backing the backup object; the daemon uploads a fresh .tmp copy. */
  storage: Storage;
  /** Daemon base URL; derived from the machine pointers if omitted. */
  daemonBaseUrl?: string;
  /** Active daemon token; read from the workspace row if omitted. */
  daemonToken?: string;
}

export interface ArchiveResult {
  destroyedMachine: boolean;
  destroyedVolume: boolean;
}

/**
 * Tear down a workspace with a strict order (phase.md §155–163): daemon `/sync`
 * → verify size → rotate/copy/delete → destroy machine → destroy volume → close
 * usage sessions → `archived`. Any sync/verify/rotate failure deletes NOTHING,
 * marks `archive_failed`, and rethrows so no backup-less destruction happens.
 * When nothing changed (`lastActiveAt <= lastSyncedAt`) the upload is skipped:
 * the machine is still destroyed for cost, but the volume is only destroyed
 * when a verified backup (`backupSha256`) exists.
 */
export async function archive(
  db: Db,
  fly: FlyClient,
  input: ArchiveInput,
): Promise<ArchiveResult> {
  const workspace = await getWorkspace(db, input.workspaceId);
  if (workspace.status === "archived") {
    return { destroyedMachine: false, destroyedVolume: false };
  }

  if (workspace.status !== "archiving") {
    const claimed = await claimStatus(
      db,
      input.workspaceId,
      ["running", "archive_failed"],
      "archiving",
    );
    if (!claimed) {
      const current = await getWorkspace(db, input.workspaceId);
      if (current.status === "archived") {
        return { destroyedMachine: false, destroyedVolume: false };
      }
      if (current.status !== "archiving") {
        throw new Error(
          `workspace ${input.workspaceId} cannot archive from ${current.status}`,
        );
      }
      // Tolerate another caller already archiving; proceed idempotently.
    }
  }

  const refreshed = await getWorkspace(db, input.workspaceId);
  const lastActive = refreshed.lastActiveAt?.getTime() ?? 0;
  const lastSynced = refreshed.lastSyncedAt?.getTime() ?? 0;
  const needsSync = lastActive > lastSynced;

  if (needsSync) {
    // (a) daemon /sync via presigned PUT to `<key>.tmp`.
    let baseUrl = input.daemonBaseUrl;
    let token = input.daemonToken;
    if (!baseUrl || !token) {
      if (!refreshed.flyApp || !refreshed.flyMachineId || !refreshed.daemonTokenEncrypted) {
        await markArchiveFailed(db, input.workspaceId);
        throw new Error(
          `cannot sync workspace ${input.workspaceId}: daemon address/token unavailable`,
        );
      }
      const machine = await fly.getMachine(refreshed.flyApp, refreshed.flyMachineId);
      baseUrl ??= daemonBaseUrlFor(machine);
      token ??= refreshed.daemonTokenEncrypted;
    }
    const key = workspaceBackupKey(input.workspaceId);
    try {
      const uploadUrl = await input.storage.presignPut(`${key}.tmp`);
      const sync = await daemonSync({ baseUrl, token, uploadUrl });

      // (b) VERIFY before touching anything existing: object size must match.
      const head = await input.storage.head(`${key}.tmp`);
      if (head == null || head.size == null || head.size !== sync.size) {
        throw new Error(
          `backup size mismatch: daemon reported ${sync.size}, storage has ${head?.size ?? "unknown"}`,
        );
      }

      // (c) rotate key → key.prev (keep the last 2), promote the new copy.
      await input.storage.rotate(key);
      await input.storage.copy(`${key}.tmp`, key);
      await input.storage.delete(`${key}.tmp`);

      await db
        .update(workspaces)
        .set({
          backupBytes: head.size,
          backupSha256: sync.sha256,
          lastSyncedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(workspaces.id, input.workspaceId));
    } catch (error) {
      await markArchiveFailed(db, input.workspaceId);
      throw error;
    }
  }

  const verified = (await getWorkspace(db, input.workspaceId)).backupSha256 != null;

  // (d) destroy machine (cost), then volume — the volume only when the backup
  // was verified, so a backup-less workspace keeps its data.
  let destroyedMachine = false;
  if (refreshed.flyMachineId && refreshed.flyApp) {
    await fly.destroyMachine(refreshed.flyApp, refreshed.flyMachineId, {
      force: true,
    });
    destroyedMachine = true;
  }

  let destroyedVolume = false;
  if (refreshed.flyVolumeId && refreshed.flyApp && verified) {
    await fly.destroyVolume(refreshed.flyApp, refreshed.flyVolumeId);
    destroyedVolume = true;
  }

  // (e) close usage sessions and clear pointers → archived.
  await closeOpenUsageSessions(db, input.workspaceId);
  await db
    .update(workspaces)
    .set({
      status: "archived",
      flyMachineId: destroyedMachine ? null : refreshed.flyMachineId,
      flyVolumeId: destroyedVolume ? null : refreshed.flyVolumeId,
      updatedAt: sql`now()`,
    })
    .where(eq(workspaces.id, input.workspaceId));

  return { destroyedMachine, destroyedVolume };
}

export interface ReconcileResult {
  appName: string | null;
  staleMachine: boolean;
  staleVolume: boolean;
}

/**
 * Diff the workspace's Fly resources against its DB pointers and clear the
 * stale ones. Run by the phase-9 reconciler loop so an abandoned / half-created
 * workspace converges to a cleanly archived state without expensive user
 * intervention.
 */
export async function reconcile(
  db: Db,
  fly: FlyClient,
  workspaceId: string,
): Promise<ReconcileResult> {
  const workspace = await getWorkspace(db, workspaceId);
  if (!workspace.flyApp) return { appName: null, staleMachine: false, staleVolume: false };

  const [machines, volumes] = await Promise.all([
    fly.listMachines(workspace.flyApp),
    fly.listVolumes(workspace.flyApp),
  ]);

  const machineIds = new Set(machines.map((m: FlyMachine) => m.id));
  const volumeIds = new Set(volumes.map((v: FlyVolume) => v.id));

  let staleMachine = false;
  if (workspace.flyMachineId && !machineIds.has(workspace.flyMachineId)) {
    staleMachine = true;
    await db
      .update(workspaces)
      .set({ flyMachineId: null, updatedAt: sql`now()` })
      .where(eq(workspaces.id, workspaceId));
  }

  let staleVolume = false;
  if (workspace.flyVolumeId && !volumeIds.has(workspace.flyVolumeId)) {
    staleVolume = true;
    await db
      .update(workspaces)
      .set({ flyVolumeId: null, updatedAt: sql`now()` })
      .where(eq(workspaces.id, workspaceId));
  }

  return {
    appName: workspace.flyApp,
    staleMachine,
    staleVolume,
  };
}