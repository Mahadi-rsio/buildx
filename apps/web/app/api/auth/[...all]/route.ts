import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/auth";

/**
 * Better Auth handler. Mounts every endpoint under `/api/auth/*`
 * (sign-in, sign-up, sign-out, OAuth callbacks, session, …).
 *
 * Auth is instantiated lazily on first request so the module can be imported
 * during build-time page-data collection without failing on a missing
 * `BETTER_AUTH_SECRET`.
 */
async function handler(request: Request): Promise<Response> {
  const auth = await getAuth();
  return toNextJsHandler(auth)[request.method === "POST" ? "POST" : "GET"](
    request,
  );
}

export async function GET(request: Request): Promise<Response> {
  return handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
