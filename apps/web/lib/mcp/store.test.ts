import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Db } from "@buildx/db";
import { getDb, sql, user, mcpServers, eq, inArray } from "@buildx/db";
import { loadRootEnv } from "@buildx/shared/node";
import {
  findMcpServer,
  listMcpServers,
  loadEnabledMcpServerConfigs,
  readMcpHeaders,
  toMcpServerConfig,
  toMcpServerView,
} from "./store";

/** Real-Postgres tests; skip when the database is unreachable. */
loadRootEnv();

let db: Db | undefined;
let skipReason: string | false = "Postgres not reachable";
const createdUsers: string[] = [];

try {
  db = getDb();
  await db.execute(sql`SELECT 1`);
  // Ensure the migration is applied so the table actually exists.
  await db.execute(sql`SELECT 1 FROM "mcp_servers" LIMIT 0`);
  skipReason = false;
} catch (error) {
  skipReason = `Postgres or mcp_servers table unavailable: ${
    (error as Error).message
  }`;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db!.insert(user).values({
    id,
    name: "MCP Test",
    email: `mcp-${id}@test.local`,
  });
  createdUsers.push(id);
  return id;
}

after(async () => {
  if (skipReason || createdUsers.length === 0) return;
  await db!.delete(user).where(inArray(user.id, createdUsers));
});

test("MCP servers CRUD round-trips and views never expose credentials", { skip: skipReason }, async () => {
  const userId = await newUser();
  const [inserted] = await db!
    .insert(mcpServers)
    .values({
      userId,
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      headersEncrypted: "v1:iv:tag:data", // corrupt on purpose — see crypto tests
      enabled: true,
    })
    .returning();
  assert.ok(inserted);

  const listed = await listMcpServers(userId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Linear");

  const view = toMcpServerView(listed[0]);
  assert.equal(view.name, "Linear");
  assert.equal(view.hasHeaders, true);
  assert.equal(view.lastStatus, "unknown");
  // The view must never carry the ciphertext (only a presence flag).
  assert.equal(
    (view as unknown as { headersEncrypted?: unknown }).headersEncrypted,
    undefined,
  );

  const found = await findMcpServer(userId, inserted.id);
  assert.ok(found);
  assert.equal(await findMcpServer("other-user", inserted.id), undefined);

  const updated = await db!
    .update(mcpServers)
    .set({ enabled: false, lastStatus: "error", lastError: "boom" })
    .where(eq(mcpServers.id, inserted.id))
    .returning();
  assert.equal(updated[0].enabled, false);
  assert.equal(toMcpServerView(updated[0]).lastStatus, "error");

  await db!.delete(mcpServers).where(eq(mcpServers.id, inserted.id));
  assert.equal(await findMcpServer(userId, inserted.id), undefined);
});

test("readMcpHeaders returns {} for a row without credentials", { skip: skipReason }, async () => {
  const userId = await newUser();
  const [row] = await db!
    .insert(mcpServers)
    .values({ userId, name: "Open", url: "https://mcp.example.com/mcp" })
    .returning();
  assert.deepEqual(readMcpHeaders(row), {});
  await db!.delete(mcpServers).where(eq(mcpServers.id, row.id));
});

test("toMcpServerConfig exposes decrypted headers for runtime use", { skip: skipReason }, async () => {
  const userId = await newUser();
  const { encryptJson } = await import("./crypto");
  process.env.MCP_ENCRYPTION_KEY ??= "test-key-0000";
  const headers = { Authorization: "Bearer top-secret" };
  const [row] = await db!
    .insert(mcpServers)
    .values({
      userId,
      name: "Auth",
      url: "https://mcp.example.com/mcp",
      headersEncrypted: encryptJson(headers),
    })
    .returning();
  const config = toMcpServerConfig(row);
  assert.deepEqual(config.headers, headers);
  await db!.delete(mcpServers).where(eq(mcpServers.id, row.id));
});

test("loadEnabledMcpServerConfigs returns only enabled servers", { skip: skipReason }, async () => {
  const userId = await newUser();
  const { encryptJson } = await import("./crypto");
  process.env.MCP_ENCRYPTION_KEY ??= "test-key-0000";
  await db!.insert(mcpServers).values([
    { userId, name: "On", url: "https://one.example.com/mcp", enabled: true },
    {
      userId,
      name: "Off",
      url: "https://two.example.com/mcp",
      enabled: false,
      headersEncrypted: encryptJson({ "X-Key": "v" }),
    },
  ]);
  const configs = await loadEnabledMcpServerConfigs(userId);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].name, "On");
  await db!
    .delete(mcpServers)
    .where(eq(mcpServers.userId, userId));
});