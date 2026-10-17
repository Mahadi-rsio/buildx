import {
  BoxSandbox,
  LazyBoxSandbox,
  LocalSandbox,
  type BoxSandboxOptions,
  type Sandbox,
} from "@buildx/sandbox";

export interface SandboxSettings {
  kind: "local" | "box";
  /** Upstash Box backend (`kind: "box"`). */
  boxApiKey?: string;
  boxBaseUrl?: string;
  boxRuntime?: string;
  boxSize?: string;
}

export interface SandboxRunContext {
  workspaceDir: string;
  userId: string;
  workspaceName: string;
}

const globalSandboxState = globalThis as unknown as {
  __BUILDX_BOXES__?: Map<string, Promise<BoxSandbox>>;
};

function boxCache(): Map<string, Promise<BoxSandbox>> {
  if (!globalSandboxState.__BUILDX_BOXES__) {
    globalSandboxState.__BUILDX_BOXES__ = new Map();
  }
  return globalSandboxState.__BUILDX_BOXES__;
}

/** Build a stable per-user box name (Box names must be [a-z0-9-]). */
function boxNameFor(ctx: SandboxRunContext): string {
  const slug = ctx.userId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `buildx-${slug.slice(0, 40)}`;
  return base.replace(/[^a-z0-9-]+/g, "-");
}

/**
 * Resolve how runs execute. Local mode shells out on this machine (dev/tests).
 * Box mode uses Upstash Box (persistent, auto-pausing) when `UPSTASH_BOX_API_KEY`
 * is set.
 */
export function sandboxSettings(): SandboxSettings {
  const boxApiKey = (process.env.UPSTASH_BOX_API_KEY ?? "").trim();
  if (boxApiKey) {
    return {
      kind: "box",
      boxApiKey,
      boxBaseUrl: (process.env.UPSTASH_BOX_BASE_URL ?? "").trim() || undefined,
      boxRuntime: (process.env.UPSTASH_BOX_RUNTIME ?? "").trim() || undefined,
      boxSize: (process.env.UPSTASH_BOX_SIZE ?? "").trim() || undefined,
    };
  }
  return { kind: "local" };
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
  const settings = sandboxSettings();
  if (settings.kind !== "box") {
    throw new Error("box workspace requested while sandbox is not in box mode");
  }

  const key = `${ctx.userId}`;
  const cache = boxCache();
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const box = new BoxSandbox({
      name: boxNameFor(ctx),
      apiKey: settings.boxApiKey!,
      baseUrl: settings.boxBaseUrl,
      runtime: (settings.boxRuntime as BoxSandboxOptions["runtime"]) || "node",
      size: (settings.boxSize as BoxSandboxOptions["size"]) || "small",
    });
    await box.start();
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

/** Build the sandbox that backs a run's workspace. */
export function createSandbox(ctx: SandboxRunContext): Sandbox {
  const settings = sandboxSettings();
  if (settings.kind === "box") {
    return new LazyBoxSandbox({
      resolve: () => resolveWorkspaceBox(ctx),
      // Keep the persistent box alive across runs; Box auto-pauses when idle.
      onDestroy: async (box) => {
        boxCache().delete(ctx.userId);
        await box.suspend().catch(() => undefined);
      },
    });
  }
  return new LocalSandbox({ rootDir: ctx.workspaceDir });
}