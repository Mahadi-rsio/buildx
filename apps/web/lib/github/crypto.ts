import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Symmetric encryption for GitHub tokens at rest. AES-256-GCM with a random IV
 * and authenticated tag. A dedicated `GITHUB_ENCRYPTION_KEY` is preferred;
 * `BETTER_AUTH_SECRET` is the local fallback.
 *
 * Format: `v1:<iv b64>:<tag b64>:<data b64>`.
 */

const PREFIX = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_SALT = "buildx:github:v1";

let cachedKey: Buffer | undefined;

function encryptionKey(): Buffer {
  const secret = (
    process.env.GITHUB_ENCRYPTION_KEY ?? process.env.BETTER_AUTH_SECRET
  )?.trim();
  if (!secret) {
    throw new Error(
      "GITHUB_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) must be set to store GitHub tokens",
    );
  }
  cachedKey ??= scryptSync(secret, KEY_SALT, 32);
  return cachedKey;
}

export function encryptToken(token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const data = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    PREFIX,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(":");
}

export function decryptToken(payload: string): string {
  const [prefix, iv, tag, data] = payload.split(":");
  if (prefix !== PREFIX || !iv || !tag || !data) {
    throw new Error("Unsupported GitHub token payload");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
