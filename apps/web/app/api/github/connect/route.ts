import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { githubConfig, githubInstallUrl } from "@/lib/github/config";
import { createSignedState, sanitizeReturnTo } from "@/lib/github/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/github/connect` — start the GitHub App installation flow. */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const config = githubConfig();
  const installUrl = githubInstallUrl(config.appSlug);
  if (!config.installConfigured || !installUrl) {
    return Response.json(
      {
        error: "github_not_configured",
        message:
          "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_SLUG to enable GitHub.",
      },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));
  const state = createSignedState(user.id, returnTo);

  const redirectUrl = new URL(installUrl);
  redirectUrl.searchParams.set("state", state);
  return NextResponse.redirect(redirectUrl);
}