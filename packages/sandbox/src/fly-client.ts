import { z } from "zod";

/**
 * Typed wrapper over the Fly Machines API (arcetecture.md §2.4, phase.md §6).
 *
 * All shapes are validated with zod. The API has a few shapes we cannot confirm
 * against official docs yet:
 *   - `skip_launch` on machine create,
 *   - deleting a volume while it is still attached to a machine,
 *   - exact Machines API rate limits,
 *   - the exact create-app / IP-allocation request response envelopes.
 * Each of those is marked `TODO(verify)` and listed in the final report.
 *
 * The client applies exponential backoff with jitter on 429/5xx responses,
 * honouring a `Retry-After` header when present, and bounds overall request
 * concurrency so a burst of sandbox calls cannot trip Fly's rate limits.
 */

/* ─────────────────────────────── schemas ─────────────────────────────── */

const appSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    network: z.string().optional(),
    status: z.string().optional(),
    machine_count: z.number().optional(),
    volume_count: z.number().optional(),
  })
  .passthrough();
export type FlyApp = z.infer<typeof appSchema>;

const waitSchema = z
  .object({
    event_id: z.string().optional(),
    ok: z.boolean().optional(),
    state: z.string().optional(),
    version: z.number().optional(),
  })
  .passthrough();
export type FlyWaitResult = z.infer<typeof waitSchema>;

