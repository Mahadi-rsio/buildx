import {
  BoxSandbox,
  LazyBoxSandbox,
  type BoxSandboxOptions,
  type Sandbox,
} from "@buildx/sandbox";

export interface BoxSettings {
  apiKey: string;
  baseUrl?: string;
  runtime?: string;
  size?: string;
}

export interface SandboxRunContext {
  userId: string;
  /** Durable workspace row; each workspace owns its own Box. */
  workspaceId?: string;
}

const globalSandboxState = globalThis as unknown as {
  __BUILDX_BOXES__?: Map<string, Promise<BoxSandbox>>;
  __BUILDX_BOXES_RESOLVED__?: Map<string, BoxSandbox>;
  __BUILDX_BOXES_MISSING__?: Map<string, number>;
};

/** How long a failed attach is remembered before probing Box again. */
const MISSING_BOX_TTL_MS = 10_000;

function boxCache(): Map<string, Promise<BoxSandbox>> {
  if (!globalSandboxState.__BUILDX_BOXES__) {
    globalSandboxState.__BUILDX_BOXES__ = new Map();
  }
  return globalSandboxState.__BUILDX_BOXES__;
}

function resolvedBoxes(): Map<string, BoxSandbox> {
  if (!globalSandboxState.__BUILDX_BOXES_RESOLVED__) {
    globalSandboxState.__BUILDX_BOXES_RESOLVED__ = new Map();
  }
  return globalSandboxState.__BUILDX_BOXES_RESOLVED__;
}

function missingBoxes(): Map<string, number> {
  if (!globalSandboxState.__BUILDX_BOXES_MISSING__) {
    globalSandboxState.__BUILDX_BOXES_MISSING__ = new Map();
  }
  return globalSandboxState.__BUILDX_BOXES_MISSING__;
}

/** Build a stable per-user box name (Box names must be [a-z0-9-]). */
function boxNameFor(ctx: SandboxRunContext): string {
  const id = ctx.workspaceId ? `ws-${ctx.workspaceId}` : ctx.userId;
  const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = ctx.workspaceId ? "buildx-" : "buildx-";
  return `${prefix}${slug.slice(0, 40)}`.replace(/[^a-z0-9-]+/g, "-");
}

/**
 * Upstash Box is the only execution backend. There is no local fallback: a
 * missing key is a configuration error, not a reason to run on the host.
 */
export function boxSettings(): BoxSettings {
  const apiKey = (process.env.UPSTASH_BOX_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "UPSTASH_BOX_API_KEY is required: every run executes in an Upstash Box workspace.",
    );
  }
  return {
    apiKey,
    baseUrl: (process.env.UPSTASH_BOX_BASE_URL ?? "").trim() || undefined,
    runtime: (process.env.UPSTASH_BOX_RUNTIME ?? "").trim() || undefined,
    size: (process.env.UPSTASH_BOX_SIZE ?? "").trim() || undefined,
  };
}

function boxOptions(ctx: SandboxRunContext): BoxSandboxOptions {
  const settings = boxSettings();
  return {
    name: boxNameFor(ctx),
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    runtime: (settings.runtime as BoxSandboxOptions["runtime"]) || "node",
    size: (settings.size as BoxSandboxOptions["size"]) || "small",
    // Never keep an ordinary workspace running while idle: Upstash auto-pauses
    // it and active-CPU billing stops. Runs pause it explicitly on teardown.
    keepAlive: false,
  };
}

/**
 * Resolve (and cache) the persistent Upstash Box backing a user's workspace.
 * One box per user, named after their id, so reconnecting resumes the same
 * workspace. Exposed above `createSandbox` so the workspace source and the
 * runner share one connected instance.
 */
export async function resolveWorkspaceBox(
  ctx: SandboxRunContext,
): Promise<BoxSandbox> {
  const key = ctx.workspaceId ?? ctx.userId;
  const cache = boxCache();
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const box = new BoxSandbox(boxOptions(ctx));
    await box.start();
    resolvedBoxes().set(key, box);
    missingBoxes().delete(key);
    return box;
  })();

  cache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

/**
 * Non-activating box lookup: attach to the user's existing box if there is one.
 * Never creates a box, so read-only consumers (file browser, diff) cannot spin
 * one up. Reconnecting matters after a server restart: the box still exists in
 * Upstash even though this process has no in-memory handle for it.
 */
export async function tryGetWorkspaceBox(
  userId: string,
  workspaceId?: string,
): Promise<BoxSandbox | undefined> {
  const ctx = { userId, workspaceId };
  const key = workspaceId ?? userId;
  const resolved = resolvedBoxes().get(key);
  if (resolved) return resolved;

  const pending = boxCache().get(key);
  if (pending) return pending;

  const missingUntil = missingBoxes().get(key);
  if (missingUntil && missingUntil > Date.now()) return undefined;

  const box = new BoxSandbox(boxOptions(ctx));
  const connected = await box.connect();
  if (!connected) {
    missingBoxes().set(key, Date.now() + MISSING_BOX_TTL_MS);
    return undefined;
  }
  resolvedBoxes().set(key, box);
  missingBoxes().delete(key);
  return box;
}

/**
 * Cancel and suspend remote Box execution for a user.
 */
export async function cancelRemoteBoxExecution(userId: string, workspaceId?: string): Promise<void> {
  try {
    const box = await tryGetWorkspaceBox(userId, workspaceId);
    if (box) {
      await box.suspend().catch((err) => {
        console.warn(`[sandbox] failed to suspend box for user ${userId}`, err);
      });
    }
  } catch (error) {
    console.warn(`[sandbox] error cancelling remote box for user ${userId}`, error);
  }
}

/** Build the sandbox that backs a run's workspace. */
export function createSandbox(ctx: SandboxRunContext): Sandbox {
  return new LazyBoxSandbox({
    resolve: () => resolveWorkspaceBox(ctx),
    // Keep the persistent box alive across runs; Box auto-pauses when idle.
    onDestroy: async (box) => {
      boxCache().delete(ctx.workspaceId ?? ctx.userId);
      resolvedBoxes().delete(ctx.workspaceId ?? ctx.userId);
      await box.suspend().catch(() => undefined);
    },
  });
}
