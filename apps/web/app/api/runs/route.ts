import { randomUUID } from "node:crypto";
import { createRunSchema, envStatus, providerEndpoint, resolveModelProvider } from "@buildx/shared";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { listRunsForUser, toRunSummary } from "@/lib/store";
import { createRunForUser } from "@/lib/run-creation";

export const dynamic = "force-dynamic";

/** `GET /api/runs` — the caller's runs, newest first. */
export async function GET(request?: Request): Promise<Response> {
  try {
    const user = await getCurrentUser(request?.headers);
    if (!user) return unauthorized();
    const runs = await listRunsForUser(user.id);
    return Response.json({ runs: runs.map(toRunSummary) });
  } catch (error: unknown) {
    console.error("[GET /api/runs] error:", error);
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return Response.json(
      { error: "internal_error", message, runs: [] },
      { status: 500 },
    );
  }
}

/**
 * `POST /api/runs` — create a run as a `queued` row (arcetecture.md §5.2).
 * Execution is driven by the in-process worker once it claims the run's lease;
 * the request returns as soon as the row is persisted. A repeat call with the
 * same `idempotencyKey` returns the original run instead of creating a second
 * one and does not consume a quota slot. A day at its hard limit is rejected
 * with `429` before anything is queued.
 */
export async function POST(request: Request): Promise<Response> {
  const correlationId = request.headers.get("x-correlation-id") || randomUUID();
  try {
    console.log(`[POST /api/runs][${correlationId}] run creation request received`);
    const user = await getCurrentUser(request.headers);
    if (!user) {
      console.warn(`[POST /api/runs][${correlationId}] unauthenticated user`);
      return unauthorized();
    }
    console.log(`[POST /api/runs][${correlationId}] authenticated user=${user.id}`);

    const body = await request.json().catch(() => null);
    const parsed = createRunSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "invalid_request", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const config = envStatus();
    const selectedModel = parsed.data.model?.trim() || config.model;
    const provider = resolveModelProvider(selectedModel, config);
    const endpoint = providerEndpoint(provider);
    if (!endpoint.apiKey) {
      const message =
        provider === "litellm"
          ? "The LiteLLM gateway key is not set. Add LITELLM_API_KEY and LITELLM_BASE_URL to .env.local and restart the dev server."
          : "The OpenRouter key is not set. Add OPENROUTER_API_KEY to .env.local and restart the dev server.";
      return Response.json(
        { error: "missing_api_key", message },
        { status: 400 },
      );
    }

    console.log(`[POST /api/runs][${correlationId}] creating run for user=${user.id} model=${selectedModel} provider=${provider}`);
    const result = await createRunForUser({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      task: parsed.data.task.trim(),
      model: selectedModel,
      maxSteps: parsed.data.maxSteps ?? config.maxSteps,
      contextWindowTokens: parsed.data.contextWindow,
      history: parsed.data.history,
      skillNames: parsed.data.skillNames,
      conversationId: parsed.data.conversationId,
      idempotencyKey: parsed.data.idempotencyKey,
      correlationId,
    });

    if (result.kind === "quota_exhausted") {
      console.warn(`[POST /api/runs][${correlationId}] quota exhausted for user=${user.id}`);
      return Response.json(
        {
          error: "DAILY_AI_QUOTA_EXCEEDED",
          message:
            "Daily AI request limit (50) reached. It resets at midnight Asia/Dhaka.",
        },
        { status: 429 },
      );
    }

    if (result.kind === "quota_unavailable") {
      console.error(`[POST /api/runs][${correlationId}] quota service unavailable`);
      return Response.json(
        {
          error: "QUOTA_SERVICE_UNAVAILABLE",
          message:
            "The daily quota service is unavailable, so the run was not started.",
        },
        { status: 503 },
      );
    }

    if (result.kind === "conversation_conflict") {
      return Response.json(
        {
          error: "conversation_conflict",
          message: "That conversation belongs to another account.",
        },
        { status: 403 },
      );
    }

    console.log(`[POST /api/runs][${correlationId}] run created with id=${result.run.id} status=${result.run.status}`);
    // Newly queued runs are 201; idempotent replays return the original run.
    const status = result.kind === "created" ? 201 : 200;
    return Response.json(toRunSummary(result.run), { status });
  } catch (error: unknown) {
    console.error(`[POST /api/runs][${correlationId}] error:`, error);
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return Response.json(
      { error: "internal_error", message },
      { status: 500 },
    );
  }
}
