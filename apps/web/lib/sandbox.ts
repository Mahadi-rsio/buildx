import {
  archive,
  createWorkspace,
  ensureRunning,
  LazySandbox,
  LocalSandbox,
  MachinesApiClient,
  type Sandbox,
} from "@buildx/sandbox";
import {
  DAILY_REQUEST_LIMIT,
  FREE_IDLE_MINUTES,
  MONTHLY_CPU_HOURS,
  monthlyCpuSecondsUsed,
  getDb,
  eq,
  workspaces,
} from "@buildx/db";
import { createStorage } from "@buildx/storage";
import type { WorkspaceEventStatus } from "@buildx/shared";

export interface SandboxSettings {
  kind: "local" | "remote";
  flyApiToken?: string;
  flyOrgSlug?: string;
  image?: string;
}

export interface SandboxRunContext {
  workspaceDir: string;
  userId: string;
  workspaceName: string;
}

export interface WorkspaceUsageSnapshot {
  cpuHoursUsed: number;
  cpuHoursLimit: number;
  dailyRequestsUsed: number;
  dailyRequestsLimit: number;
  nextDhakaResetAt: number;
}

export interface WorkspaceEventInput {
  status: WorkspaceEventStatus;
  step?: string;
  message?: string;
  idleDeadlineAt?: number;
  usage?: WorkspaceUsageSnapshot;
  workspaceId?: string;
}

export interface RemoteWorkspaceConnection {
  workspaceId: string;
  baseUrl: string;
  token: string;
}

type WorkspaceEventSink = (event: WorkspaceEventInput) => void | Promise<void>;

const globalSandboxState = globalThis as unknown as {
  __BUILDX_REMOTE_CONNECTIONS__?: Map<string, Promise<RemoteWorkspaceConnection>>;
};

function connectionCache(): Map<string, Promise<RemoteWorkspaceConnection>> {
  if (!globalSandboxState.__BUILDX_REMOTE_CONNECTIONS__) {
    globalSandboxState.__BUILDX_REMOTE_CONNECTIONS__ = new Map();
  }
  return globalSandboxState.__BUILDX_REMOTE_CONNECTIONS__;
}

/**
 * Resolve how runs execute. Local mode shells out on this machine (dev/tests).
 * Remote mode uses Fly Machines via `ensureRunning` and per-workspace daemon
 * tokens; no global SANDBOX_BASE_URL/TOKEN pair is used anymore.
 */
export function sandboxSettings(): SandboxSettings {
  const flyApiToken = (process.env.FLY_API_TOKEN ?? "").trim();
  const flyOrgSlug = (process.env.FLY_ORG_SLUG ?? "").trim();
  const image = (
    process.env.FLY_SANDBOX_IMAGE ??
    process.env.SANDBOX_IMAGE ??
    ""
  ).trim();

  if (flyApiToken && flyOrgSlug && image) {
    return { kind: "remote", flyApiToken, flyOrgSlug, image };
  }
  return { kind: "local" };
}

function emit(event: WorkspaceEventSink | undefined, input: WorkspaceEventInput) {
  if (!event) return Promise.resolve();
  return Promise.resolve(event(input)).then(() => undefined);
}

async function ensureWorkspaceRow(
  ctx: SandboxRunContext,
): Promise<string> {
  const db = getDb();
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.userId, ctx.userId))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const settings = sandboxSettings();
  if (settings.kind !== "remote") {
    throw new Error("remote workspace requested while sandbox is in local mode");
  }

  const fly = new MachinesApiClient({
    token: settings.flyApiToken!,
    orgSlug: settings.flyOrgSlug!,
  });

  try {
    const created = await createWorkspace(db, fly, {
      userId: ctx.userId,
      name: ctx.workspaceName,
    });
    return created.workspaceId;
  } catch {
    const race = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.userId, ctx.userId))
      .limit(1);
    if (race[0]) return race[0].id;
    throw new Error("failed to provision workspace");
  }
}

