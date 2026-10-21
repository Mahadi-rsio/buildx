/**
 * GitHub App configuration. Access is installation-based: the App's private
 * key mints a JWT, the JWT mints short-lived installation access tokens, and
 * those tokens drive repository operations. OAuth user tokens are gone.
 */

function value(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export interface GitHubConfig {
  appId?: string;
  privateKey?: string;
  webhookSecret?: string;
  appSlug?: string;
  /** App JWT / installation tokens / real webhooks can be verified. */
  appConfigured: boolean;
  /** App id, private key, and slug are all present (needed to install). */
  installConfigured: boolean;
}

export function githubConfig(): GitHubConfig {
  const appId = value("GITHUB_APP_ID");
  const privateKey = value("GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = value("GITHUB_WEBHOOK_SECRET");
  const appSlug = value("GITHUB_APP_SLUG");

  return {
    appId,
    privateKey,
    webhookSecret,
    appSlug,
    appConfigured: Boolean(appId && privateKey),
    installConfigured: Boolean(appId && privateKey && appSlug),
  };
}

/** Which GitHub App settings are still missing (for setup guidance). */
export function githubAppStatus(): { configured: boolean; missing: string[] } {
  const config = githubConfig();
  const missing: string[] = [];
  if (!config.appId) missing.push("GITHUB_APP_ID");
  if (!config.privateKey) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (!config.appSlug) missing.push("GITHUB_APP_SLUG");
  return { configured: missing.length === 0, missing };
}

/** The GitHub App installation page for the configured slug. */
export function githubInstallUrl(slug = githubConfig().appSlug): string | undefined {
  if (!slug) return undefined;
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}