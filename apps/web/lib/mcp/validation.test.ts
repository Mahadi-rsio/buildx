import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanHeaders,
  firstIssue,
  isBlockedGitHubMcp,
  isMissingTableError,
  mcpServerCreateSchema,
  schemaNotMigrated,
} from "./validation";

test("isMissingTableError detects the Postgres 42P01 relation error", () => {
  assert.equal(
    isMissingTableError({
      code: "42P01",
      message: 'relation "mcp_servers" does not exist',
    }),
    true,
  );
  assert.equal(
    isMissingTableError(
      new Error('relation "mcp_servers" does not exist'),
    ),
    true,
  );
  assert.equal(
    isMissingTableError({ message: "relation mcp_servers does not exist" }),
    true,
  );
  // Nested via `cause` (neon-http / drizzle wrapper style).
  assert.equal(
    isMissingTableError({
      cause: { code: "42P01", message: "undefined_table" },
    }),
    true,
  );
});

test("isMissingTableError ignores unrelated errors", () => {
  assert.equal(isMissingTableError({ code: "23505" }), false);
  assert.equal(isMissingTableError(new Error("connection refused")), false);
  assert.equal(isMissingTableError(undefined), false);
  assert.equal(isMissingTableError("42P01"), false);
});

test("mcpServerCreateSchema requires an absolute http(s) URL", () => {
  const parsed = mcpServerCreateSchema.parse({
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    headers: { "X-Api-Key": "secret" },
  });
  assert.equal(parsed.name, "Linear");
  assert.deepEqual(parsed.headers, { "X-Api-Key": "secret" });
});

test("mcpServerCreateSchema accepts and trims a catalog id", () => {
  const parsed = mcpServerCreateSchema.parse({
    name: "Context7",
    url: "https://mcp.context7.com/mcp",
    catalogId: "  context7  ",
  });
  assert.equal(parsed.catalogId, "context7");
  assert.equal(
    mcpServerCreateSchema.parse({
      name: "Custom",
      url: "https://mcp.example.com/mcp",
    }).catalogId,
    undefined,
  );
  assert.throws(() =>
    mcpServerCreateSchema.parse({
      name: "Custom",
      url: "https://mcp.example.com/mcp",
      catalogId: " ".repeat(2),
    }),
  );
});

test("mcpServerCreateSchema rejects bad URLs", () => {
  assert.throws(() => mcpServerCreateSchema.parse({ name: "x", url: "ftp://x" }));
  assert.throws(() => mcpServerCreateSchema.parse({ name: "x", url: "not a url" }));
  assert.throws(() => mcpServerCreateSchema.parse({ name: "x", url: "" }));
  assert.throws(() => mcpServerCreateSchema.parse({ name: "", url: "https://x" }));
});

test("mcpServerCreateSchema rejects header injection and transport headers", () => {
  assert.throws(() =>
    mcpServerCreateSchema.parse({
      name: "x",
      url: "https://mcp.example.com",
      headers: { "X-Api-Key": "a\r\nInjected: yes" },
    }),
  );
  assert.throws(() =>
    mcpServerCreateSchema.parse({
      name: "x",
      url: "https://mcp.example.com",
      headers: { Host: "evil.example.com" },
    }),
  );
});

test("cleanHeaders drops blank entries and maps empty to undefined", () => {
  // Blank name + whitespace-only value are dropped; the valid pair survives.
  assert.deepEqual(cleanHeaders({ "": "x", "X-B": "  ", "X-A": "v" }), {
    "X-A": "v",
  });
  // Leading/trailing whitespace is trimmed.
  assert.deepEqual(cleanHeaders({ " X-A ": " v " }), { "X-A": "v" });
  // All-blank input maps to undefined (meaning "no auth headers").
  assert.equal(cleanHeaders({ "": "x", "X-B": " " }), undefined);
  assert.deepEqual(cleanHeaders({ "X-A": "v", "X-B": "" }), { "X-A": "v" });
  assert.equal(cleanHeaders(undefined), undefined);
});

test("firstIssue surfaces the first human-readable validation message", () => {
  const result = mcpServerCreateSchema.safeParse({ name: "", url: "bad" });
  assert.ok(!result.success);
  const message = firstIssue(result.error);
  assert.ok(message.length > 0);
});

test("schemaNotMigrated returns a 503 with an actionable message", async () => {
  const response = schemaNotMigrated();
  assert.equal(response.status, 503);
  const data = (await response.json()) as { error?: string; message?: string };
  assert.equal(data.error, "schema_not_migrated");
  assert.match(data.message ?? "", /db:migrate/);
});

test("isBlockedGitHubMcp rejects the retired catalog entry and endpoint host", () => {
  assert.equal(isBlockedGitHubMcp({ catalogId: "github" }), true);
  assert.equal(isBlockedGitHubMcp({ catalogId: " GitHub " }), true);
  assert.equal(
    isBlockedGitHubMcp({ url: "https://api.githubcopilot.com/mcp/" }),
    true,
  );
  assert.equal(
    isBlockedGitHubMcp({ url: "https://API.GITHUBCOPILOT.COM/mcp/" }),
    true,
  );
});

test("isBlockedGitHubMcp leaves other providers and custom URLs alone", () => {
  assert.equal(
    isBlockedGitHubMcp({ catalogId: "vercel", url: "https://mcp.vercel.app/mcp" }),
    false,
  );
  assert.equal(
    isBlockedGitHubMcp({ url: "https://mcp.example.com/github" }),
    false,
  );
  assert.equal(isBlockedGitHubMcp({}), false);
});
