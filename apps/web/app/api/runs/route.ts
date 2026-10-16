import { createRunSchema, envStatus } from "@buildx/shared";
import { startRun } from "@/lib/runner";
import { createRun, listRuns, toRunSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `GET /api/runs` — newest first. */
export async function GET(): Promise<Response> {
  return Response.json({ runs: listRuns().map(toRunSummary) });
}

/**
 * `POST /api/runs` — create a run and start it detached
 * (arcetecture.md §5.2, simplified from `/api/projects/:id/tasks`).
 */
export async function POST(request: Request): Promise<Response> {
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

  const run = createRun({
    task: parsed.data.task.trim(),
    model: selectedModel,
    maxSteps: parsed.data.maxSteps ?? config.maxSteps,
  });

  // Fire and forget: `startRun` never rejects and appends every step itself.
  void startRun(run);

  return Response.json(toRunSummary(run), { status: 201 });
}
