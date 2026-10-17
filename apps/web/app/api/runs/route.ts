import { createRunSchema, envStatus } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { listRunsForUser, toRunSummary } from "@/lib/store";
import { enqueueRunForUser } from "@/lib/run-creation";

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
 * with the same `idempotencyKey` returns the original run instead of queuing a
 * second one and does not consume a quota slot. A day at its hard limit is
 * rejected with `429` before anything is queued.
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
  const result = await enqueueRunForUser({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
    },
    task: parsed.data.task.trim(),
    model: selectedModel,
    maxSteps: parsed.data.maxSteps ?? config.maxSteps,
    idempotencyKey: parsed.data.idempotencyKey,
  });

  if (result.kind === "quota_exhausted") {
    return Response.json(
      {
        error: "daily_quota_exhausted",
        message:
          "Daily request limit reached. Your work is saved — try again after the Dhaka reset.",
      },
      { status: 429 },
    );
  }

  // Newly queued runs are 201; idempotent replays return the original run.
  const status = result.kind === "created" ? 201 : 200;
  return Response.json(toRunSummary(result.run), { status });
}
