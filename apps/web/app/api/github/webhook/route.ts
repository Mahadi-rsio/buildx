import { githubConfig } from "@/lib/github/config";
import { updateGitHubInstallation } from "@/lib/github/store";
import { installationChange, verifyGitHubSignature } from "@/lib/github/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `POST /api/github/webhook` — GitHub App installation lifecycle. */
export async function POST(request: Request): Promise<Response> {
  const config = githubConfig();
  if (!config.webhookSecret) {
    return Response.json(
      { error: "webhook_not_configured" },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyGitHubSignature(config.webhookSecret, rawBody, signature)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const change = installationChange(
      request.headers.get("x-github-event") ?? "",
      payload as Parameters<typeof installationChange>[1],
    );
    if (change) await updateGitHubInstallation(change);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[github] webhook handling failed:", error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
