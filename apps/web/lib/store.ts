import { randomUUID } from "node:crypto";
import type { RunEvent, RunEventInput, RunStatus } from "@buildx/shared";
import { isTerminalStatus } from "@buildx/shared";
import { workspaceDirFor } from "./paths";
import type {
  RunDetail,
  RunStats,
  RunSummary,
  WorkspaceRuntime,
  WorkspaceUsage,
} from "./types";
import type { Baseline } from "./workspace-fs";

/** Trigger lazy baseline capture on first diff request (arcetecture §6). */
export const captureBaseline = Symbol.for("__buildx.captureBaseline");

export interface StoredRun {
  id: string;
  userId: string;
  workspaceName: string;
  task: string;
  status: RunStatus;
  model: string;
  maxSteps: number;
  /** Absolute path of the sandbox workspace root for this run. */
  workspaceDir: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  stats?: RunStats;
  /** Append-only event log (arcetecture.md §4). */
  events: RunEvent[];
  /** Live SSE subscribers waiting for the next event. */
  subscribers: Set<(event: RunEvent) => void>;
  /** Aborted by `POST /api/runs/:id/stop`. */
  controller: AbortController;
  /** Run-start snapshot for the workspace diff (arcetecture §6). Capture is
   *  lazy: the first `GET /api/workspaces/:id/diff` fills this when missing. */
  baseline?: Baseline;
  /** Workspace lifecycle + quota state surfaced by Phase 10 UI. */
  workspace: WorkspaceRuntime;
}

export interface Store {
  runs: Map<string, StoredRun>;
  nextEventId: number;
}

/**
 * In-memory event store for Phase 1/2. Persisted on `globalThis` so Next's dev
 * server does not lose runs when it reloads a module, and so route handlers
 * share one store per server process. `arcetecture.md` §4 replaces this with the
 * `events` table + LISTEN/NOTIFY once `packages/db` lands.
 */
const globalForStore = globalThis as unknown as { __BUILDX_STORE__?: Store };

export function getStore(): Store {
  if (!globalForStore.__BUILDX_STORE__) {
    globalForStore.__BUILDX_STORE__ = { runs: new Map(), nextEventId: 1 };
  }
  return globalForStore.__BUILDX_STORE__;
}

export interface CreateRunArgs {
  userId: string;
  workspaceName: string;
  task: string;
  model: string;
  maxSteps: number;
  usage?: WorkspaceUsage;
}

export function createRun(args: CreateRunArgs): StoredRun {
  const now = Date.now();
  const id = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const run: StoredRun = {
    id,
    userId: args.userId,
    workspaceName: args.workspaceName,
    task: args.task,
    status: "queued",
    model: args.model,
    maxSteps: args.maxSteps,
    workspaceDir: workspaceDirFor(id),
    createdAt: now,
    updatedAt: now,
    events: [],
    subscribers: new Set(),
    controller: new AbortController(),
    workspace: {
      status: "idle",
      usage: args.usage,
    },
  };
  getStore().runs.set(run.id, run);
  return run;
}

export function getRun(id: string): StoredRun | undefined {
  return getStore().runs.get(id);
}

export function getRunByWorkspaceId(workspaceId: string): StoredRun | undefined {
  return listRuns().find((run) => run.id === workspaceId);
}

export function listRuns(): StoredRun[] {
  return [...getStore().runs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Append an event, assign its id, and fan it out to live SSE subscribers. */
export function appendEvent(run: StoredRun, input: RunEventInput): RunEvent {
  const store = getStore();
  const event = {
    ...input,
    id: store.nextEventId++,
    runId: run.id,
  } as RunEvent;
  run.events.push(event);
  run.updatedAt = event.ts;
  for (const subscriber of [...run.subscribers]) {
    try {
      subscriber(event);
    } catch {
      run.subscribers.delete(subscriber);
    }
  }
  return event;
}

/** Move a run to a terminal status, remembering the failure reason if any. */
export function finishRun(
  run: StoredRun,
  status: RunStatus,
  error?: string,
): void {
  run.status = status;
  run.updatedAt = Date.now();
  if (error) run.error = error;
}

export function isRunning(run: StoredRun): boolean {
  return !isTerminalStatus(run.status);
}

export function toRunSummary(run: StoredRun): RunSummary {
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    model: run.model,
    maxSteps: run.maxSteps,
    workspaceId: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    error: run.error,
    stats: run.stats,
    workspace: run.workspace,
    eventCount: run.events.length,
  };
}

export function toRunDetail(run: StoredRun): RunDetail {
  return { ...toRunSummary(run), events: run.events };
}
