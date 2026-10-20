import { and, eq } from "drizzle-orm";
import type { Db } from "./client";
import {
  projects,
  skillInstallations,
  skills,
  type SkillInstallState,
} from "./schema";

export type SkillRow = typeof skills.$inferSelect;
export type SkillInstallationRow = typeof skillInstallations.$inferSelect;

export interface CatalogSkillInput {
  name: string;
  description: string;
  source: string;
  sourceKind: "github" | "url" | "archive";
  resolvedRef: string;
  digest: string;
  artifactKey: string;
  fileCount: number;
  totalBytes: number;
}

export type SkillScope =
  | { kind: "user" }
  | { kind: "project"; projectId: string };

export function skillScopeKey(userId: string, scope: SkillScope): string {
  return scope.kind === "user" ? `user:${userId}` : `project:${scope.projectId}`;
}

/** Create or refresh the immutable catalog entry for a content digest. */
export async function upsertCatalogSkill(
  db: Db,
  input: CatalogSkillInput,
): Promise<SkillRow> {
  const [row] = await db
    .insert(skills)
    .values(input)
    .onConflictDoUpdate({
      target: skills.digest,
      set: {
        description: input.description,
        source: input.source,
        sourceKind: input.sourceKind,
        resolvedRef: input.resolvedRef,
        artifactKey: input.artifactKey,
        fileCount: input.fileCount,
        totalBytes: input.totalBytes,
      },
    })
    .returning();
  return row;
}

/** Verify the caller owns the project before writing or reading project scope. */
export async function assertProjectOwner(
  db: Db,
  userId: string,
  projectId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!row) throw new Error("project not found or not owned by this user");
}

/**
 * Idempotently install a catalog skill in a user or project scope. Re-installing
 * the same name replaces the previous version in place; a different user or
 * project can never overwrite another scope because the key is derived from the
 * authenticated owner, not from request input.
 */
export async function installSkill(
  db: Db,
  input: {
    userId: string;
    scope: SkillScope;
    catalog: CatalogSkillInput;
    state?: SkillInstallState;
  },
): Promise<SkillInstallationRow> {
  if (input.scope.kind === "project") {
    await assertProjectOwner(db, input.userId, input.scope.projectId);
  }
  const catalog = await upsertCatalogSkill(db, input.catalog);
  const scopeKey = skillScopeKey(input.userId, input.scope);
  const [row] = await db
    .insert(skillInstallations)
    .values({
      userId: input.userId,
      projectId: input.scope.kind === "project" ? input.scope.projectId : null,
      skillId: catalog.id,
      name: catalog.name,
      scopeKey,
      state: input.state ?? "installed",
    })
    .onConflictDoUpdate({
      target: [skillInstallations.scopeKey, skillInstallations.name],
      set: {
        skillId: catalog.id,
        state: input.state ?? "installed",
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Mark an in-progress installation failed without exposing it to the runtime. */
export async function failSkillInstallation(
  db: Db,
  input: { userId: string; scope: SkillScope; name: string; error: string },
): Promise<void> {
  const scopeKey = skillScopeKey(input.userId, input.scope);
  await db
    .update(skillInstallations)
    .set({ state: "failed", lastError: input.error.slice(0, 2000), updatedAt: new Date() })
    .where(
      and(
        eq(skillInstallations.scopeKey, scopeKey),
        eq(skillInstallations.name, input.name),
      ),
    );
}

export interface InstalledSkill {
  installationId: string;
  state: SkillInstallState;
  skill: SkillRow;
}

/** List installed skills for a scope. Failed/running installs are excluded. */
export async function listInstalledSkills(
  db: Db,
  input: { userId: string; scope: SkillScope },
): Promise<InstalledSkill[]> {
  if (input.scope.kind === "project") {
    await assertProjectOwner(db, input.userId, input.scope.projectId);
  }
  const rows = await db
    .select({
      installationId: skillInstallations.id,
      state: skillInstallations.state,
      skill: skills,
    })
    .from(skillInstallations)
    .innerJoin(skills, eq(skillInstallations.skillId, skills.id))
    .where(
      and(
        eq(skillInstallations.userId, input.userId),
        eq(skillInstallations.scopeKey, skillScopeKey(input.userId, input.scope)),
        eq(skillInstallations.state, "installed"),
      ),
    )
    .orderBy(skillInstallations.name);
  return rows;
}

/**
 * Load runtime-visible skills. User-scoped installs always apply; project scope
 * is layered on top and can override a same-named user skill for that project.
 */
export async function listRuntimeSkills(
  db: Db,
  input: { userId: string; projectId?: string | null },
): Promise<InstalledSkill[]> {
  const userSkills = await listInstalledSkills(db, {
    userId: input.userId,
    scope: { kind: "user" },
  });
  if (!input.projectId) return userSkills;
  const projectSkills = await listInstalledSkills(db, {
    userId: input.userId,
    scope: { kind: "project", projectId: input.projectId },
  });
  const byName = new Map(userSkills.map((row) => [row.skill.name, row]));
  for (const row of projectSkills) byName.set(row.skill.name, row);
  return [...byName.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name));
}

/** Uninstall by installation id; scoped to the authenticated user. */
export async function uninstallSkill(
  db: Db,
  input: { userId: string; installationId: string },
): Promise<boolean> {
  const rows = await db
    .delete(skillInstallations)
    .where(
      and(
        eq(skillInstallations.id, input.installationId),
        eq(skillInstallations.userId, input.userId),
      ),
    )
    .returning({ id: skillInstallations.id });
  return rows.length === 1;
}
