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

export interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    id: number;
    type?: string;
    name?: string | null;
    avatar_url?: string | null;
  };
  app_id: number;
  suspended_at: string | null;
  permissions?: Record<string, string>;
  html_url?: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  owner: { login: string; type?: string };
  permissions?: Record<string, string>;
}

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

/** Fetch one installation by id using the App JWT. */
export async function getInstallation(
  installationId: number,
): Promise<GitHubInstallation> {
  return api<GitHubInstallation>(
    createAppJwt(),
    `/app/installations/${installationId}`,
  );
}

/** Mint a short-lived installation access token from the App JWT. */
export async function createInstallationToken(
  installationId: number,
): Promise<{ token: string; expires_at: string }> {
  return api<{ token: string; expires_at: string }>(
    createAppJwt(),
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
  );
}

/** Repositories the installation can access, via its access token. */
export async function listInstallationRepositories(
  token: string,
): Promise<GitHubRepository[]> {
  const body = await api<{ repositories?: GitHubRepository[] }>(
    token,
    "/installation/repositories?per_page=100",
  );
  return body.repositories ?? [];
}