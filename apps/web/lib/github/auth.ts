import { githubConfig } from "./config";
import {
  createInstallationToken,
  GitHubApiError,
  listUserInstallations,
  refreshUserToken,
} from "./client";
import {
  findGitHubConnection,
  readAccessToken,
  readRefreshToken,
  updateGitHubTokens,
} from "./store";

export interface GitHubToolAuth {
  /** Bearer token for the GitHub REST API. */
  token: string;
  /** Git HTTPS username; installation tokens use `x-access-token`. */
  username: string;
  /** Authenticated GitHub login. */
  login: string;
  installationId?: string;
}

export class GitHubReconnectError extends Error {
  constructor(message = "GitHub authorization expired. Reconnect GitHub in Settings.") {
    super(message);
    this.name = "GitHubReconnectError";
  }
}

const EXPIRY_SKEW_MS = 60_000;

function expiresAt(seconds: number | undefined): Date | null {
  if (!seconds || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}

async function currentAccessToken(userId: string): Promise<{
  token: string;
  login: string;
  githubUserId: string;
}> {
  const row = await findGitHubConnection(userId);
  if (!row) {
    throw new GitHubReconnectError(
      "GitHub is not connected. Connect it in Settings before opening a pull request.",
    );
  }

  const expiring =
    row.accessTokenExpiresAt &&
    row.accessTokenExpiresAt.getTime() <= Date.now() + EXPIRY_SKEW_MS;
  if (!expiring) {
    return {
      token: readAccessToken(row),
      login: row.login,
      githubUserId: row.githubUserId,
    };
  }

  const refreshToken = readRefreshToken(row);
  if (!refreshToken) {
    throw new GitHubReconnectError(
      "GitHub authorization expired. Reconnect GitHub in Settings.",
    );
  }

  try {
    const refreshed = await refreshUserToken(refreshToken);
    await updateGitHubTokens(userId, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? refreshToken,
      accessTokenExpiresAt: expiresAt(refreshed.expires_in),
      refreshTokenExpiresAt: expiresAt(refreshed.refresh_token_expires_in),
      scope: refreshed.scope ?? row.scope,
    });
    return {
      token: refreshed.access_token,
      login: row.login,
      githubUserId: row.githubUserId,
    };
  } catch (error) {
    if (error instanceof GitHubApiError) {
      throw new GitHubReconnectError(
        "GitHub authorization expired. Reconnect GitHub in Settings.",
      );
    }
    throw error;
  }
}

/**
 * Resolve GitHub credentials for a tool call. When an owner is known and the
 * App has a private key, prefer an installation token scoped to that account;
 * otherwise use the user access token.
 */
export async function getGitHubToolAuth(
  userId: string,
  owner?: string,
): Promise<GitHubToolAuth> {
  const { token, login } = await currentAccessToken(userId);
  const config = githubConfig();

  if (owner && config.appConfigured) {
    try {
      const installations = await listUserInstallations(token);
      const installation = installations.find(
        (item) => item.account.login.toLowerCase() === owner.toLowerCase(),
      );
      if (installation) {
        const created = await createInstallationToken(installation.id);
        return {
          token: created.token,
          username: "x-access-token",
          login,
          installationId: String(installation.id),
        };
      }
    } catch (error) {
      // The user token remains valid across installations the user can access;
      // fall through instead of failing the publish on an App permissions issue.
      console.warn(`[github] installation token unavailable: ${String(error)}`);
    }
  }

  return { token, username: login, login };
}
