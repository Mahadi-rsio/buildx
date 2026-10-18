import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const SIGN_IN = "/sign-in";
const SIGN_UP = "/sign-up";
const PUBLIC_AUTH_PATHS = new Set([SIGN_IN, SIGN_UP]);

/**
 * Node proxy (Next.js 16's replacement for `middleware.ts`).
 *
 * This only does an *optimistic* redirect based on the presence of the session
 * cookie — it deliberately does not hit the database on every request. Real
 * enforcement lives server-side in `requireUser()` / `requirePageUser()`.
 * Better Auth docs recommend exactly this split.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(getSessionCookie(request));

  // Public auth pages are always reachable.
  if (PUBLIC_AUTH_PATHS.has(pathname)) return NextResponse.next();

  if (hasSession) return NextResponse.next();

  // API callers get a JSON 401 rather than an HTML redirect.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(SIGN_IN, request.url);
  if (pathname !== "/") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/",
    "/runs/:path*",
    "/api/runs/:path*",
    "/api/workspaces/:path*",
    "/sign-in",
    "/sign-up",
  ],
};
