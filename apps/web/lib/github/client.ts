import { createSign } from "node:crypto";
import { githubConfig } from "./config";

/** A GitHub API failure with enough context for Settings / tool errors. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    type?: string;
    avatar_url?: string | null;
  };
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

const WEB_ORIGIN = process.env.GITHUB_WEB_URL?.replace(/\/+$/, "") ?? "https://github.com";
const API_ORIGIN =
  process.env.GITHUB_API_URL?.replace(/\/+$/, "") ?? "https://api.github.com";

function base64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build a short-lived GitHub App JWT (`iss` must be the App ID). */
export function createAppJwt(nowSeconds = Math.floor(Date.now() / 1000)): string {
  const config = githubConfig();
  if (!config.appId || !config.privateKey) {
    throw new Error("GitHub App ID and private key are not configured.");
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: config.appId,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(normalizePrivateKey(config.privateKey));
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Accept env values with escaped newlines or a base64-encoded PEM. */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim().replace(/\\n/g, "\n");
  if (!key.includes("BEGIN")) {
    try {
      const decoded = Buffer.from(key, "base64").toString("utf8").trim();
      if (decoded.includes("BEGIN")) key = decoded.replace(/\\n/g, "\n");
    } catch {
      // Leave it as-is; createSign will produce a clear error.
    }
  }
  return key.endsWith("\n") ? key : `${key}\n`;
}

export function oauthAuthorizeUrl(state: string): string {
  const config = githubConfig();
  if (!config.clientId || !config.redirectUri) {
    throw new Error("GitHub OAuth is not configured.");
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    allow_signup: "true",
  });
  return `${WEB_ORIGIN}/login/oauth/authorize?${params.toString()}`;
}

async function oauthRequest(body: URLSearchParams): Promise<OAuthTokenResponse> {
  const config = githubConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("GitHub OAuth client credentials are not configured.");
  }
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);
  const response = await fetch(`${WEB_ORIGIN}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  const text = await response.text();
  let parsed: OAuthTokenResponse;
  try {
    parsed = JSON.parse(text) as OAuthTokenResponse;
  } catch {
    throw new GitHubApiError("GitHub returned an invalid OAuth response.", response.status, text);
  }
  if (parsed.error) {
    throw new GitHubApiError(
      parsed.error_description || parsed.error,
      response.status,
      text,
    );
  }
  if (!parsed.access_token) {
    throw new GitHubApiError("GitHub did not return an access token.", response.status, text);
  }
  return parsed;
}

export async function exchangeOAuthCode(code: string): Promise<OAuthTokenResponse> {
  const config = githubConfig();
  if (!config.redirectUri) throw new Error("GitHub OAuth is not configured.");
  return oauthRequest(
    new URLSearchParams({
      code,
      redirect_uri: config.redirectUri,
    }),
  );
}

export async function refreshUserToken(
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  return oauthRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

async function api<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `GitHub API ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // Keep the status-only message.
    }
    throw new GitHubApiError(message, response.status, text);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  return api<GitHubUser>(token, "/user");
}

/** Installations visible to a GitHub App user access token. */
export async function listUserInstallations(
  token: string,
): Promise<GitHubInstallation[]> {
  const body = await api<{ installations?: GitHubInstallation[] }>(
    token,
    "/user/installations?per_page=100",
  );
  return body.installations ?? [];
}

export async function createInstallationToken(
  installationId: number,
): Promise<{ token: string; expires_at: string }> {
  return api<{ token: string; expires_at: string }>(
    createAppJwt(),
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
  );
}
