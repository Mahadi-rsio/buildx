import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCatalogEntry,
  isConnectable,
  searchCatalog,
  type McpCatalogEntry,
} from "./mcp-catalog";

const ENTRIES: McpCatalogEntry[] = [
  {
    id: "context7",
    name: "Context7",
    summary: "Up-to-date library docs for any framework",
    description: "Pulls current docs for libraries and SDKs.",
    category: "knowledge",
    tags: ["docs", "libraries"],
    icon: "📚",
    officialUrl: "https://context7.com",
    endpoint: "https://mcp.context7.com/mcp",
    authModes: ["none"],
    popularity: 90,
    verified: true,
    tools: ["get_docs", "resolve_library"],
    featured: true,
  },
  {
    id: "exa",
    name: "Exa",
    summary: "Web search and content retrieval",
    description: "Search the web and fetch page contents.",
    category: "search",
    tags: ["web", "search"],
    icon: "🔍",
    officialUrl: "https://exa.ai",
    endpoint: "https://mcp.exa.ai/mcp",
    authModes: ["api-key"],
    apiKeyHeader: "x-api-key",
    popularity: 80,
    verified: true,
    tools: ["search", "get_contents"],
  },
  {
    id: "graphify",
    name: "Graphify",
    summary: "Local knowledge graphs for codebases",
    description: "Builds knowledge graphs from your code and docs.",
    category: "knowledge",
    tags: ["graphs", "code"],
    icon: "🕸️",
    officialUrl: "https://graaph.org",
    authModes: ["local"],
    popularity: 60,
    verified: false,
    tools: ["graph_search", "graph_visualize"],
    requiresLocal: true,
    note: "Runs as a local stdio server — install Graphify locally or use the hosted console at app.graaph.org.",
  },
  {
    id: "stripe",
    name: "Stripe",
    summary: "Payments and billing operations",
    description: "Manage payments, customers, and invoices.",
    category: "finance",
    tags: ["payments", "billing"],
    icon: "💳",
    officialUrl: "https://docs.stripe.com/agents/mcp",
    endpoint: "https://mcp.stripe.com",
    authModes: ["api-key"],
    apiKeyHeader: "Authorization",
    apiKeyPrefix: "Bearer ",
    popularity: 70,
    verified: true,
    tools: ["create_payment", "list_invoices"],
  },
];

test("searchCatalog matches on name, tags, and tools case-insensitively", () => {
  const byName = searchCatalog(ENTRIES, { query: "context7" });
  assert.equal(byName.length, 1);
  assert.equal(byName[0].id, "context7");

  const byTag = searchCatalog(ENTRIES, { query: "payments" });
  assert.equal(byTag.length, 1);
  assert.equal(byTag[0].id, "stripe");

  const byTool = searchCatalog(ENTRIES, { query: "graph_search" });
  assert.equal(byTool.length, 1);
  assert.equal(byTool[0].id, "graphify");

  const none = searchCatalog(ENTRIES, { query: "zzz-not-present" });
  assert.equal(none.length, 0);
});

test("searchCatalog narrows by category", () => {
  const knowledge = searchCatalog(ENTRIES, { category: "knowledge" });
  assert.deepEqual(
    knowledge.map((entry) => entry.id).sort(),
    ["context7", "graphify"],
  );

  const all = searchCatalog(ENTRIES, { category: "all" });
  assert.equal(all.length, ENTRIES.length);
});

test("searchCatalog sorts by popularity, featured first", () => {
  const results = searchCatalog(ENTRIES, {});
  assert.equal(results[0].id, "context7"); // featured
  assert.equal(results[1].id, "exa"); // 80 > 70 > 60
  assert.equal(results[2].id, "stripe");
  assert.equal(results[3].id, "graphify");
});

test("connectableOnly hides local-only entries", () => {
  const connectable = searchCatalog(ENTRIES, { connectableOnly: true });
  assert.ok(connectable.every((entry) => !entry.requiresLocal));
  assert.equal(connectable.some((entry) => entry.id === "graphify"), false);
});

test("isConnectable reflects endpoint presence and local-only flag", () => {
  assert.equal(isConnectable(ENTRIES[0]), true);
  assert.equal(isConnectable(ENTRIES[2]), false);
});

test("findCatalogEntry resolves by id", () => {
  assert.equal(findCatalogEntry(ENTRIES, "exa")?.name, "Exa");
  assert.equal(findCatalogEntry(ENTRIES, "missing"), undefined);
});