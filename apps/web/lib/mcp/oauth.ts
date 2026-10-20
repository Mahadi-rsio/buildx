/**
 * Generic OAuth 2.0 Authorization Code + PKCE engine for catalog servers.
 *
 * Every provider goes through the same flow: the start route generates a PKCE
 * verifier, stores it in an encrypted HttpOnly cookie, and redirects to the
 * provider's authorization endpoint. The callback route exchanges the
 * authorization code (with the verifier) at the token endpoint and persists the
 * returned access token as a `Bearer` header. Client ids/secrets come from
 * `MCP_OAUTH_<PROVIDER>_CLIENT_ID` / `MCP_OAUTH_<PROVIDER>_CLIENT_SECRET`.
 *
 * The exchange uses the real token endpoint via `fetch`; `exchangeCode` accepts
 * an injectable fetcher so tests can mock it.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { McpCatalogEntry, McpOAuthConfig } from "@buildx/shared";
import { decryptJson, encryptJson } from "./crypto";

/** RFC 7636 code_verifier charset: unreserved characters, 43–128 chars. */
const VERIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generatePkceVerifier(length = 64): string {
  const bytes = randomBytes(length);
  let verifier = "";
  for (const byte of bytes) {
    verifier += VERIFIER_CHARS[byte % VERIFIER_CHARS.length];
  }
  return verifier;
}

/** RFC 7636 S256 code_challenge derived from a verifier. */
export function codeChallenge(verifier: string): string {
  const digest = createHash("sha256").update(verifier).digest();
  return Buffer.from(digest).toString("base64url").replace(/=+$/, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(length?: number): PkcePair {
  const verifier = generatePkceVerifier(length);
  return { verifier, challenge: codeChallenge(verifier) };
}

/** Env helper: `MCP_OAUTH_<PROVIDER>_CLIENT_ID` (uppercased, dashes → _). */
export function oauthEnvKeys(provider: string): {
  clientIdVar: string;
  clientSecretVar: string;
} {
  const key = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    clientIdVar: `MCP_OAUTH_${key}_CLIENT_ID`,
    clientSecretVar: `MCP_OAUTH_${key}_CLIENT_SECRET`,
  };
}

/** True when the provider's client credentials are present in the environment. */
export function oauthConfigured(
  config: McpOAuthConfig,
  source: Record<string, string | undefined> = process.env,
): boolean {
  const { clientIdVar, clientSecretVar } = oauthEnvKeys(config.provider);
  return Boolean((source[clientIdVar] ?? "").trim() && (source[clientSecretVar] ?? "").trim());
}

export interface OAuthStartParams {
  entry: McpCatalogEntry;
  oauth: McpOAuthConfig;
  state: string;
  pkce: PkcePair;
  redirectUri: string;
}

/** Build the provider authorization URL with PKCE params. */
export function buildAuthorizationUrl(params: OAuthStartParams): string {
  const url = new URL(params.oauth.authorizationUrl);
  url.searchParams.set("client_id", oauthClientId(params.oauth));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.oauth.scopes.length > 0) {
    url.searchParams.set("scope", params.oauth.scopes.join(" "));
  }
  return url.toString();
}

/** Resolve the provider's client id (env-configured, throws when missing). */
export function oauthClientId(
  config: McpOAuthConfig,
  source: Record<string, string | undefined> = process.env,
): string {
  const { clientIdVar } = oauthEnvKeys(config.provider);
  const clientId = (source[clientIdVar] ?? "").trim();
  if (!clientId) {
    throw new Error(
      `${clientIdVar} is not set — configure the provider's OAuth app to enable sign-in.`,
    );
  }
  return clientId;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresInSeconds?: number;
  scope?: string;
}

export interface ExchangeCodeOptions {
  oauth: McpOAuthConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** Injectable fetcher for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class OAuthTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

/**
 * Exchange an authorization code for an access token. PKCE's `code_verifier`
 * is required, so a stolen code without the cookie is useless. Throws
 * `OAuthTokenError` with a user-facing message on any failure.
 */
export async function exchangeAuthorizationCode(
  options: ExchangeCodeOptions,
): Promise<TokenResponse> {
  const { clientSecretVar } = oauthEnvKeys(options.oauth.provider);
  const clientId = oauthClientId(options.oauth);
  const clientSecret = (process.env[clientSecretVar] ?? "").trim();
  if (!clientSecret) {
    throw new OAuthTokenError(
      `${clientSecretVar} is not set — configure the provider's OAuth app to enable sign-in.`,
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: options.codeVerifier,
  });

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new OAuthTokenError(
      `Token request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  if (!response.ok) {
    const description =
      payload && typeof payload.error_description === "string"
        ? (payload.error_description as string)
        : payload && typeof payload.error === "string"
          ? (payload.error as string)
          : `HTTP ${response.status}`;
    throw new OAuthTokenError(`OAuth token exchange failed: ${description}`);
  }

  const accessToken = payload?.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthTokenError("OAuth token exchange returned no access_token");
  }

  return {
    accessToken,
    tokenType:
      typeof payload?.token_type === "string" ? payload.token_type : "Bearer",
    expiresInSeconds:
      typeof payload?.expires_in === "number" ? payload.expires_in : undefined,
    scope: typeof payload?.scope === "string" ? payload.scope : undefined,
  };
}

export interface OAuthSession {
  catalogId: string;
  verifier: string;
  createdAt: number;
}

/**
 * Cookie payload for the in-flight OAuth session. Encrypted+authenticated by
 * `crypto.encryptJson` (AES-256-GCM), so a tampered verifier or catalog id
 * cannot be swapped in by an attacker.
 */
export function oauthSessionToCookie(session: OAuthSession): string {
  return encryptJsonForCookie(session);
}

export function oauthSessionFromCookie(value: string): OAuthSession {
  const parsed = decryptJsonFromCookie<OAuthSession>(value);
  if (!parsed || typeof parsed.catalogId !== "string" || typeof parsed.verifier !== "string") {
    throw new Error("Invalid OAuth session cookie");
  }
  return parsed;
}

// The cookie value goes through the same AES-256-GCM layer as MCP headers but
// base64url-encoded so it is safe to store in an HttpOnly cookie.
function encryptJsonForCookie(value: unknown): string {
  return Buffer.from(encryptJson(value), "utf8").toString("base64url");
}

function decryptJsonFromCookie<T>(value: string): T {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return decryptJson<T>(decoded);
}

/** Fresh random state parameter for CSRF protection on the callback. */
export function generateOAuthState(): string {
  return randomUUID();
}