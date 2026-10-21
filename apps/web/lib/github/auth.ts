import { createInstallationToken } from "./client";
import { findGitHubConnection } from "./store";

export interface GitHubToolAuth {
  /** Bearer token for the GitHub REST API / git credential helper. */
  token: string;
  /** Git HTTPS username; installation tokens use `x-access-token`. */
  username: string;
  /** Account the installation was made on. */
  login: string;
  installationId?: string;
}

export class GitHubReconnectError extends Error {
  constructor(message = "GitHub is not connected. Connect the GitHub App in the Git tab.") {
    super(message);
    this.name = "GitHubReconnectError";
  }
}

/**
 * Resolve GitHub credentials for a tool call from the user's stored
 * installation. Installation access tokens are short-lived and minted on
 * demand; no user access token is stored. Publishing is only possible for the
 * account the App was installed on.
 */
export async function getGitHubToolAuth(
  userId: string,
  owner?: string,
): Promise<GitHubToolAuth> {
  const row = await findGitHubConnection(userId);
  if (!row || !row.installationId) {
    throw new GitHubReconnectError(
      "GitHub is not connected. Connect the GitHub App in the Git tab before publishing a pull request.",
    );
  }

  const login = row.login;
  if (owner && owner.toLowerCase() !== login.toLowerCase()) {
    throw new GitHubReconnectError(
      `The GitHub App is installed on ${login}, not ${owner}. Install the app on ${owner} to publish there.`,
    );
  }

  const installationId = Number.parseInt(row.installationId, 10);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new GitHubReconnectError("The stored GitHub installation id is invalid.");
  }

  const created = await createInstallationToken(installationId);
  return {
    token: created.token,
    username: "x-access-token",
    login,
    installationId: row.installationId,
  };
}