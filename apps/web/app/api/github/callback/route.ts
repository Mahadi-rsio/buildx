import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/server";
import {
  createInstallationToken,
  getInstallation,
  GitHubApiError,
  listInstallationRepositories,
} from "@/lib/github/client";
import { githubConfig } from "@/lib/github/config";
import { verifySignedState } from "@/lib/github/state";
import { saveGitHubConnection } from "@/lib/github/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectBack(
  request: NextRequest,
  returnTo: string,
  query: string,
): NextResponse {
  const target = new URL(returnTo, request.url);
  target.searchParams.set("github", query === "connected" ? "connected" : "error");
  if (query !== "connected") {
    target.searchParams.set("message", query);
  }
  return NextResponse.redirect(target);
}

/** `GET /api/github/callback` — finish the GitHub App installation. */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  const params = request.nextUrl.searchParams;
  const oauthError = params.get("error");
  if (oauthError) {
    return redirectBack(
      request,
      "/",
      params.get("error_description") || oauthError,
    );
  }

  const stateToken = params.get("state");
  const payload = verifySignedState(stateToken);
  if (!payload || payload.userId !== user.id) {
    return redirectBack(request, "/", "The connection link expired. Try connecting again.");
  }

  const setupAction = params.get("setup_action");
  const installationId = params.get("installation_id");

  if (setupAction === "delete" || !installationId) {
    return redirectBack(request, payload.returnTo, "GitHub installation removed.");
  }

  try {
    const installation = await getInstallation(Number.parseInt(installationId, 10));
    const config = githubConfig();

    if (config.appId && String(installation.app_id) !== config.appId) {
      throw new Error(
        `Installation belongs to app ${installation.app_id}, not ${config.appId}.`,
      );
    }
    if (installation.suspended_at) {
      throw new Error("The GitHub installation is suspended by the account owner.");
    }

    // Mint + probe the installation token; a repo we can actually reach is a
    // stronger "connected" signal than a webhook alone.
    const token = await createInstallationToken(installation.id);
    await listInstallationRepositories(token.token);

    await saveGitHubConnection({
      userId: user.id,
      githubUserId: String(installation.account.id),
      login: installation.account.login,
      name: installation.account.name ?? null,
      avatarUrl: installation.account.avatar_url ?? null,
      installationId: String(installation.id),
    });

    return redirectBack(request, payload.returnTo, "connected");
  } catch (error) {
    const message =
      error instanceof GitHubApiError
        ? `GitHub: ${error.message}`
        : error instanceof Error
          ? error.message
          : "GitHub installation failed.";
    console.error("[github] installation callback failed:", error);
    return redirectBack(request, payload.returnTo, message);
  }
}