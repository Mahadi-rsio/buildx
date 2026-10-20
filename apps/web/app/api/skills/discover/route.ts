import { z } from "zod";
import { previewSkill } from "@buildx/agent";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const discoverSchema = z.object({
  source: z.string().min(1).max(2048),
  path: z.string().min(1).max(500).optional(),
});

function isMissingTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42P01"
  );
}

/** `POST /api/skills/discover` — preview a source without installing it. */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = discoverSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  try {
    const preview = await previewSkill(parsed.data.source, {
      path: parsed.data.path,
    });
    return Response.json({
      candidates: preview.candidates,
      ...(preview.skill
        ? {
            skill: {
              name: preview.skill.metadata.name,
              description: preview.skill.metadata.description,
              source: preview.skill.source,
              sourceKind: preview.skill.sourceKind,
              resolvedRef: preview.skill.resolvedRef,
              digest: preview.skill.digest,
              fileCount: Object.keys(preview.skill.files).length,
            },
          }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof Error &&
      (error.name === "SkillValidationError" ||
        error.name === "SkillSecurityError" ||
        /not owned/.test(message))
    ) {
      return Response.json({ error: "invalid_skill", message }, { status: 400 });
    }
    if (isMissingTableError(error)) {
      return Response.json(
        { error: "schema_not_migrated", message: "Run the database migrations." },
        { status: 503 },
      );
    }
    console.error("[POST /api/skills/discover] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
