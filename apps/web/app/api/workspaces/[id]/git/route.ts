import { z } from "zod";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun, notFound } from "@/lib/authz";
import {
  gitErrorResponse,
  workspaceGit,
} from "@/lib/git";
import { resolveWorkspaceBox, tryGetWorkspaceBox } from "@/lib/sandbox";
import type { GitRepositorySummary } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const pathSchema = z.string().trim().min(1).max(1024);
const branchSchema = z.string().trim().min(1).max(255);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("clone"),
    url: z.string().trim().min(1).max(2048),
    directory: pathSchema.optional(),
  }),
  z.object({
    action: z.literal("create_branch"),
    path: pathSchema,
    branch: branchSchema,
    base: branchSchema,
  }),
  z.object({
    action: z.literal("switch_branch"),
    path: pathSchema,
    branch: branchSchema,
  }),
  z.object({
    action: z.literal("stage_commit"),
    path: pathSchema,
    files: z.array(pathSchema).min(1).max(200),
    message: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal("prepare_pr"),
    path: pathSchema,
    base: branchSchema,
    head: branchSchema,
  }),
]);

function invalid(message: string): Response {
  return Response.json({ error: "invalid_request", message }, { status: 400 });
}

/** `GET /api/workspaces/:id/git?path=` — repository list + summary. */
export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);

  // Read-only: never create or start a box from this route.
  const box = await tryGetWorkspaceBox(run.userId);
  if (!box) {
    return Response.json({ ready: false, repositories: [], repo: null });
  }

  const git = workspaceGit(box);
  const requestedPath = new URL(request.url).searchParams.get("path")?.trim() ?? "";

  try {
    const repositories = await git.listRepositories();
    if (!requestedPath) {
      return Response.json({ ready: true, repositories, repo: null });
    }
    if (!(await git.isRepository(requestedPath))) {
      return Response.json(
        {
          error: "not_a_repository",
          message: `${requestedPath} is not a git repository.`,
        },
        { status: 404 },
      );
    }
    const repo: GitRepositorySummary = await git.getRepository(requestedPath);
    return Response.json({ ready: true, repositories, repo });
  } catch (error) {
    return gitErrorResponse(error);
  }
}

/** `POST /api/workspaces/:id/git` — clone, branches, commits, local PR draft. */
export async function POST(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const run = await findOwnedRun(id, user.id);
  if (!run) return notFound(id);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid("Request body must be JSON.");
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? "invalid request");
  }

  try {
    // Explicit actions may start/resume the user's box.
    const box = await resolveWorkspaceBox({ userId: run.userId });
    const git = workspaceGit(box);
    const action = parsed.data;

    switch (action.action) {
      case "clone": {
        const result = await git.clone(action.url, action.directory);
        return Response.json({ repoPath: result.repoPath, repo: result.repo });
      }
      case "create_branch": {
        const repo = await git.createBranch({
          path: action.path,
          branch: action.branch,
          base: action.base,
        });
        return Response.json({ repo });
      }
      case "switch_branch": {
        const repo = await git.switchBranch({
          path: action.path,
          branch: action.branch,
        });
        return Response.json({ repo });
      }
      case "stage_commit": {
        const result = await git.stageAndCommit({
          path: action.path,
          files: action.files,
          message: action.message,
        });
        return Response.json({ commit: result.commit, repo: result.repo });
      }
      case "prepare_pr": {
        const draft = await git.preparePullRequest({
          path: action.path,
          base: action.base,
          head: action.head,
        });
        return Response.json({ draft });
      }
    }
  } catch (error) {
    return gitErrorResponse(error);
  }
}
