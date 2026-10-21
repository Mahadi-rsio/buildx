import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, signed state for the GitHub App installation flow. GitHub's
 * install redirect only reliably carries query parameters back to the setup
 * URL, so the return destination and the user id are embedded in an HMAC
 * signature instead of a server-side session. A state token is single-use in
 * effect: it expires after `GITHUB_STATE_TTL_SECONDS` and is tied to the
 * BuildX user that started the flow.
 */

export const GITHUB_STATE_TTL_SECONDS = 600;

let cachedKey: string | undefined;

function stateKey(): string {
  const secret = (
    process.env.GITHUB_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET
  )?.trim();
  if (!secret) {
    throw new Error(
      "GITHUB_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) must be set to connect GitHub",
    );
  }
  cachedKey ??= secret;
  return cachedKey;
}

export interface GitHubStatePayload {
  userId: string;
  returnTo: string;
  exp: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Sign the payload with an HMAC-SHA256 tag derived from the app secret. */
export function createSignedState(userId: string, returnTo: string): string {
  const payload = JSON.stringify({
    userId,
    returnTo,
    exp: nowSeconds() + GITHUB_STATE_TTL_SECONDS,
    nonce: randomBytes(8).toString("base64url"),
  });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = createHmac("sha256", stateKey())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

/** Verify signature + expiry and return the embedded payload, or `null`. */
export function verifySignedState(token: string | null | undefined): GitHubStatePayload | null {
  if (!token) return null;
  try {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return null;
    const expected = createHmac("sha256", stateKey())
      .update(encoded)
      .digest("base64url");
    const provided = Buffer.from(signature, "utf8");
    const computed = Buffer.from(expected, "utf8");
    if (
      provided.length !== computed.length ||
      !timingSafeEqual(provided, computed)
    ) {
      return null;
    }
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as Partial<GitHubStatePayload>;
    if (
      typeof payload.userId !== "string" ||
      typeof payload.returnTo !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp < nowSeconds()) return null;
    return {
      userId: payload.userId,
      returnTo: payload.returnTo,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Keep a return destination same-origin and safe to redirect to. Only a
 * relative path (no protocol-relative `//`, backslash, or control characters)
 * is accepted; anything else falls back to the shell root.
 */
export function sanitizeReturnTo(value: string | null | undefined): string {
  const raw = value?.trim() ?? "";
  if (
    raw.startsWith("/") &&
    !raw.startsWith("//") &&
    !raw.includes("\\") &&
    !/[\r\n\0]/.test(raw)
  ) {
    return raw.slice(0, 500);
  }
  return "/";
}