import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/auth";

/**
 * Better Auth handler. Mounts every endpoint under `/api/auth/*`
 * (sign-in, sign-up, sign-out, OAuth callbacks, session, …).
 */
export const { GET, POST } = toNextJsHandler(auth);
