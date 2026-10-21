import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import {
  buildSelectedSkillsSection,
  buildSkillsSection,
  createSkillRuntime,
  createSkillTools,
  discoverArchiveSkill,
  discoverGitHubSkill,
  discoverSkill,
  parseSkillMarkdown,
  previewSkill,
  parseSkillSource,
  safeSkillPath,
  skillRuntimeFromPackages,
  skillSourceFromPackage,
  SkillSecurityError,
  SkillValidationError,
} from "./skills";

const publicResolve = async () => ["93.184.216.34"];

function skillMd(name: string, description = "Handles PDF files."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFollow these steps safely.\n`;
}

function response(body: string | Uint8Array, status = 200): Response {
  return new Response(body as BodyInit, { status });
}

test("parses YAML frontmatter scalars and folded descriptions", () => {
  const parsed = parseSkillMarkdown(
    "---\nname: pdf-tools\ndescription: >\n  Work with PDFs safely.\n  Preserve page order.\nlicense: MIT\n---\n\nUse `pdftotext`.\n",
  );
  assert.equal(parsed.metadata.name, "pdf-tools");
  assert.equal(parsed.metadata.description, "Work with PDFs safely. Preserve page order.");
  assert.equal(parsed.metadata.license, "MIT");
  assert.match(parsed.instructions, /pdftotext/);
});

test("rejects invalid skill names, missing descriptions and directory mismatches", () => {
  assert.throws(() => parseSkillMarkdown(skillMd("Bad_Name")), SkillValidationError);
  assert.throws(
    () => parseSkillMarkdown("---\nname: ok\ndescription:\n---\nbody"),
    SkillValidationError,
  );
  assert.throws(
    () => parseSkillMarkdown(skillMd("one"), { expectedName: "two" }),
    SkillValidationError,
  );
});

test("skill paths cannot escape the skill directory", () => {
  assert.equal(safeSkillPath("./references/a.md"), "references/a.md");
  for (const bad of ["../secret", "/etc/passwd", "a/../../b", "a\\b", "", "a/./b"]) {
    assert.throws(() => safeSkillPath(bad), SkillSecurityError);
  }
});

test("parses repo shorthand and GitHub tree URLs", () => {
  assert.deepEqual(parseSkillSource("acme/skills"), {
    kind: "github",
    owner: "acme",
    repo: "skills",
    source: "acme/skills",
  });
  const selected = parseSkillSource("https://github.com/acme/skills/tree/main/pdf");
  assert.equal(selected.kind, "github");
  assert.equal(selected.kind === "github" ? selected.ref : undefined, "main");
  assert.equal(selected.kind === "github" ? selected.path : undefined, "pdf");
  assert.equal(parseSkillSource("https://example.com/skill.zip").kind, "archive");
  assert.equal(parseSkillSource("https://example.com/SKILL.md").kind, "skill-md");
});

test("blocks non-HTTPS, localhost and private skill URLs", () => {
  for (const bad of [
    "http://example.com/SKILL.md",
    "https://localhost/SKILL.md",
    "https://127.0.0.1/SKILL.md",
    "https://10.0.0.1/SKILL.md",
    "https://user:pass@example.com/SKILL.md",
    "https://example.com:8443/SKILL.md",
  ]) {
    assert.throws(() => parseSkillSource(bad), SkillSecurityError);
  }
});

function zipEntry(name: string, content: string, mode = 0o100644): {
  name: Buffer;
  data: Buffer;
  compressed: Buffer;
  mode: number;
} {
  const data = Buffer.from(content);
  return { name: Buffer.from(name), data, compressed: deflateRawSync(data), mode };
}

function makeZip(entries: ReturnType<typeof zipEntry>[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    locals.push(local, entry.name, entry.compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, entry.name);
    offset += 30 + entry.name.length + entry.compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

test("rejects zip-slip and symlink entries in archives", async () => {
  const evil = makeZip([zipEntry("../../etc/passwd", skillMd("evil"))]);
  await assert.rejects(
    discoverArchiveSkill("https://example.com/evil.zip", {
      fetch: async () => response(evil),
      resolveHost: publicResolve,
    }),
    SkillSecurityError,
  );

  const link = makeZip([
    zipEntry("demo/SKILL.md", skillMd("demo")),
    zipEntry("demo/link", "target", 0o120777),
  ]);
  await assert.rejects(
    discoverArchiveSkill("https://example.com/link.zip", {
      fetch: async () => response(link),
      resolveHost: publicResolve,
    }),
    SkillSecurityError,
  );
});

test("rejects non-SKILL.md raw URLs, duplicate files and strong encryption", async () => {
  assert.throws(
    () => parseSkillSource("https://raw.githubusercontent.com/acme/skills/main/README.md"),
    /SKILL.md/,
  );

  const duplicate = makeZip([
    zipEntry("demo/SKILL.md", skillMd("demo")),
    zipEntry("demo/SKILL.md", skillMd("demo")),
  ]);
  await assert.rejects(
    discoverArchiveSkill("https://example.com/duplicate.zip", {
      fetch: async () => response(duplicate),
      resolveHost: publicResolve,
    }),
    /duplicate file/,
  );

  const encrypted = Buffer.from(makeZip([zipEntry("demo/SKILL.md", skillMd("demo"))]));
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(0x40, central + 8);
  await assert.rejects(
    discoverArchiveSkill("https://example.com/encrypted.zip", {
      fetch: async () => response(encrypted),
      resolveHost: publicResolve,
    }),
    SkillSecurityError,
  );
});

test("imports a selected skill from a multi-skill GitHub repository", async () => {
  const sha = "a".repeat(40);
  const tree = [
    { path: "pdf/SKILL.md", mode: "100644", type: "blob", sha: "1", size: 100 },
    { path: "pdf/references/guide.md", mode: "100644", type: "blob", sha: "2", size: 100 },
    { path: "slides/SKILL.md", mode: "100644", type: "blob", sha: "3", size: 100 },
  ];
  const calls: string[] = [];
  const mockFetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.endsWith("/repos/acme/skills")) return response(JSON.stringify({ default_branch: "main" }));
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha }));
    if (url.includes(`/git/trees/${sha}`)) return response(JSON.stringify({ tree, truncated: false }));
    if (url.endsWith("/pdf/SKILL.md")) return response(skillMd("pdf", "Work with PDFs."));
    if (url.endsWith("/pdf/references/guide.md")) return response("# Guide\nRead me.");
    throw new Error(`unexpected URL ${url}`);
  };

  await assert.rejects(
    discoverSkill("acme/skills", { fetch: mockFetch, resolveHost: publicResolve }),
    /multiple skills/,
  );

  const pkg = await discoverGitHubSkill(
    { kind: "github", owner: "acme", repo: "skills", path: "pdf", source: "acme/skills" },
    { fetch: mockFetch, resolveHost: publicResolve },
  );
  assert.equal(pkg.metadata.name, "pdf");
  assert.equal(pkg.resolvedRef, sha);
  assert.deepEqual(Object.keys(pkg.files), ["references/guide.md", "SKILL.md"]);
  assert.match(pkg.digest, /^[a-f0-9]{64}$/);
  assert.ok(calls.every((url) => url.includes(`/${sha}/`) || url.includes("api.github.com")));
});

test("reuses GitHub tree and archive downloads across a batch", async () => {
  const sha = "d".repeat(40);
  const tree = [
    { path: "pdf/SKILL.md", mode: "100644", type: "blob", sha: "1", size: 100 },
    { path: "slides/SKILL.md", mode: "100644", type: "blob", sha: "2", size: 100 },
  ];
  const calls: string[] = [];
  const mockFetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.endsWith("/repos/acme/skills")) return response(JSON.stringify({ default_branch: "main" }));
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha }));
    if (url.includes(`/git/trees/${sha}`)) return response(JSON.stringify({ tree, truncated: false }));
    if (url.endsWith("/pdf/SKILL.md")) return response(skillMd("pdf", "Work with PDFs."));
    if (url.endsWith("/slides/SKILL.md")) return response(skillMd("slides", "Build decks."));
    throw new Error(`unexpected URL ${url}`);
  };

  const cache = {};
  await discoverSkill("acme/skills", { fetch: mockFetch, resolveHost: publicResolve, path: "pdf", cache });
  await discoverSkill("acme/skills", { fetch: mockFetch, resolveHost: publicResolve, path: "slides", cache });
  assert.equal(calls.filter((url) => url.endsWith("/repos/acme/skills")).length, 1);
  assert.equal(calls.filter((url) => url.includes(`/git/trees/${sha}`)).length, 1);

  const archive = makeZip([
    zipEntry("pdf/SKILL.md", skillMd("pdf", "Work with PDFs.")),
    zipEntry("slides/SKILL.md", skillMd("slides", "Build decks.")),
  ]);
  let downloads = 0;
  const archiveFetch = async (): Promise<Response> => {
    downloads += 1;
    return response(archive);
  };
  const archiveCache = {};
  await discoverSkill("https://example.com/bundle.zip", {
    fetch: archiveFetch,
    resolveHost: publicResolve,
    path: "pdf",
    cache: archiveCache,
  });
  await discoverSkill("https://example.com/bundle.zip", {
    fetch: archiveFetch,
    resolveHost: publicResolve,
    path: "slides",
    cache: archiveCache,
  });
  assert.equal(downloads, 1);
});

test("previews multi-skill GitHub repositories with candidate metadata", async () => {
  const sha = "b".repeat(40);
  const tree = [
    { path: "pdf/SKILL.md", mode: "100644", type: "blob", sha: "1", size: 100 },
    { path: "pdf/references/guide.md", mode: "100644", type: "blob", sha: "2", size: 100 },
    { path: "slides/SKILL.md", mode: "100644", type: "blob", sha: "3", size: 100 },
  ];
  const calls: string[] = [];
  const mockFetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.endsWith("/repos/acme/skills")) return response(JSON.stringify({ default_branch: "main" }));
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha }));
    if (url.includes(`/git/trees/${sha}`)) return response(JSON.stringify({ tree, truncated: false }));
    if (url.endsWith("/pdf/SKILL.md")) return response(skillMd("pdf", "Work with PDFs."));
    if (url.endsWith("/slides/SKILL.md")) return response(skillMd("slides", "Build slide decks."));
    if (url.endsWith("/pdf/references/guide.md")) return response("# Guide\nRead me.");
    throw new Error(`unexpected URL ${url}`);
  };

  const preview = await previewSkill("acme/skills", {
    fetch: mockFetch,
    resolveHost: publicResolve,
  });
  assert.deepEqual(preview.candidates, ["pdf", "slides"]);
  assert.equal(preview.skill, undefined);
  assert.deepEqual(
    preview.skills.map(({ path, name, description, valid }) => ({ path, name, description, valid })),
    [
      { path: "pdf", name: "pdf", description: "Work with PDFs.", valid: true },
      { path: "slides", name: "slides", description: "Build slide decks.", valid: true },
    ],
  );
  assert.ok(calls.every((url) => url.includes("api.github.com") || url.endsWith("SKILL.md")));
  assert.ok(!calls.some((url) => url.endsWith("/pdf/references/guide.md")));

  const selected = await previewSkill("acme/skills", {
    fetch: mockFetch,
    resolveHost: publicResolve,
    path: "pdf",
  });
  assert.deepEqual(selected.candidates, ["pdf", "slides"]);
  assert.equal(selected.skill?.metadata.name, "pdf");
  assert.match(selected.skill?.instructions ?? "", /Follow these steps safely/);
  assert.deepEqual(Object.keys(selected.skill?.files ?? {}), ["references/guide.md", "SKILL.md"]);
  assert.ok(calls.some((url) => url.includes("raw.githubusercontent.com")));
});

test("previews single-skill sources with metadata ready for auto-selection", async () => {
  const sha = "c".repeat(40);
  const tree = [
    { path: "review/SKILL.md", mode: "100644", type: "blob", sha: "1", size: 100 },
  ];
  const mockFetch = async (url: string): Promise<Response> => {
    if (url.endsWith("/repos/acme/one")) return response(JSON.stringify({ default_branch: "main" }));
    if (url.includes("/commits/main")) return response(JSON.stringify({ sha }));
    if (url.includes(`/git/trees/${sha}`)) return response(JSON.stringify({ tree, truncated: false }));
    if (url.endsWith("/review/SKILL.md")) return response(skillMd("review", "Review changes."));
    throw new Error(`unexpected URL ${url}`);
  };

  const preview = await previewSkill("acme/one", {
    fetch: mockFetch,
    resolveHost: publicResolve,
  });
  assert.equal(preview.skills.length, 1);
  assert.equal(preview.skills[0].path, "review");
  assert.equal(preview.skills[0].name, "review");
  assert.equal(preview.skills[0].valid, true);
  assert.equal(preview.skill?.metadata.name, "review");
});

test("previews multi-skill archives and rejects unknown selected paths", async () => {
  const archive = makeZip([
    zipEntry("pdf/SKILL.md", skillMd("pdf", "Work with PDFs.")),
    zipEntry("pdf/references/guide.md", "# Guide"),
    zipEntry("slides/SKILL.md", skillMd("slides", "Build decks.")),
  ]);
  const options = {
    fetch: async () => response(archive),
    resolveHost: publicResolve,
  };

  const preview = await previewSkill("https://example.com/bundle.zip", options);
  assert.deepEqual(preview.candidates, ["pdf", "slides"]);
  assert.deepEqual(
    preview.skills.map(({ path, name, valid }) => ({ path, name, valid })),
    [
      { path: "pdf", name: "pdf", valid: true },
      { path: "slides", name: "slides", valid: true },
    ],
  );
  await assert.rejects(
    previewSkill("https://example.com/bundle.zip", { ...options, path: "missing" }),
    /does not contain a skill/,
  );
});

test("preview surfaces source retrieval failures", async () => {
  await assert.rejects(
    previewSkill("acme/skills", {
      fetch: async () => {
        throw new Error("network down");
      },
      resolveHost: publicResolve,
    }),
    /network down/,
  );
});

test("loads full skill instructions only when requested", async () => {
  const content = skillMd("pdf", "Work with PDFs.");
  const digest = createHash("sha256").update(content).digest("hex");
  const runtime = skillRuntimeFromPackages([
    {
      metadata: { name: "pdf", description: "Work with PDFs." },
      instructions: "# pdf\nFollow these steps safely.",
      files: { "SKILL.md": content, "references/guide.md": "Guide body" },
      source: "acme/skills",
      sourceKind: "github",
      resolvedRef: "a".repeat(40),
      digest,
    },
  ]);
  const catalog = runtime.list();
  assert.deepEqual(catalog, [{ name: "pdf", description: "Work with PDFs." }]);
  assert.doesNotMatch(buildSkillsSection(catalog), /Follow these steps/);

  const tools = createSkillTools(runtime);
  const loaded = (await tools.load_skill!.execute!({ name: "pdf" }, {} as never)) as {
    content: string;
  };
  assert.match(loaded.content, /Follow these steps safely/);
  assert.match(loaded.content, /untrusted-skill-content/);
  const file = (await tools.read_skill_file!.execute!(
    { name: "pdf", path: "references/guide.md" },
    {} as never,
  )) as { content: string };
  assert.match(file.content, /Guide body/);
  await assert.rejects(
    tools.read_skill_file!.execute!({ name: "pdf", path: "../secret" }, {} as never),
    SkillSecurityError,
  );
});

test("preloads selected skills and reports missing ones", async () => {
  const content = skillMd("pdf", "Work with PDFs.");
  const digest = createHash("sha256").update(content).digest("hex");
  const runtime = skillRuntimeFromPackages([
    {
      metadata: { name: "pdf", description: "Work with PDFs." },
      instructions: "# pdf\nFollow these steps safely.",
      files: { "SKILL.md": content, "references/guide.md": "Guide body" },
      source: "acme/skills",
      sourceKind: "github",
      resolvedRef: "a".repeat(40),
      digest,
    },
  ]);

  const selected = await buildSelectedSkillsSection(runtime, [
    "pdf",
    "pdf",
    "missing",
  ]);
  assert.deepEqual(selected.loaded, ["pdf"]);
  assert.deepEqual(selected.missing, ["missing"]);
  assert.match(selected.section, /User-selected skills/);
  assert.match(selected.section, /Follow these steps safely/);
  assert.match(selected.section, /untrusted-skill-content/);
  assert.match(selected.section, /references\/guide\.md/);

  const empty = await buildSelectedSkillsSection(runtime, []);
  assert.deepEqual(empty, { section: "", loaded: [], missing: [] });
});

test("duplicate skill names are rejected", () => {
  const pkg = {
    metadata: { name: "dup", description: "one" },
    instructions: "x",
    files: { "SKILL.md": skillMd("dup") },
    source: "x",
    sourceKind: "url" as const,
    resolvedRef: "sha256:x",
    digest: "x",
  };
  assert.throws(
    () => createSkillRuntime([skillSourceFromPackage(pkg), skillSourceFromPackage(pkg)]),
    /Duplicate skill name/,
  );
});
