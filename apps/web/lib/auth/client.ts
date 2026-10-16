"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client. Same-origin by default, so it talks to the route handler
 * mounted at `/api/auth/*` below.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
