import { getCurrentUser, unauthorized } from "@/lib/auth/server";
import { findOwnedRun } from "@/lib/authz";
import { createStorage } from "@buildx/storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/artifacts/...key
 * Serves artifacts, build outputs, and archives stored in R2.
 * Uses the S3-compatible SDK via @buildx/storage.
 * Strictly enforces user ownership and authorization.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const { key: keyParts } = await params;
  const key = keyParts.join("/");

  // Reject path traversal attempts
  if (key.includes("..") || key.startsWith("/")) {
    return new Response(JSON.stringify({ error: "Invalid artifact key" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Authorization enforcement:
  // Key format pattern 1: users/<userId>/...
  // Key format pattern 2: runs/<runId>/...
  // Key format pattern 3: <runId>/...
  let authorized = false;

  if (key.startsWith(`users/${user.id}/`)) {
    authorized = true;
  } else {
    // Check if the key references a run owned by the user
    const runMatch = key.match(/(?:^|\/)?runs\/([0-9a-fA-F-]+)/) || key.match(/^([0-9a-fA-F-]{36})/);
    if (runMatch) {
      const runId = runMatch[1];
      const owned = await findOwnedRun(runId, user.id);
      if (owned) authorized = true;
    }
  }

  if (!authorized) {
    return new Response(
      JSON.stringify({ error: "Forbidden: You do not own this artifact" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Serve via S3-compatible storage client (R2)
  try {
    const storage = createStorage();
    const info = await storage.head(key);
    if (!info) {
      return new Response(JSON.stringify({ error: "Artifact not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const presignedUrl = await storage.presignGet(key, { expiresIn: 300 });
    return Response.redirect(presignedUrl, 302);
  } catch (error) {
    console.error(`[artifacts] error retrieving ${key} via storage client`, error);
    return new Response(JSON.stringify({ error: "Artifact unavailable" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}
