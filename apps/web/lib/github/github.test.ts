import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  createAppJwt,
  createInstallationToken,
  getInstallation,
  GitHubApiError,
  listInstallationRepositories,
  normalizePrivateKey,
} from "./client";
import { githubAppStatus, githubConfig, githubInstallUrl } from "./config";
import { decryptToken, encryptToken } from "./crypto";
import { createSignedState, sanitizeReturnTo, verifySignedState } from "./state";
import { installationChange, verifyGitHubSignature } from "./webhook";

const ENV_KEYS = [
  "BETTER_AUTH_SECRET",
  "GITHUB_ENCRYPTION_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "GITHUB_WEBHOOK_SECRET",
];

function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("encrypts and authenticates stored GitHub tokens", () => {
  const restore = withEnv({ BETTER_AUTH_SECRET: "test-secret" });
  try {
    const encrypted = encryptToken("ghu_example");
    assert.notEqual(encrypted, "ghu_example");
    assert.equal(decryptToken(encrypted), "ghu_example");
    const tampered = `${encrypted.slice(0, -2)}AA`;
    assert.throws(() => decryptToken(tampered));
  } finally {
    restore();
  }
});

test("verifies GitHub webhook signatures", () => {
  const body = JSON.stringify({ hello: "world" });
  const signature = `sha256=${createHmac("sha256", "hook-secret")
    .update(body)
    .digest("hex")}`;
  assert.equal(verifyGitHubSignature("hook-secret", body, signature), true);
  assert.equal(verifyGitHubSignature("other", body, signature), false);
  assert.equal(verifyGitHubSignature("hook-secret", body, null), false);
  assert.equal(verifyGitHubSignature("hook-secret", body, "sha1=abc"), false);
});

test("maps installation webhooks to a stored installation id", () => {
  assert.deepEqual(
    installationChange("installation", {
      action: "created",
      installation: { id: 42, account: { login: "acme" } },
      sender: { id: 7, login: "octocat" },
    }),
    { githubUserId: "7", login: "acme", installationId: "42" },
  );
  assert.deepEqual(
    installationChange("installation", {
      action: "unsuspend",
      installation: { id: 42, account: { login: "acme" } },
      sender: { id: 7, login: "octocat" },
    }),
    { githubUserId: "7", login: "acme", installationId: "42" },
  );
  assert.deepEqual(
    installationChange("installation", {
      action: "deleted",
      installation: { id: 42 },
      sender: { id: 7 },
    }),
    { githubUserId: "7", login: undefined, installationId: null },
  );
  assert.equal(
    installationChange("push", { action: "created" }),
    null,
  );
});

test("creates a GitHub App JWT signed by the configured private key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = 1_700_000_000;
  const restore = withEnv({
    GITHUB_APP_ID: "5409576",
    GITHUB_APP_PRIVATE_KEY: pem,
  });
  try {
    assert.equal(normalizePrivateKey(pem), pem);
    const jwt = createAppJwt(now);
    const [header, payload, signature] = jwt.split(".");
    assert.deepEqual(
      JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
      { alg: "RS256", typ: "JWT" },
    );
    assert.deepEqual(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      { iat: now - 60, exp: now + 540, iss: "5409576" },
    );
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    assert.equal(
      verifier.verify(publicKey, Buffer.from(signature, "base64url")),
      true,
    );
  } finally {
    restore();
  }
});

test("reads App configuration and reports missing settings", () => {
  const restore = withEnv({
    GITHUB_APP_ID: "5409576",
    GITHUB_APP_PRIVATE_KEY: "key",
    GITHUB_APP_SLUG: "buildx",
  });
  try {
    assert.deepEqual(githubConfig(), {
      appId: "5409576",
      privateKey: "key",
      webhookSecret: undefined,
      appSlug: "buildx",
      appConfigured: true,
      installConfigured: true,
    });
    assert.deepEqual(githubAppStatus(), {
      configured: true,
      missing: [],
    });
    assert.equal(
      githubInstallUrl("buildx"),
      "https://github.com/apps/buildx/installations/new",
    );
  } finally {
    restore();
  }
});

test("reports which App settings are still missing", () => {
  const restore = withEnv({
    GITHUB_APP_ID: "5409576",
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined,
  });
  try {
    assert.deepEqual(githubAppStatus(), {
      configured: false,
      missing: ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG"],
    });
    assert.equal(githubInstallUrl(), undefined);
  } finally {
    restore();
  }
});

