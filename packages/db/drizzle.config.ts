import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load the repo-root `.env` (the packages are workspace members; drizzle-kit runs
// from `packages/db`, so the file lives at `../../.env`).
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

/**
 * Drizzle Kit config (generate / migrate / studio all read this). Database
 * credentials come from the repo-root `.env` (see above); the config refuses to
 * build when DATABASE_URL is missing so mistakes fail loudly at the CLI.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      (() => {
        throw new Error(
          "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
        );
      })(),
  },
  strict: true,
  verbose: true,
});