async function usageSnapshot(
  userId: string,
  dailyRequestsUsed: number,
): Promise<WorkspaceUsageSnapshot> {
  const usedCpuSeconds = await monthlyCpuSecondsUsed(getDb(), userId);
  return {
    cpuHoursUsed: Number((usedCpuSeconds / 3600).toFixed(2)),
    cpuHoursLimit: MONTHLY_CPU_HOURS,
    dailyRequestsUsed,
    dailyRequestsLimit: DAILY_REQUEST_LIMIT,
    nextDhakaResetAt: Number.NaN,
  };
}

export async function resolveWorkspaceDaemon(
  ctx: SandboxRunContext,
  options: {
    onWorkspaceEvent?: WorkspaceEventSink;
    dailyRequestsUsed?: number;
    nextDhakaResetAt?: number;
  } = {},
): Promise<RemoteWorkspaceConnection> {
  const settings = sandboxSettings();
  if (settings.kind !== "remote") {
    throw new Error("remote daemon requested while sandbox is in local mode");
  }

  const cacheKey = `${ctx.userId}`;
  const cache = connectionCache();
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    await emit(options.onWorkspaceEvent, {
      status: "workspace.restoring",
      step: "Preparing workspace",
    });
    const workspaceId = await ensureWorkspaceRow(ctx);
    await emit(options.onWorkspaceEvent, {
      status: "workspace.restoring",
      step: "Starting sandbox machine",
      workspaceId,
    });

    const fly = new MachinesApiClient({
      token: settings.flyApiToken!,
      orgSlug: settings.flyOrgSlug!,
    });
    const restored = await ensureRunning(getDb(), fly, {
      workspaceId,
      image: settings.image!,
      storage: createStorage(),
    });

    const usage = await usageSnapshot(
      ctx.userId,
      options.dailyRequestsUsed ?? 0,
    );
    await emit(options.onWorkspaceEvent, {
      status: "workspace.ready",
      workspaceId,
      idleDeadlineAt: Date.now() + FREE_IDLE_MINUTES * 60_000,
      usage: {
        ...usage,
        nextDhakaResetAt: options.nextDhakaResetAt ?? Number.NaN,
      },
    });

    return {
      workspaceId,
      baseUrl: restored.baseUrl,
      token: restored.token,
    };
  })();

  cache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
}

async function archiveWorkspace(
  ctx: SandboxRunContext,
  connection: RemoteWorkspaceConnection,
  onWorkspaceEvent?: WorkspaceEventSink,
): Promise<void> {
  const settings = sandboxSettings();
  if (settings.kind !== "remote") return;

  await emit(onWorkspaceEvent, {
    status: "workspace.archiving",
    workspaceId: connection.workspaceId,
    step: "Saving workspace",
  });

  const fly = new MachinesApiClient({
    token: settings.flyApiToken!,
    orgSlug: settings.flyOrgSlug!,
  });

  await archive(getDb(), fly, {
    workspaceId: connection.workspaceId,
    storage: createStorage(),
    daemonBaseUrl: connection.baseUrl,
    daemonToken: connection.token,
  });

  connectionCache().delete(ctx.userId);
  await emit(onWorkspaceEvent, {
    status: "workspace.archived",
    workspaceId: connection.workspaceId,
    message: "Your work is saved.",
  });
}

/** Build the sandbox that backs a run's workspace. */
export function createSandbox(
  ctx: SandboxRunContext,
  options: {
    onWorkspaceEvent?: WorkspaceEventSink;
    dailyRequestsUsed?: number;
    nextDhakaResetAt?: number;
  } = {},
): Sandbox {
  const settings = sandboxSettings();
  if (settings.kind === "remote") {
    return new LazySandbox({
      resolve: () =>
        resolveWorkspaceDaemon(ctx, {
          onWorkspaceEvent: options.onWorkspaceEvent,
          dailyRequestsUsed: options.dailyRequestsUsed,
          nextDhakaResetAt: options.nextDhakaResetAt,
        }).then((resolved) => ({
          baseUrl: resolved.baseUrl,
          token: resolved.token,
        })),
      onDestroy: async () => {
        const resolved = await resolveWorkspaceDaemon(ctx, {
          dailyRequestsUsed: options.dailyRequestsUsed,
          nextDhakaResetAt: options.nextDhakaResetAt,
        });
        await archiveWorkspace(ctx, resolved, options.onWorkspaceEvent);
      },
    });
  }
  return new LocalSandbox({ rootDir: ctx.workspaceDir });
}
