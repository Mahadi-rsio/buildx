import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { decryptJson, encryptJson } from "./crypto";

beforeEach(() => {
  process.env.MCP_ENCRYPTION_KEY = "test-key-0000";
});

test("encryptJson/decryptJson round-trip headers without leaking them", () => {
  const headers = { Authorization: "Bearer secret-token", "X-Custom": "v" };
  const ciphertext = encryptJson(headers);
  assert.ok(!ciphertext.includes("secret-token"), "plaintext must not leak");
  assert.deepEqual(decryptJson<Record<string, string>>(ciphertext), headers);
});

test("same payload encrypts differently each time (random IV)", () => {
  const a = encryptJson({ "X-A": "1" });
  const b = encryptJson({ "X-A": "1" });
  assert.notEqual(a, b);
});

test("decryptJson rejects a corrupt or tampered payload", () => {
  const ciphertext = encryptJson({ "X-A": "1" });
  // Flip a character inside the payload section (leaving the prefix intact).
  const [prefix, iv, tag, data] = ciphertext.split(":");
  const tampered = `${prefix}:${iv}:${tag}:${data.slice(0, -1)}${
    data.endsWith("A") ? "B" : "A"
  }`;
  assert.throws(() => decryptJson(tampered));
  assert.throws(() => decryptJson("not-a-ciphertext"));
});

test("decryptJson fails without an encryption key configured", () => {
  delete process.env.MCP_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  assert.throws(() => encryptJson({ "X-A": "1" }), /MCP_ENCRYPTION_KEY/);
});