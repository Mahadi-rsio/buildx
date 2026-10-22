import type { AgentCheckpoint, ApprovalOption } from "@buildx/shared";
import { getDb, resumeWaitingRun } from "@buildx/db";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import {
  appendEvent,
  persistCheckpoint,
  refreshRun,
  toRunSummary,
} from "@/lib/store";

export const dynamic = "force-dynamic";

function pendingOptions(checkpoint: AgentCheckpoint | undefined): ApprovalOption[] {
  const input = checkpoint?.interruptedTool?.input as
    | { options?: unknown }
    | undefined;
  if (!Array.isArray(input?.options)) return [];
  return input.options.filter(
    (option): option is ApprovalOption =>
      Boolean(
        option &&
          typeof option === "object" &&
          typeof (option as ApprovalOption).id === "string" &&
          typeof (option as ApprovalOption).label === "string",
      ),
  );
}

/**
 * `POST /api/runs/:id/answer` — resolve a pending ask_user question. The answer
 * is persisted on the checkpoint, emitted as an approval event, and the run is
 * requeued so the worker resumes the same conversation. Duplicate submissions
 * are idempotent and invalid option ids are rejected.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const { id } = await params;
  const owned = await findOwnedRun(id, user.id);
  if (!owned) return notFound(id);
  const run = (await refreshRun(id)) ?? owned;

  const body = (await request.json().catch(() => null)) as
    | { answer?: unknown; toolCallId?: unknown }
    | null;
  const rawAnswer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (rawAnswer.length === 0 || rawAnswer.length > 10_000) {
    return Response.json(
      { error: "invalid_answer", message: "An answer is required." },
      { status: 400 },
    );
  }

  const checkpoint = run.checkpoint as AgentCheckpoint | undefined;
  const pending = checkpoint?.interruptedTool;
  if (checkpoint?.approvalAnswer) {
    return Response.json({
      ...toRunSummary(run),
      alreadyAnswered: true,
    });
  }
  if (run.status !== "waiting_input" || !pending || pending.toolName !== "ask_user") {
    return Response.json(
      {
        error: "not_waiting",
        message: "This run is not waiting for a user answer.",
      },
      { status: 409 },
    );
  }
  if (
    typeof body?.toolCallId === "string" &&
    body.toolCallId.length > 0 &&
    body.toolCallId !== pending.toolCallId
  ) {
    return Response.json(
      {
        error: "stale_answer",
        message: "That question is no longer the active request.",
      },
      { status: 409 },
    );
  }

  const options = pendingOptions(checkpoint);
  let answer = rawAnswer;
  if (options.length > 0) {
    const match = options.find(
      (option) => option.id === rawAnswer || option.label === rawAnswer,
    );
    if (!match) {
      return Response.json(
        {
          error: "invalid_option",
          message: "Choose one of the provided answer options.",
          options,
        },
        { status: 400 },
      );
    }
    answer = match.id;
  }

  const question =
    typeof (pending.input as { question?: unknown } | undefined)?.question ===
    "string"
      ? ((pending.input as { question: string }).question)
      : "";
  const nextCheckpoint: AgentCheckpoint = {
    ...checkpoint,
    approvalAnswer: {
      toolCallId: pending.toolCallId,
      question,
      answer,
    },
    updatedAt: Date.now(),
  };
  await persistCheckpoint(run, nextCheckpoint);

  await appendEvent(run, {
    type: "approval",
    data: {
      toolCallId: pending.toolCallId,
      question,
      options,
      answer,
      status: "answered",
    },
    ts: Date.now(),
  });
  await appendEvent(run, {
    type: "status",
    data: { status: "queued", message: "resuming after user answer" },
    ts: Date.now(),
  });
  run.status = "queued";
  await resumeWaitingRun(getDb(), { runId: run.id });

  return Response.json({
    ...toRunSummary(run),
    answered: true,
  });
}
