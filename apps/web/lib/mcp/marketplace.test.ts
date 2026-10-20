import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpCatalogEntry, McpOAuthConfig } from "@buildx/shared";
import {
  catalogAuthHeaders,
  getCatalogEntry,
  MCP_CATALOG,
  popularCatalog,
} from "./catalog";
import {
  buildAuthorizationUrl,
  codeChallenge,
  exchangeAuthorizationCode,
  generatePkcePair,
  oauthConfigured,
  oauthEnvKeys,
  OAuthTokenError,
} from "./oauth";

const OAUTH: McpOAuthConfig = {
  provider: "vercel",
  authorizationUrl: "https://vercel.com/oauth/authorize",
  tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
  scopes: [],
};

const ENTRY: McpCatalogEntry = {
  id: "vercel",
  name: "Vercel",
  summary: "Deployments",
  description: "Desc",
  category: "dev-tools",
  tags: [],
  icon: "▲",
  officialUrl: "https://vercel.com",
  endpoint: "https://mcp.vercel.app/mcp",
  authModes: ["oauth", "api-key"],
  oauth: OAUTH,
  popularity: 90,
  verified: true,
  tools: [],
};

test("PKCE verifier is URL-safe and produces a stable S256 challenge", () => {
  const pair = generatePkcePair(64);
  assert.ok(/^[A-Za-z0-9\-._~]{64}$/.test(pair.verifier));
  // S256 challenge must be stable and base64url without padding.
  assert.equal(codeChallenge(pair.verifier), pair.challenge);
  assert.equal(pair.challenge.length, 43);
  assert.ok(!pair.challenge.includes("="));
  // Deterministic: same verifier → same challenge.
  assert.equal(codeChallenge(pair.verifier), codeChallenge(pair.verifier));
});

