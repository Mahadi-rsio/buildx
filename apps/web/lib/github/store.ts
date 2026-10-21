import { eq, getDb, githubConnections, or } from "@buildx/db";
import { githubConfig, githubInstallUrl } from "./config";

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

/** Associate a verified GitHub App installation with a BuildX user. */
export async function saveGitHubConnection(input: {
  userId: string;
  githubUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  installationId: string;
}): Promise<GitHubConnectionRow> {
  const values = {
    userId: input.userId,
    githubUserId: input.githubUserId,
    login: input.login,
    name: input.name,
    avatarUrl: input.avatarUrl,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    installationId: input.installationId,
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
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
        installationId: values.installationId,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  return row;
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

export function toGitHubConnectionView(
  row: GitHubConnectionRow | undefined,
): GitHubConnectionView {
  const config = githubConfig();
  const connected = Boolean(row && row.installationId);
  return {
    configured: config.appConfigured,
    connected,
    login: row?.login ?? null,
    name: row?.name ?? null,
    avatarUrl: row?.avatarUrl ?? null,
    installationId: row?.installationId ?? null,
    installUrl: githubInstallUrl(config.appSlug) ?? null,
    connectedAt: row?.createdAt.toISOString() ?? null,
  };
}