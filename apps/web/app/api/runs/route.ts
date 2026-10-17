import { createRunSchema, envStatus } from "@buildx/shared";
import {
  DAILY_REQUEST_LIMIT,
  MONTHLY_CPU_HOURS,
  consumeDailyRequest,
  dailyRequestCount,
  dhakaDay,
  monthlyCpuSecondsUsed,
  nextDhakaReset,
} from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { getDb } from "@buildx/db";
import { createRun, listRunsForUser, toRunSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `GET /api/runs` — the caller's runs, newest first. */
export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const runs = await listRunsForUser(user.id);
  return Response.json({ runs: runs.map(toRunSummary) });
}

/**
 * `POST /api/runs` — enqueue a run as a `queued` row (arcetecture.md §5.2,
 * §9). Execution is driven by the durable job worker once it claims the run's
 * lease; the request returns as soon as the row is persisted. A repeat call
 * with the same `idempotencyKey` returns the original run instead of queuing
 * a second one.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => null);
  const parsed = createRunSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const config = envStatus();
  if (!config.hasApiKey) {
    return Response.json(
      {
        error: "missing_api_key",
        message:
          "OPENAI_API_KEY is not set. Copy .env.example to .env.local, add your key, and restart the dev server.",
      },
      { status: 400 },
    );
  }

  const selectedModel = parsed.data.model?.trim() || config.model;
  const db = getDb();
  const day = dhakaDay();
  const consumed = await consumeDailyRequest(db, user.id, day);
  if (consumed == null) {
    return Response.json(
      {
        error: "daily_quota_exhausted",
        message:
          "Daily request limit reached. Your work is saved — try again after the Dhaka reset.",
      },
      { status: 429 },
    );
  }

  const [usedCpuSeconds, usedDaily] = await Promise.all([
    monthlyCpuSecondsUsed(db, user.id),
    dailyRequestCount(db, user.id, day),
  ]);

  const run = await createRun({
    userId: user.id,
    workspaceName: user.name?.trim() || user.email.split("@")[0] || "workspace",
    task: parsed.data.task.trim(),
    model: selectedModel,
    maxSteps: parsed.data.maxSteps ?? config.maxSteps,
    idempotencyKey: parsed.data.idempotencyKey,
    usage: {
      cpuHoursUsed: Number((usedCpuSeconds / 3600).toFixed(2)),
      cpuHoursLimit: MONTHLY_CPU_HOURS,
      dailyRequestsUsed: usedDaily,
      dailyRequestsLimit: DAILY_REQUEST_LIMIT,
      nextDhakaResetAt: nextDhakaReset().getTime(),
    },
  });

  // Execution is queued, not tied to this request: the job worker (spawned by
  // instrumentation) claims the run and drives `startRun`.
  return Response.json(toRunSummary(run), { status: 201 });
}
