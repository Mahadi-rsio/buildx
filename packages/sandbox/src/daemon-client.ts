/**
 * Thin HTTP client for the sandbox daemon's lifecycle endpoints
 * (services/sandbox-daemon/server.mjs). The orchestrator uses these during
 * restore (ensureRunning) and archive, while ordinary tool calls ride the
 * `DaemonSandbox` in ./daemon.ts.
 *
 *   GET  /health /healthz   liveness + tool presence (no auth)
 *   POST /init              bootstrap-token auth; body { token, restoreUrl }
 *   POST /sync              active-token auth; body { uploadUrl } -> { size, sha256 }
 *
 * Before `/init` the daemon only accepts health + init. After it, every other
 * call (incl. /sync) requires the active per-workspace token, so the caller
 * must fetch the plaintext `daemonTokenEncrypted` value for sync.
 */

export interface DaemonHealth {
  ok: boolean;
  pid?: number;
  workspace?: string;
  initialized?: boolean;
  lastActivityAt?: string | null;
  tools?: Record<string, boolean>;
}

export interface DaemonInitInput {
  /** Fully-qualified daemon base URL, e.g. `http://<private-ip>:8080`. */
  baseUrl: string;
  /** Bootstrap token the machine was booted with (SANDBOX_TOKEN env). */
  bootstrapToken: string;
  /** Fresh per-workspace token the daemon will require after /init. */
  token: string;
  /** Optional short-lived presigned GET URL of a backup archive. */
  restoreUrl?: string;
  /** Single-request timeout in ms; default 30s. */
  requestTimeoutMs?: number;
}

export interface DaemonSyncInput {
  baseUrl: string;
  /** Active per-workspace token (persisted daemonTokenEncrypted). */
  token: string;
  /** Presigned PUT URL the daemon will upload a tar.zst to. */
  uploadUrl: string;
  requestTimeoutMs?: number;
}

export interface DaemonSyncResult {
  ok: boolean;
  size: number;
  sha256: string;
}

/** Error carrying the HTTP status so callers can special-case e.g. 409. */
export class DaemonApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "DaemonApiError";
    this.status = status;
    this.body = body;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const detail =
        typeof body === "object" &&
        body !== null &&
        "error" in (body as { error?: unknown })
          ? String((body as { error: unknown }).error)
          : String(body ?? "");
      throw new DaemonApiError(
        response.status,
        `sandbox daemon ${path} ${response.status}${detail ? `: ${detail}` : ""}`,
        body,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof DaemonApiError) throw error;
    throw new Error(
      `sandbox daemon ${path} request failed: ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** GET /health — no auth. Throws if the daemon is unreachable. */
export async function daemonHealth(
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<DaemonHealth> {
  const body = await request(baseUrl, "/health", { method: "GET" }, timeoutMs);
  return body as DaemonHealth;
}

/** POST /init — bootstrap-token auth; sets the per-workspace token. */
export async function daemonInit(input: DaemonInitInput): Promise<DaemonHealth> {
  const body = await request(
    input.baseUrl,
    "/init",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.bootstrapToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        token: input.token,
        restoreUrl: input.restoreUrl ?? "",
      }),
    },
    input.requestTimeoutMs ?? 30_000,
  );
  return body as DaemonHealth;
}

/**
 * POST /sync — tar.zst the workspace and upload it to `uploadUrl`. Requires the
 * active per-workspace token (pre-`/init` the daemon rejects it with 409).
 */
export async function daemonSync(input: DaemonSyncInput): Promise<DaemonSyncResult> {
  const body = await request(
    input.baseUrl,
    "/sync",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ uploadUrl: input.uploadUrl }),
    },
    input.requestTimeoutMs ?? 30_000,
  );
  return body as DaemonSyncResult;
}

/** Poll /health until it returns `ok` or a deadline passes. */
export async function waitForDaemonHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<DaemonHealth> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const health = await daemonHealth(baseUrl);
      if (health.ok) return health;
      lastError = new Error(`health ok=false: ${JSON.stringify(health)}`);
    } catch (error) {
      lastError = error as Error;
    }
    await sleep(1_000);
  }
  throw new Error(
    `sandbox daemon not healthy at ${baseUrl} within ${timeoutMs}ms${
      lastError ? ` (last error: ${lastError.message})` : ""
    }`,
  );
}