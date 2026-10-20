import { gunzipSync, gzipSync } from "node:zlib";
import {
  computeSkillDigest,
  createSkillRuntime,
  discoverSkill,
  SkillValidationError,
  type SkillPackage,
  type SkillRuntime,
  type SkillSource,
} from "@buildx/agent";
import {
  assertProjectOwner,
  getDb,
  installSkill,
  listInstalledSkills,
  listRuntimeSkills,
  uninstallSkill,
  type InstalledSkill,
  type SkillScope,
} from "@buildx/db";
import { createStorage, MAX_OBJECT_BYTES, type Storage } from "@buildx/storage";

const ARTIFACT_VERSION = 1;
export const MAX_SKILL_ARTIFACT_BYTES = MAX_OBJECT_BYTES;

interface ArtifactEnvelope {
  version: number;
  digest: string;
  package: {
    metadata: SkillPackage["metadata"];
    instructions: string;
    files: Record<string, string>;
    source: string;
    sourceKind: SkillPackage["sourceKind"];
    resolvedRef: string;
  };
}

function storage(): Storage {
  return createStorage();
}

function artifactKeyFor(digest: string): string {
  return `skills/${digest}.json.gz`;
}

function encodeArtifact(pkg: SkillPackage): Uint8Array {
  const envelope: ArtifactEnvelope = {
    version: ARTIFACT_VERSION,
    digest: pkg.digest,
    package: {
      metadata: pkg.metadata,
      instructions: pkg.instructions,
      files: pkg.files,
      source: pkg.source,
      sourceKind: pkg.sourceKind,
      resolvedRef: pkg.resolvedRef,
    },
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"), {
    level: 9,
  });
  if (compressed.byteLength > MAX_SKILL_ARTIFACT_BYTES) {
    throw new SkillValidationError("Skill artifact is too large to store.");
  }
  return compressed;
}

function decodeArtifact(bytes: Uint8Array, expectedDigest: string): SkillPackage {
  let parsed: ArtifactEnvelope;
  try {
    const raw = gunzipSync(bytes, { maxOutputLength: MAX_SKILL_ARTIFACT_BYTES });
    parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as ArtifactEnvelope;
  } catch {
    throw new SkillValidationError("Stored skill artifact is corrupt.");
  }
  if (parsed.version !== ARTIFACT_VERSION || !parsed.package) {
    throw new SkillValidationError("Stored skill artifact has an unsupported version.");
  }
  const files = parsed.package.files;
  if (!files || typeof files !== "object" || !files["SKILL.md"]) {
    throw new SkillValidationError("Stored skill artifact is missing SKILL.md.");
  }
  const digest = computeSkillDigest(files);
  if (digest !== expectedDigest || digest !== parsed.digest) {
    throw new SkillValidationError("Stored skill artifact failed its integrity check.");
  }
  return {
    metadata: parsed.package.metadata,
    instructions: parsed.package.instructions,
    files,
    source: parsed.package.source,
    sourceKind: parsed.package.sourceKind,
    resolvedRef: parsed.package.resolvedRef,
    digest,
  };
}

export interface SkillInstallationView {
  id: string;
  name: string;
  description: string;
  source: string;
  sourceKind: string;
  resolvedRef: string;
  digest: string;
  scope: "user" | "project";
  installedAt: string;
}

function scopeFor(projectId?: string | null): SkillScope {
  return projectId ? { kind: "project", projectId } : { kind: "user" };
}

function toView(row: InstalledSkill, scope: SkillScope): SkillInstallationView {
  return {
    id: row.installationId,
    name: row.skill.name,
    description: row.skill.description,
    source: row.skill.source,
    sourceKind: row.skill.sourceKind,
    resolvedRef: row.skill.resolvedRef,
    digest: row.skill.digest,
    scope: scope.kind,
    installedAt: row.skill.createdAt.toISOString(),
  };
}

export async function listInstalledSkillViews(
  userId: string,
  projectId?: string | null,
): Promise<SkillInstallationView[]> {
  const scope = scopeFor(projectId);
  const rows = await listInstalledSkills(getDb(), { userId, scope });
  return rows.map((row) => toView(row, scope));
}

/**
 * Discover, validate and persist a skill without touching a Box. The artifact
 * is written content-addressed first; only then does the installation row point
 * at it, so a failed upload cannot produce a "installed" skill with no bytes.
 */
export async function installSkillFromSource(input: {
  userId: string;
  source: string;
  projectId?: string | null;
  path?: string;
}): Promise<SkillInstallationView> {
  const db = getDb();
  const scope = scopeFor(input.projectId);
  if (scope.kind === "project") {
    await assertProjectOwner(db, input.userId, scope.projectId);
  }
  const pkg = await discoverSkill(input.source, { path: input.path });
  const artifactKey = artifactKeyFor(pkg.digest);
  const existing = await storage().head(artifactKey).catch(() => null);
  if (!existing) {
    await storage().putObject(artifactKey, encodeArtifact(pkg), {
      contentType: "application/gzip",
    });
  }
  await installSkill(db, {
    userId: input.userId,
    scope,
    catalog: {
      name: pkg.metadata.name,
      description: pkg.metadata.description,
      source: pkg.source,
      sourceKind: pkg.sourceKind,
      resolvedRef: pkg.resolvedRef,
      digest: pkg.digest,
      artifactKey,
      fileCount: Object.keys(pkg.files).length,
      totalBytes: Object.values(pkg.files).reduce(
        (sum, body) => sum + Buffer.byteLength(body, "utf8"),
        0,
      ),
    },
  });
  const rows = await listInstalledSkills(db, { userId: input.userId, scope });
  const installed = rows.find((row) => row.skill.name === pkg.metadata.name);
  if (!installed) throw new Error("skill installation did not persist");
  return toView(installed, scope);
}

export async function uninstallSkillById(
  userId: string,
  installationId: string,
): Promise<boolean> {
  return uninstallSkill(getDb(), { userId, installationId });
}

/**
 * Build the progressive runtime for a run. Artifact reads are lazy and cached
 * per runtime instance; corrupt/missing artifacts are skipped so one bad skill
 * cannot break unrelated runs.
 */
export async function loadSkillRuntime(
  userId: string,
): Promise<SkillRuntime | undefined> {
  const rows = await listRuntimeSkills(getDb(), { userId });
  if (rows.length === 0) return undefined;
  const cache = new Map<string, Promise<SkillPackage>>();
  const loadPackage = (artifactKey: string, digest: string): Promise<SkillPackage> => {
    let pending = cache.get(artifactKey);
    if (!pending) {
      pending = (async () => {
        const bytes = await storage().getObject(artifactKey, {
          maxBytes: MAX_SKILL_ARTIFACT_BYTES,
        });
        if (!bytes) throw new SkillValidationError(`Skill artifact ${digest} is missing.`);
        return decodeArtifact(bytes, digest);
      })();
      cache.set(artifactKey, pending);
    }
    return pending;
  };

  const sources: SkillSource[] = [];
  for (const row of rows) {
    sources.push({
      metadata: { name: row.skill.name, description: row.skill.description },
      load: async () => {
        const pkg = await loadPackage(row.skill.artifactKey, row.skill.digest);
        return {
          metadata: pkg.metadata,
          instructions: pkg.instructions,
          files: Object.keys(pkg.files),
        };
      },
      readFile: async (path: string) => {
        const pkg = await loadPackage(row.skill.artifactKey, row.skill.digest);
        const content = pkg.files[path];
        if (content === undefined) {
          throw new SkillValidationError(`Skill file "${path}" not found.`);
        }
        return content;
      },
    });
  }
  return createSkillRuntime(sources);
}