test("signs and verifies the installation state token", () => {
  const restore = withEnv({ GITHUB_ENCRYPTION_KEY: "state-key" });
  try {
    const token = createSignedState("user-1", "/runs/abc");
    const verified = verifySignedState(token);
    assert.equal(verified?.userId, "user-1");
    assert.equal(verified?.returnTo, "/runs/abc");
    assert.ok(verified && verified.exp > Math.floor(Date.now() / 1000));
    assert.equal(verifySignedState(`${token.slice(0, -2)}AA`), null);
    assert.equal(verifySignedState("not-a-token"), null);
    assert.equal(verifySignedState(null), null);
  } finally {
    restore();
  }
});

test("rejects expired installation state tokens", () => {
  const restore = withEnv({ GITHUB_ENCRYPTION_KEY: "state-key" });
  try {
    const token = createSignedState("user-1", "/");
    const payload = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
    ) as { exp: number };
    payload.exp = Math.floor(Date.now() / 1000) - 1;
    const forged = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const signature = token.split(".")[1];
    assert.equal(verifySignedState(`${forged}.${signature}`), null);
  } finally {
    restore();
  }
});

test("sanitizes the return destination", () => {
  assert.equal(sanitizeReturnTo("/runs/abc?tab=git"), "/runs/abc?tab=git");
  assert.equal(sanitizeReturnTo("/settings"), "/settings");
  assert.equal(sanitizeReturnTo("https://evil.example/"), "/");
  assert.equal(sanitizeReturnTo("//evil.example/"), "/");
  assert.equal(sanitizeReturnTo("\\evil"), "/");
  assert.equal(sanitizeReturnTo(""), "/");
  assert.equal(sanitizeReturnTo(null), "/");
});

test("fetches an installation with the App JWT", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const restore = withEnv({
    GITHUB_APP_ID: "5409576",
    GITHUB_APP_PRIVATE_KEY: pem,
  });
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init };
    return new Response(
      JSON.stringify({
        id: 42,
        account: { login: "acme", id: 7 },
        app_id: 5409576,
        suspended_at: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const installation = await getInstallation(42);
    assert.equal(installation.id, 42);
    assert.equal(installation.account.login, "acme");
    assert.equal(request?.url, "https://api.github.com/app/installations/42");
    const authorization = (request?.init?.headers as Record<string, string>)[
      "Authorization"
    ];
    assert.match(authorization ?? "", /^Bearer ey/);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("mints an installation access token and lists repositories", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const restore = withEnv({
    GITHUB_APP_ID: "5409576",
    GITHUB_APP_PRIVATE_KEY: pem,
  });
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; authorization: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    requests.push({
      url: parsed.pathname,
      method: init?.method ?? "GET",
      authorization:
        (init?.headers as Record<string, string>)["Authorization"] ?? "",
    });
    if (parsed.pathname === "/app/installations/42/access_tokens") {
      return new Response(
        JSON.stringify({ token: "ghs_token", expires_at: "2026-01-01T00:00:00Z" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        total_count: 2,
        repositories: [
          { id: 1, name: "a", full_name: "acme/a", private: true },
          { id: 2, name: "b", full_name: "acme/b", private: false },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const created = await createInstallationToken(42);
    assert.equal(created.token, "ghs_token");
    assert.equal(
      requests[0].url,
      "/app/installations/42/access_tokens",
    );
    assert.equal(requests[0].method, "POST");
    assert.match(requests[0].authorization, /^Bearer ey/);

    const repositories = await listInstallationRepositories("ghs_token");
    assert.equal(repositories.length, 2);
    assert.equal(repositories[0].full_name, "acme/a");
    assert.equal(requests[1].url, "/installation/repositories");
    assert.equal(requests[1].authorization, "Bearer ghs_token");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("surfaces GitHub API errors with their status", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const restore = withEnv({
    GITHUB_APP_ID: "5409576",
    GITHUB_APP_PRIVATE_KEY: pem,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ message: "Not Found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  try {
    await assert.rejects(
      async () => {
        await listInstallationRepositories("ghs_token");
      },
      (error: unknown) =>
        error instanceof GitHubApiError && error.status === 404,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});