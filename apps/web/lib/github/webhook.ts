import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify `X-Hub-Signature-256` against the raw request body. */
export function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): boolean {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  return (
    provided.length === computed.length &&
    timingSafeEqual(provided, computed)
  );
}

export interface GitHubWebhookPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string; id?: number };
  };
  sender?: { id?: number; login?: string };
  repositories?: Array<{ full_name?: string }>;
}

/** Minimal event handling: keep the Settings installation badge accurate. */
export function installationChange(
  event: string,
  payload: GitHubWebhookPayload,
): { githubUserId?: string; login?: string; installationId: string | null } | null {
  if (event !== "installation") return null;
  const installationId = payload.installation?.id
    ? String(payload.installation.id)
    : null;
  if (!installationId) return null;
  const githubUserId = payload.sender?.id
    ? String(payload.sender.id)
    : undefined;
  const login = payload.installation?.account?.login ?? payload.sender?.login;
  if (payload.action === "created" || payload.action === "unsuspend") {
    return { githubUserId, login, installationId };
  }
  if (payload.action === "deleted" || payload.action === "suspend") {
    return { githubUserId, login, installationId: null };
  }
  return null;
}
