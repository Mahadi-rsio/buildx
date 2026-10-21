import { randomBytes } from "node:crypto";

export const GITHUB_STATE_COOKIE = "buildx_github_oauth_state";
export const GITHUB_STATE_TTL_SECONDS = 600;

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function stateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/api/github",
    maxAge: GITHUB_STATE_TTL_SECONDS,
  };
}
