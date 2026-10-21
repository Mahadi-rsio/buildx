import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import {
  createInstallationToken,
  GitHubApiError,
  listInstallationRepositories,
} from "@/lib/github/client";
import { findGitHubConnection, toGitHubConnectionView } from "@/lib/github/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/github/repositories` — connection status + account + repos. */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const row = await findGitHubConnection(user.id);
  const view = toGitHubConnectionView(row);

  if (!row || !row.installationId || !view.connected) {
    return NextResponse.json({
      connected: false,
      configured: view.configured,
      installUrl: view.installUrl,
    });
  }

  try {
    const installationId = Number.parseInt(row.installationId, 10);
    const created = await createInstallationToken(installationId);
    const repositories = await listInstallationRepositories(created.token);
    return NextResponse.json({
      connected: true,
      configured: view.configured,
      account: {
        login: row.login,
        name: row.name,
        avatarUrl: row.avatarUrl,
        installationId: row.installationId,
      },
      repositories: repositories.map((repository) => ({
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
        defaultBranch: repository.default_branch,
      })),
    });
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
      return NextResponse.json(
        {
          error: "revoked",
          message: "The GitHub installation is no longer accessible.",
        },
        { status: 403 },
      );
    }
    throw error;
  }
}