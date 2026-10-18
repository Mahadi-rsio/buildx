import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { loadRootEnv } from "@buildx/shared/node";
import { getDb, schema } from "@buildx/db";

loadRootEnv();

/**
 * Auth configuration. `BETTER_AUTH_SECRET` is mandatory — refuse to boot rather
 * than run with a weak/derived secret. Generate one with `openssl rand -base64 32`.
 */
const secret = process.env.BETTER_AUTH_SECRET?.trim();
if (!secret) {
  throw new Error(
    "BETTER_AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` and add it to .env",
  );
}

const baseURL = process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000";

export const auth = betterAuth({
  secret,
  baseURL,
  database: drizzleAdapter(getDb(), { provider: "pg", schema }),
  trustedOrigins: [baseURL, "https://buildx.rsioex.workers.dev", "https://buildx.rsioex.workers.dev/api/auth"],

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },

  // Brute-force protection on auth endpoints. Better Auth only counts
  // user-initiated requests, and disables limiting by default in development, so
  // enable it explicitly.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily
  },

  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  },

  // Required by Better Auth for Next.js server actions / route handlers to set
  // cookies. Must be the last plugin.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;