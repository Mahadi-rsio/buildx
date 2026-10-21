import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/server";
import { exchangeOAuthCode, fetchGitHubUser, listUserInstallations } from "@/lib/github/client";
import {
  GITHUB_STATE_COOKIE,
  stateCookieOptions,
} from "@/lib/github/state";
import { saveGitHubConnection } from "@/lib/github/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function secondsFromNow(seconds: number | undefined): Date | null {
  if (!seconds || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}

function settingsRedirect(request: NextRequest, query: string): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/settings?${query}`, request.url),
  );
  response.cookies.set(GITHUB_STATE_COOKIE, "", {
    ...stateCookieOptions(),
    maxAge: 0,
  });
  return response;
}

/** `GET /api/github/callback` — finish GitHub App OAuth. */
export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser(request.headers);
  if (!user) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  const params = request.nextUrl.searchParams;
  const oauthError = params.get("error");
  if (oauthError) {
    return settingsRedirect(
      request,
      `github=error&message=${encodeURIComponent(
        params.get("error_description") || oauthError,
      )}`,
    );
  }

  const code = params.get("code");
  const state = params.get("state");
  const expectedState = request.cookies.get(GITHUB_STATE_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return settingsRedirect(
      request,
      "github=error&message=Invalid%20OAuth%20state.%20Try%20connecting%20again.",
    );
  }

  try {
    const token = await exchangeOAuthCode(code);
    const githubUser = await fetchGitHubUser(token.access_token);

    let installationId: string | null = null;
    try {
      const installations = await listUserInstallations(token.access_token);
      installationId = installations[0] ? String(installations[0].id) : null;
    } catch (error) {
      // A GitHub App with no installation yet still connects; the Settings UI
      // will offer the install link.
      console.warn(`[github] could not list installations: ${String(error)}`);
    }

    await saveGitHubConnection({
      userId: user.id,
      githubUserId: String(githubUser.id),
      login: githubUser.login,
      name: githubUser.name,
      avatarUrl: githubUser.avatar_url,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      accessTokenExpiresAt: secondsFromNow(token.expires_in),
      refreshTokenExpiresAt: secondsFromNow(token.refresh_token_expires_in),
      scope: token.scope ?? null,
      installationId,
    });

    return settingsRedirect(request, "github=connected");
  } catch (error) {
    console.error("[github] OAuth callback failed:", error);
    const message =
      error instanceof Error ? error.message : "GitHub authorization failed.";
    return settingsRedirect(
      request,
      `github=error&message=${encodeURIComponent(message)}`,
    );
  }
}
