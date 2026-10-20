import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { inArray, sql } from "drizzle-orm";
import { loadRootEnv } from "@buildx/shared/node";
import { getDb, type Db } from "./client";
import {
  assertProjectOwner,
  installSkill,
  listInstalledSkills,
  listRuntimeSkills,
  skillScopeKey,
  uninstallSkill,
} from "./skills";
import { projects, user } from "./schema";

loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
const createdUsers: string[] = [];

try {
  db = getDb({ fresh: true });
  await db.execute(sql`SELECT 1`);
  await db.execute(sql`SELECT 1 FROM skill_installations LIMIT 1`);
  skipReason = false;
} catch (error) {
  skipReason = `Postgres/skills schema unavailable: ${(error as Error).message}`;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db!.insert(user).values({ id, name: "Skill User", email: `${id}@test.local` });
  createdUsers.push(id);
  return id;
}

async function newProject(userId: string): Promise<string> {
  const [row] = await db!
    .insert(projects)
    .values({ userId, name: "skills" })
    .returning({ id: projects.id });
  return row.id;
}

function catalog(name: string, digest = randomUUID().replace(/-/g, "").padEnd(64, "a")) {
  return {
    name,
    description: `description for ${name}`,
    source: "acme/skills",
    sourceKind: "github" as const,
    resolvedRef: "a".repeat(40),
    digest,
    artifactKey: `skills/${digest}.json.gz`,
    fileCount: 2,
    totalBytes: 100,
  };
}

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("duplicate installs update in place", { skip: skipReason }, async () => {
  const userId = await newUser();
  const first = await installSkill(db!, {
    userId,
    scope: { kind: "user" },
    catalog: catalog("pdf"),
  });
  const updatedDigest = "b".repeat(64);
  const second = await installSkill(db!, {
    userId,
    scope: { kind: "user" },
    catalog: catalog("pdf", updatedDigest),
  });
  assert.equal(second.id, first.id);
  const rows = await listInstalledSkills(db!, {
    userId,
    scope: { kind: "user" },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skill.digest, updatedDigest);
});

test("project installs require ownership and never cross users", { skip: skipReason }, async () => {
  const owner = await newUser();
  const other = await newUser();
  const projectId = await newProject(owner);

  await assert.rejects(
    assertProjectOwner(db!, other, projectId),
    /not owned/,
  );
  await assert.rejects(
    installSkill(db!, {
      userId: other,
      scope: { kind: "project", projectId },
      catalog: catalog("secret"),
    }),
    /not owned/,
  );

  const installed = await installSkill(db!, {
    userId: owner,
    scope: { kind: "project", projectId },
    catalog: catalog("pdf", "c".repeat(64)),
  });
  assert.equal(
    await uninstallSkill(db!, { userId: other, installationId: installed.id }),
    false,
  );
  assert.equal(
    await uninstallSkill(db!, { userId: owner, installationId: installed.id }),
    true,
  );
});

test("project scope overrides a same-named user skill for runtime", { skip: skipReason }, async () => {
  const userId = await newUser();
  const projectId = await newProject(userId);
  await installSkill(db!, {
    userId,
    scope: { kind: "user" },
    catalog: catalog("shared", "d".repeat(64)),
  });
  await installSkill(db!, {
    userId,
    scope: { kind: "project", projectId },
    catalog: catalog("shared", "e".repeat(64)),
  });

  const runtime = await listRuntimeSkills(db!, { userId, projectId });
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].skill.digest, "e".repeat(64));
  assert.equal(
    skillScopeKey(userId, { kind: "project", projectId }),
    `project:${projectId}`,
  );
});