const machineConfigSchema = z
  .object({
    image: z.string(),
    guest: z
      .object({
        cpu_kind: z.enum(["shared", "performance", "dedicated"]).optional(),
        cpus: z.number().optional(),
        memory_mb: z.number().optional(),
        kernel_args: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    init: z
      .object({ swap_size_mb: z.number().optional(), cmd: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
    mounts: z
      .array(
        z
          .object({
            volume: z.string().optional(),
            path: z.string(),
            name: z.string().optional(),
            size_gb: z.number().optional(),
            encrypted: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    services: z.array(z.unknown()).optional(),
    restart: z
      .object({ policy: z.enum(["no", "on-failure", "always"]).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type MachineConfig = z.infer<typeof machineConfigSchema>;

const machineSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    state: z.string().optional(),
    region: z.string().optional(),
    private_ip: z.string().nullable().optional(),
    instance_id: z.string().optional(),
    nonce: z.string().optional(),
    config: machineConfigSchema.optional(),
    image_ref: z.record(z.string(), z.unknown()).optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();
export type FlyMachine = z.infer<typeof machineSchema>;

const volumeSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    state: z.string().optional(),
    region: z.string().optional(),
    size_gb: z.number().optional(),
    encrypted: z.boolean().optional(),
    attached_machine_id: z.string().nullable().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();
export type FlyVolume = z.infer<typeof volumeSchema>;

const leaseSchema = z
  .object({
    // The lease API wraps the payload in `{ status, data: { nonce, ... } }`.
    status: z.string().optional(),
    data: z
      .object({
        nonce: z.string(),
        expires_at: z.union([z.string(), z.number()]),
      })
      .passthrough(),
  })
  .transform((value) => value.data);
export type FlyLease = z.infer<typeof leaseSchema>;

const ipsSchema = z
  .object({
    ips: z
      .array(
        z
          .object({
            ip: z.string(),
            type: z.string().optional(),
            region: z.string().optional(),
            created_at: z.string().optional(),
            egress: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type FlyIpAssignments = z.infer<typeof ipsSchema>;

/** Error thrown when the API returns a response we decide not to retry. */
export class FlyApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "FlyApiError";
    this.status = status;
    this.body = body;
  }
}

/* ─────────────────────────────── primitives ─────────────────────────────── */

/** Bounds concurrent calls so bursts do not trip API rate limits. */
export class ConcurrencyLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get pending(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.max <= 0) return fn();
    if (this.active >= this.max) {
      await new Promise<void>((res) => this.queue.push(res));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** jitter in (0, 1] so concurrent retries do not re-collide. */
function jittered(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

/* ─────────────────────────────── client ─────────────────────────────── */

export interface FlyClientOptions {
  /** FLY_API_TOKEN — created for the orchestrator only (arcetecture.md §6). */
  token: string;
  /** FLY_ORG_SLUG — org workspace apps belong to. */
  orgSlug: string;
  /** API base; defaults to the production Machines API. */
  baseUrl?: string;
  /** Retry attempts after the first attempt (429/5xx). Default 4. */
  maxRetries?: number;
  /** Base backoff for attempt 1. Default 500 ms. */
  retryBaseMs?: number;
  /** Max concurrency of in-flight requests. Default 8. */
  concurrency?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export type FlyMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface FlyRequestOptions {
  method: FlyMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  schema?: z.ZodType<unknown>;
  /** Override the global max retries (e.g. never retry deregistration). */
  maxRetries?: number;
}

/** The operations fly-manager + tests depend on (see also the fake in tests). */
export interface FlyClient {
  readonly orgSlug: string;

  createApp(input: { name: string; network?: string; vm?: unknown }): Promise<FlyApp>;
  getApp(name: string): Promise<FlyApp>;
  destroyApp(name: string): Promise<void>;
  /** Allocated public IPs for an app (must be none for workspace apps). */
  listIpAssignments(name: string): Promise<FlyIpAssignments>;

  createVolume(
    appName: string,
    input: {
      name: string;
      region?: string;
      sizeGb: number;
      snapshotRetention?: number;
      encrypted?: boolean;
    },
  ): Promise<FlyVolume>;
  getVolume(appName: string, volumeId: string): Promise<FlyVolume>;
  listVolumes(appName: string): Promise<FlyVolume[]>;
  destroyVolume(appName: string, volumeId: string): Promise<void>;

  createMachine(
    appName: string,
    input: {
      region?: string;
      name?: string;
      config: MachineConfig;
      // TODO(verify): shape/behaviour of `skip_launch` on machine create.
      skipLaunch?: boolean;
    },
  ): Promise<FlyMachine>;
  getMachine(appName: string, machineId: string): Promise<FlyMachine>;
  listMachines(appName: string): Promise<FlyMachine[]>;
  startMachine(appName: string, machineId: string): Promise<FlyMachine>;
  stopMachine(
    appName: string,
    machineId: string,
    input?: { signal?: "SIGINT" | "SIGTERM" | "SIGKILL"; timeout?: number },
  ): Promise<FlyMachine>;
  destroyMachine(
    appName: string,
    machineId: string,
    input?: { force?: boolean },
  ): Promise<void>;
  waitForState(
    appName: string,
    machineId: string,
    input?: { state?: string; timeout?: number; instanceId?: string },
  ): Promise<FlyWaitResult>;

  /** Lease flow — updates must acquire first, then send the FULL config. */
  acquireLease(
    appName: string,
    machineId: string,
    input?: { description?: string; ttl?: number },
  ): Promise<FlyLease>;
  updateMachine(
    appName: string,
    machineId: string,
    input: { config: MachineConfig; name?: string; leaseNonce: string },
  ): Promise<FlyMachine>;
  releaseLease(appName: string, machineId: string, nonce: string): Promise<void>;
}

/**
 * Real Machines API client. Every call is concurrency-limited and 429/5xx
 * responses are retried with exponential backoff honouring `Retry-After`.
 */
export class MachinesApiClient implements FlyClient {
  readonly orgSlug: string;
  readonly baseUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly limiter: ConcurrencyLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FlyClientOptions) {
    this.token = options.token;
    this.orgSlug = options.orgSlug;
    this.baseUrl = (options.baseUrl ?? "https://api.machines.dev").replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.limiter = new ConcurrencyLimiter(options.concurrency ?? 8);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** One attempt of `request` without retry bookkeeping. */
  private async attempt(options: FlyRequestOptions): Promise<Response> {
    const url = new URL(`${this.baseUrl}${options.path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return this.fetchImpl(url.toString(), {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  /** Run a request inside the concurrency limiter, with retries. */
  private async request(options: FlyRequestOptions): Promise<Response> {
    return this.limiter.run(async () => {
      const maxRetries = options.maxRetries ?? this.maxRetries;
      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const response = await this.attempt(options);
        const retryable =
          response.status === 429 || (response.status >= 500 && response.status < 600);
        if (!retryable || attempt === maxRetries) {
          if (response.ok) return response;
          lastError = await this.toApiError(response);
          if (!retryable || attempt === maxRetries) throw lastError;
        }
        // Backoff: honour Retry-After, otherwise exponential with jitter.
        const backoff = jittered(
          Math.min(
            this.retryBaseMs * 2 ** attempt,
            30_000,
          ),
        );
        const wait = parseRetryAfter(response.headers.get("retry-after")) ?? backoff;
        await sleep(wait);
      }
      throw (
        lastError ??
        new FlyApiError(0, `request failed after ${maxRetries + 1} attempts`)
      );
    });
  }

  private async toApiError(response: Response): Promise<FlyApiError> {
    let body: unknown;
    let message = `Fly API ${response.status}`;
    try {
      body = await response.json();
      if (body && typeof body === "object") {
        const err = (body as { error?: unknown }).error;
        if (typeof err === "string" && err) message = err;
        else if (typeof err === "object" && err) message = JSON.stringify(err);
      }
      // TODO(verify): Machines API rate-limit fields (e.g. `limit`, `remaining`).
    } catch {
      // Non-JSON error body; keep the status-line message.
    }
    return new FlyApiError(response.status, message, body);
  }

  /** Parse a response body with a zod schema; passthrough fields survive. */
  private async parse<T>(response: Response, schema?: z.ZodType<T>): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    const json = JSON.parse(text);
    if (schema) return schema.parse(json);
    return json as T;
  }

  private async call<T>(
    options: FlyRequestOptions & { schema?: z.ZodType<T> },
  ): Promise<T> {
    const response = await this.request(options);
    return this.parse(response, options.schema);
  }

  /* ── apps ── */

  async createApp(input: {
    name: string;
    network?: string;
    vm?: unknown;
  }): Promise<FlyApp> {
    // TODO(verify): exact create-app request/response envelope.
    const body = {
      name: input.name,
      org_slug: this.orgSlug,
      network: input.network,
      vm: input.vm,
    };
    const result = await this.call({
      method: "POST",
      path: "/v1/apps",
      body,
      schema: appSchema as z.ZodType<FlyApp>,
    });
    return { ...result, name: result.name ?? input.name };
  }

  async getApp(name: string): Promise<FlyApp> {
    return this.call({
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(name)}`,
      schema: appSchema as z.ZodType<FlyApp>,
    });
  }

  async destroyApp(name: string): Promise<void> {
    await this.call({
      method: "DELETE",
      path: `/v1/apps/${encodeURIComponent(name)}`,
      schema: z.unknown(),
    });
  }

  async listIpAssignments(name: string): Promise<FlyIpAssignments> {
    // TODO(verify): IP-allocation listing shape.
    return this.call({
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(name)}/ip_assignments`,
      schema: ipsSchema as z.ZodType<FlyIpAssignments>,
    });
  }

  /* ── volumes ── */

  async createVolume(
    appName: string,
    input: {
      name: string;
      region?: string;
      sizeGb: number;
      snapshotRetention?: number;
      encrypted?: boolean;
    },
  ): Promise<FlyVolume> {
    return this.call({
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/volumes`,
      body: {
        name: input.name,
        region: input.region,
        size_gb: input.sizeGb,
        snapshot_retention: input.snapshotRetention,
        encrypted: input.encrypted,
      },
      schema: volumeSchema as z.ZodType<FlyVolume>,
    });
  }

  async getVolume(appName: string, volumeId: string): Promise<FlyVolume> {
    return this.call({
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(appName)}/volumes/${encodeURIComponent(volumeId)}`,
      schema: volumeSchema as z.ZodType<FlyVolume>,
    });
  }

  async listVolumes(appName: string): Promise<FlyVolume[]> {
    const body = await this.call({
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(appName)}/volumes`,
      schema: z
        .union([z.array(volumeSchema), z.object({ volumes: z.array(volumeSchema) })])
        .transform((value) =>
          Array.isArray(value) ? value : (value.volumes ?? []),
        ) as z.ZodType<FlyVolume[]>,
    });
    return body;
  }

  async destroyVolume(appName: string, volumeId: string): Promise<void> {
    // TODO(verify): whether a volume can be deleted while still attached.
    await this.call({
      method: "DELETE",
      path: `/v1/apps/${encodeURIComponent(appName)}/volumes/${encodeURIComponent(volumeId)}`,
      schema: z.unknown(),
    });
  }

  /* ── machines ── */

  async createMachine(
    appName: string,
    input: {
      region?: string;
      name?: string;
      config: MachineConfig;
      skipLaunch?: boolean;
    },
  ): Promise<FlyMachine> {
    return this.call({
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
      // TODO(verify): `skip_launch` field placement + behaviour.
      body: {
        region: input.region,
        name: input.name,
        skip_launch: input.skipLaunch === true,
        config: input.config,
      },
      schema: machineSchema as z.ZodType<FlyMachine>,
    });
  }

  async getMachine(appName: string, machineId: string): Promise<FlyMachine> {
    return this.call({
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      schema: machineSchema as z.ZodType<FlyMachine>,
    });
  }

  async listMachines(appName: string): Promise<FlyMachine[]> {
    // TODO(verify): rate limits on machine listing.
    return this.call({
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines`,
      schema: z
        .union([z.array(machineSchema), z.object({ machines: z.array(machineSchema) })])
        .transform((value) =>
          Array.isArray(value) ? value : (value.machines ?? []),
        ) as z.ZodType<FlyMachine[]>,
    });
  }

  async startMachine(appName: string, machineId: string): Promise<FlyMachine> {
    return this.call({
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/start`,
      schema: machineSchema as z.ZodType<FlyMachine>,
    });
  }

  async stopMachine(
    appName: string,
    machineId: string,
    input: { signal?: "SIGINT" | "SIGTERM" | "SIGKILL"; timeout?: number } = {},
  ): Promise<FlyMachine> {
    return this.call({
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`,
      body: { signal: input.signal, timeout: input.timeout },
      schema: machineSchema as z.ZodType<FlyMachine>,
    });
  }

  async destroyMachine(
    appName: string,
    machineId: string,
    input: { force?: boolean } = {},
  ): Promise<void> {
    await this.call({
      method: "DELETE",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      query: input.force ? { force: true } : undefined,
      schema: z.unknown(),
    });
  }

  async waitForState(
    appName: string,
    machineId: string,
    input: { state?: string; timeout?: number; instanceId?: string } = {},
  ): Promise<FlyWaitResult> {
    return this.call({
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/wait`,
      query: {
        state: input.state,
        timeout: input.timeout,
        instance_id: input.instanceId,
      },
      schema: waitSchema as z.ZodType<FlyWaitResult>,
    });
  }

  /* ── lease flow (any config update sends the FULL config, not a merge) ── */

  async acquireLease(
    appName: string,
    machineId: string,
    input: { description?: string; ttl?: number } = {},
  ): Promise<FlyLease> {
    return this.call({
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/lease`,
      body: { description: input.description, ttl: input.ttl },
      schema: leaseSchema,
    });
  }

  async updateMachine(
    appName: string,
    machineId: string,
    input: { config: MachineConfig; name?: string; leaseNonce: string },
  ): Promise<FlyMachine> {
    return this.call({
      method: "POST",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      headers: { "fly-machine-lease-nonce": input.leaseNonce },
      body: { config: input.config, name: input.name },
      schema: machineSchema as z.ZodType<FlyMachine>,
    });
  }

  async releaseLease(appName: string, machineId: string, nonce: string): Promise<void> {
    await this.call({
      method: "DELETE",
      path: `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/lease`,
      headers: { "fly-machine-lease-nonce": nonce },
      schema: z.unknown(),
    });
  }
}