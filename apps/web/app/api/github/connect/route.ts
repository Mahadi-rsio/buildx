import { NextResponse } from "next/server";
import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { oauthAuthorizeUrl } from "@/lib/github/client";
import { githubConfig } from "@/lib/github/config";
import {
  createOAuthState,
  GITHUB_STATE_COOKIE,
  stateCookieOptions,
} from "@/lib/github/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/github/connect` — start GitHub App OAuth. */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) return unauthorized();

  const config = githubConfig();
  if (!config.oauthConfigured || !config.redirectUri) {
    return Response.json(
      {
        error: "github_not_configured",
        message:
          "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (and GITHUB_REDIRECT_URI or BETTER_AUTH_URL) to enable GitHub.",
      },
      { status: 503 },
    );
  }

  const state = createOAuthState();
  const response = NextResponse.redirect(oauthAuthorizeUrl(state));
  response.cookies.set(GITHUB_STATE_COOKIE, state, stateCookieOptions());
  return response;
}