test("buildAuthorizationUrl includes PKCE + state + redirect params", () => {
  process.env.MCP_OAUTH_VERCEL_CLIENT_ID = "client-123";
  const url = new URL(
    buildAuthorizationUrl({
      entry: ENTRY,
      oauth: OAUTH,
      state: "state-abc",
      pkce: { verifier: "v", challenge: "c" },
      redirectUri: "http://localhost:3000/api/mcp/catalog/vercel/oauth/callback",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://vercel.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-abc");
  assert.equal(url.searchParams.get("code_challenge"), "c");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), null);
});

test("exchangeAuthorizationCode posts real PKCE params and reads the token", async () => {
  process.env.MCP_OAUTH_VERCEL_CLIENT_ID = "client-123";
  process.env.MCP_OAUTH_VERCEL_CLIENT_SECRET = "secret-456";
  let postedBody: string | null = null;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), OAUTH.tokenUrl);
    assert.equal(init?.method, "POST");
    postedBody = init?.body as string;
    return new Response(
      JSON.stringify({
        access_token: "vc_token_1",
        token_type: "bearer",
        scope: "",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const token = await exchangeAuthorizationCode({
    oauth: OAUTH,
    code: "auth-code",
    codeVerifier: "the-verifier",
    redirectUri: "http://localhost:3000/cb",
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(token.accessToken, "vc_token_1");
  assert.equal(token.tokenType, "bearer");

  const params = new URLSearchParams(postedBody ?? "");
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), "auth-code");
  assert.equal(params.get("code_verifier"), "the-verifier");
  assert.equal(params.get("client_id"), "client-123");
  assert.equal(params.get("client_secret"), "secret-456");
  assert.equal(params.get("redirect_uri"), "http://localhost:3000/cb");
});

test("exchangeAuthorizationCode surfaces provider error descriptions", async () => {
  process.env.MCP_OAUTH_VERCEL_CLIENT_ID = "client-123";
  process.env.MCP_OAUTH_VERCEL_CLIENT_SECRET = "secret-456";
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "code expired" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  await assert.rejects(
    exchangeAuthorizationCode({
      oauth: OAUTH,
      code: "bad",
      codeVerifier: "v",
      redirectUri: "http://localhost:3000/cb",
      fetchImpl: fetchImpl as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof OAuthTokenError && error.message.includes("code expired"),
  );
});

test("exchangeAuthorizationCode rejects a missing access_token", async () => {
  process.env.MCP_OAUTH_VERCEL_CLIENT_ID = "client-123";
  process.env.MCP_OAUTH_VERCEL_CLIENT_SECRET = "secret-456";
  const fetchImpl = async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(
    exchangeAuthorizationCode({
      oauth: OAUTH,
      code: "code",
      codeVerifier: "v",
      redirectUri: "http://localhost:3000/cb",
      fetchImpl: fetchImpl as typeof fetch,
    }),
    OAuthTokenError,
  );
});

test("oauthConfigured reflects env presence", () => {
  assert.equal(
    oauthConfigured(OAUTH, {
      MCP_OAUTH_VERCEL_CLIENT_ID: "id",
      MCP_OAUTH_VERCEL_CLIENT_SECRET: "secret",
    }),
    true,
  );
  assert.equal(
    oauthConfigured(OAUTH, { MCP_OAUTH_VERCEL_CLIENT_ID: "id" }),
    false,
  );
  assert.equal(oauthConfigured(OAUTH, {}), false);
});

test("oauthEnvKeys normalizes provider names", () => {
  assert.deepEqual(oauthEnvKeys("vercel"), {
    clientIdVar: "MCP_OAUTH_VERCEL_CLIENT_ID",
    clientSecretVar: "MCP_OAUTH_VERCEL_CLIENT_SECRET",
  });
});

test("catalog: local-only entries are never connectable and note why", () => {
  for (const id of ["graphify", "playwright"]) {
    const entry = getCatalogEntry(id);
    assert.ok(entry, `catalog has ${id}`);
    assert.equal(entry.requiresLocal, true);
    assert.equal(entry.endpoint, undefined);
    assert.ok(entry.note, `${id} has a truthful setup note`);
  }
});

test("catalog: every remote entry has a verified-looking endpoint and auth", () => {
  const remote = MCP_CATALOG.filter((entry) => !entry.requiresLocal);
  assert.ok(remote.length >= 9, `expected >= 9 remote entries, got ${remote.length}`);
  for (const entry of remote) {
    assert.ok(entry.endpoint?.startsWith("https://"), `${entry.id} uses https`);
    assert.ok(entry.authModes.length > 0, `${entry.id} declares auth`);
    if (entry.authModes.includes("api-key")) {
      assert.ok(entry.apiKeyHeader, `${entry.id} api-key mode declares a header`);
    }
    if (entry.authModes.includes("oauth")) {
      assert.ok(entry.oauth, `${entry.id} oauth mode has a config`);
    }
  }
});

test("catalog: popular grid surfaces the requested first-party servers", () => {
  const popular = popularCatalog(6).map((entry) => entry.id);
  for (const id of ["context7", "vercel", "exa", "firecrawl"]) {
    assert.ok(popular.includes(id), `${id} is in the popular grid`);
  }
  assert.ok(
    popular.every((id) => !getCatalogEntry(id)?.requiresLocal),
    "popular grid never includes local-only servers",
  );
});

test("catalogAuthHeaders: keyless entries send nothing", () => {
  const context7 = getCatalogEntry("context7");
  assert.ok(context7);
  assert.deepEqual(catalogAuthHeaders(context7, "ignored"), {});
});

test("catalogAuthHeaders: respects each provider's header and prefix", () => {
  const exa = getCatalogEntry("exa");
  const firecrawl = getCatalogEntry("firecrawl");
  assert.ok(exa && firecrawl);
  assert.deepEqual(catalogAuthHeaders(exa, " exa-key "), {
    "x-api-key": "exa-key",
  });
  assert.deepEqual(catalogAuthHeaders(firecrawl, "fc-key"), {
    Authorization: "Bearer fc-key",
  });
  assert.deepEqual(catalogAuthHeaders(exa, "   "), {});
});

test("catalog: the GitHub MCP entry is removed entirely", () => {
  assert.equal(getCatalogEntry("github"), undefined);
  assert.equal(
    MCP_CATALOG.some((entry) => entry.id === "github"),
    false,
    "no catalog entry may use id github",
  );
  assert.equal(
    popularCatalog(MCP_CATALOG.length).some((entry) => entry.id === "github"),
    false,
    "the popular grid never lists GitHub MCP",
  );
});

test("catalog: generic non-GitHub providers keep working", () => {
  process.env.MCP_OAUTH_VERCEL_CLIENT_ID = "client-123";
  const vercel = getCatalogEntry("vercel");
  assert.ok(vercel, "vercel remains in the catalog");
  assert.equal(vercel.authModes.includes("oauth"), true);

  const authUrl = buildAuthorizationUrl({
    entry: vercel,
    oauth: vercel.oauth ?? OAUTH,
    state: "state-generic",
    pkce: { verifier: "v", challenge: "c" },
    redirectUri: "http://localhost:3000/api/mcp/catalog/vercel/oauth/callback",
  });
  assert.equal(new URL(authUrl).hostname, "vercel.com");
});
