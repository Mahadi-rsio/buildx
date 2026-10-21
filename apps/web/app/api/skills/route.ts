import { z } from "zod";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import {
  installSkillFromSource,
  installSkillsFromSource,
  listInstalledSkillViews,
} from "@/lib/skills/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const installSchema = z.object({
  source: z.string().min(1).max(2048),
  path: z.string().min(1).max(500).optional(),
  paths: z.array(z.string().max(500)).min(1).max(100).optional(),
  overwrite: z.boolean().optional(),
  projectId: z.string().uuid().optional(),
});

function isMissingTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "42P01"
  );
}

function isStorageUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    cause?: { name?: unknown; code?: unknown };
  };
  const codes = new Set([
    candidate.name,
    candidate.code,
    candidate.cause?.name,
    candidate.cause?.code,
  ]);
  return [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "NetworkingError",
    "TimeoutError",
    "NoSuchBucket",
    "AccessDenied",
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
  ].some((code) => codes.has(code));
}

/** `GET /api/skills?projectId=` — installed skills visible to the caller. */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId") || undefined;
  try {
    const skills = await listInstalledSkillViews(user.id, projectId);
    return Response.json({ skills });
  } catch (error) {
    if (isMissingTableError(error)) {
      return Response.json(
        { error: "schema_not_migrated", message: "Run the database migrations." },
        { status: 503 },
      );
    }
    console.error("[GET /api/skills] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}

/** `POST /api/skills` — discover and install a skill. Never starts a Box. */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = installSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  try {
    if (parsed.data.paths) {
      const results = await installSkillsFromSource({
        userId: user.id,
        source: parsed.data.source,
        paths: parsed.data.paths,
        overwrite: parsed.data.overwrite,
        projectId: parsed.data.projectId ?? null,
      });
      const skills = results.flatMap((result) =>
        result.skill ? [result.skill] : [],
      );
      const failures = results.flatMap((result) =>
        result.error ? [{ path: result.path, message: result.error }] : [],
      );
      if (skills.length === 0) {
        return Response.json(
          {
            error: "invalid_skill",
            message:
              failures[0]?.message ??
              "No skills could be installed from this source.",
            failures,
          },
          { status: 400 },
        );
      }
      return Response.json({ skills, failures }, { status: failures.length ? 207 : 201 });
    }

    const skill = await installSkillFromSource({
      userId: user.id,
      source: parsed.data.source,
      path: parsed.data.path,
      overwrite: parsed.data.overwrite,
      projectId: parsed.data.projectId ?? null,
    });
    return Response.json({ skill }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof Error &&
      (error.name === "SkillValidationError" ||
        error.name === "SkillSecurityError" ||
        /not owned/.test(message))
    ) {
      return Response.json(
        { error: "invalid_skill", message },
        { status: 400 },
      );
    }
    if (isMissingTableError(error)) {
      return Response.json(
        { error: "schema_not_migrated", message: "Run the database migrations." },
        { status: 503 },
      );
    }
    if (isStorageUnavailableError(error)) {
      return Response.json(
        {
          error: "storage_unavailable",
          message:
            "Skill storage is unavailable. Start MinIO with `pnpm infra:up`, run `pnpm storage:init`, or verify the S3 settings.",
        },
        { status: 503 },
      );
    }
    console.error("[POST /api/skills] error:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
