import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  createAppJwt,
  exchangeOAuthCode,
  normalizePrivateKey,
} from "./client";
import { decryptToken, encryptToken } from "./crypto";
import { installationChange, verifyGitHubSignature } from "./webhook";

const ENV_KEYS = [
  "BETTER_AUTH_SECRET",
  "GITHUB_ENCRYPTION_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI",
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

test("exchanges an OAuth code using the configured client credentials", async () => {
  const restore = withEnv({
    GITHUB_CLIENT_ID: "Iv23li56drjF94DNgYtS",
    GITHUB_CLIENT_SECRET: "client-secret",
    GITHUB_REDIRECT_URI: "http://localhost:3000/api/github/callback",
  });
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init };
    return new Response(
      JSON.stringify({
        access_token: "ghu_token",
        token_type: "bearer",
        scope: "repo",
        expires_in: 28800,
        refresh_token: "ghr_refresh",
        refresh_token_expires_in: 15897600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const token = await exchangeOAuthCode("code-123");
    assert.equal(token.access_token, "ghu_token");
    assert.equal(token.refresh_token, "ghr_refresh");
    assert.equal(request?.url, "https://github.com/login/oauth/access_token");
    const body = new URLSearchParams(String(request?.init?.body));
    assert.equal(body.get("client_id"), "Iv23li56drjF94DNgYtS");
    assert.equal(body.get("client_secret"), "client-secret");
    assert.equal(body.get("code"), "code-123");
    assert.equal(
      body.get("redirect_uri"),
      "http://localhost:3000/api/github/callback",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
