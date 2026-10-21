import { eq, getDb, githubConnections, or } from "@buildx/db";
import { githubConfig, githubInstallUrl } from "./config";
import { decryptToken, encryptToken } from "./crypto";

export type GitHubConnectionRow = typeof githubConnections.$inferSelect;

export interface GitHubConnectionView {
  configured: boolean;
  connected: boolean;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  installationId: string | null;
  installUrl: string | null;
  connectedAt: string | null;
}

export async function findGitHubConnection(
  userId: string,
): Promise<GitHubConnectionRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.userId, userId));
  return row;
}

export async function saveGitHubConnection(input: {
  userId: string;
  githubUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
  scope?: string | null;
  installationId?: string | null;
}): Promise<GitHubConnectionRow> {
  const values = {
    userId: input.userId,
    githubUserId: input.githubUserId,
    login: input.login,
    name: input.name,
    avatarUrl: input.avatarUrl,
    accessTokenEncrypted: encryptToken(input.accessToken),
    refreshTokenEncrypted: input.refreshToken
      ? encryptToken(input.refreshToken)
      : null,
    accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
    scope: input.scope ?? null,
    installationId: input.installationId ?? null,
    updatedAt: new Date(),
  };
  const [row] = await getDb()
    .insert(githubConnections)
    .values(values)
    .onConflictDoUpdate({
      target: githubConnections.userId,
      set: {
        githubUserId: values.githubUserId,
        login: values.login,
        name: values.name,
        avatarUrl: values.avatarUrl,
        accessTokenEncrypted: values.accessTokenEncrypted,
        refreshTokenEncrypted: values.refreshTokenEncrypted,
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        refreshTokenExpiresAt: values.refreshTokenExpiresAt,
        scope: values.scope,
        installationId: values.installationId,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  return row;
}

export async function updateGitHubTokens(
  userId: string,
  input: {
    accessToken: string;
    refreshToken?: string | null;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    scope?: string | null;
  },
): Promise<void> {
  await getDb()
    .update(githubConnections)
    .set({
      accessTokenEncrypted: encryptToken(input.accessToken),
      ...(input.refreshToken !== undefined
        ? {
            refreshTokenEncrypted: input.refreshToken
              ? encryptToken(input.refreshToken)
              : null,
          }
        : {}),
      accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
      scope: input.scope ?? null,
      updatedAt: new Date(),
    })
    .where(eq(githubConnections.userId, userId));
}

export async function updateGitHubInstallation(
  input: { githubUserId?: string; login?: string; installationId: string | null },
): Promise<void> {
  const matches = [
    ...(input.githubUserId
      ? [eq(githubConnections.githubUserId, input.githubUserId)]
      : []),
    ...(input.login ? [eq(githubConnections.login, input.login)] : []),
  ];
  if (matches.length === 0) return;
  await getDb()
    .update(githubConnections)
    .set({ installationId: input.installationId, updatedAt: new Date() })
    .where(matches.length === 1 ? matches[0] : or(...matches));
}

export async function deleteGitHubConnection(userId: string): Promise<void> {
  await getDb()
    .delete(githubConnections)
    .where(eq(githubConnections.userId, userId));
}

export function readAccessToken(row: GitHubConnectionRow): string {
  return decryptToken(row.accessTokenEncrypted);
}

export function readRefreshToken(row: GitHubConnectionRow): string | null {
  return row.refreshTokenEncrypted
    ? decryptToken(row.refreshTokenEncrypted)
    : null;
}

export function toGitHubConnectionView(
  row: GitHubConnectionRow | undefined,
): GitHubConnectionView {
  const config = githubConfig();
  const connected = Boolean(row);
  return {
    configured: config.oauthConfigured,
    connected,
    login: row?.login ?? null,
    name: row?.name ?? null,
    avatarUrl: row?.avatarUrl ?? null,
    installationId: row?.installationId ?? null,
    installUrl: connected ? (githubInstallUrl(config.appSlug) ?? null) : null,
    connectedAt: row?.createdAt.toISOString() ?? null,
  };
}
