/**
 * GitHub App configuration. OAuth (connect + user tokens) and App auth
 * (installation tokens + webhook) are configured independently so a dev app
 * without a private key can still be tested through OAuth.
 */

function value(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export interface GitHubConfig {
  appId?: string;
  clientId?: string;
  clientSecret?: string;
  privateKey?: string;
  webhookSecret?: string;
  appSlug?: string;
  redirectUri?: string;
  /** OAuth can start and complete. */
  oauthConfigured: boolean;
  /** App JWT / installation tokens / real webhooks can be verified. */
  appConfigured: boolean;
}

export function githubConfig(): GitHubConfig {
  const appId = value("GITHUB_APP_ID");
  const clientId = value("GITHUB_CLIENT_ID");
  const clientSecret = value("GITHUB_CLIENT_SECRET");
  const privateKey = value("GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = value("GITHUB_WEBHOOK_SECRET");
  const appSlug = value("GITHUB_APP_SLUG");
  const baseUrl = value("BETTER_AUTH_URL")?.replace(/\/+$/, "");
  const redirectUri =
    value("GITHUB_REDIRECT_URI") ??
    (baseUrl ? `${baseUrl}/api/github/callback` : undefined);

  return {
    appId,
    clientId,
    clientSecret,
    privateKey,
    webhookSecret,
    appSlug,
    redirectUri,
    oauthConfigured: Boolean(clientId && clientSecret),
    appConfigured: Boolean(appId && privateKey),
  };
}

export function githubInstallUrl(slug = githubConfig().appSlug): string | undefined {
  if (!slug) return undefined;
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
