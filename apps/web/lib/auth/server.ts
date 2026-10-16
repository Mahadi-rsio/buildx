import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

/** Server-side session lookup (validates against the database). */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** The signed-in user, or `null` when unauthenticated. */
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/** Thrown by `requireUser()` so API routes can return a proper 401 response. */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Server-side guard for API routes / server actions: throws when there is no
 * valid session. Callers should map `UnauthorizedError` to a 401 (see
 * `unauthorized()`), or wrap the handler.
 */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Guard for server components / pages: redirect unauthenticated users. */
export async function requirePageUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** Standard 401 payload. */
export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
