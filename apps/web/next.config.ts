import type { NextConfig } from "next";
import { loadRootEnv } from "@buildx/shared/node";

// Next.js only auto-loads `.env` from the app directory, but this monorepo keeps
// a single `.env` at the repo root (shared with docker compose and the CLI
// scripts). Load it here, before any route module (and therefore the AI SDK or
// Better Auth) is evaluated.
loadRootEnv();

// `@ai-sdk/openai` builds a default provider at import time that throws when
// `OPENAI_BASE_URL` is an empty string — and Next loads `KEY=` from `.env` as
// `""` (`.env.example` ships the optional vars blank). Strip the empties here,
// before any route module (and therefore the SDK) is evaluated, so a blank
// optional var behaves like an unset one everywhere.
for (const key of [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AGENT_MODEL",
  "AGENT_MAX_STEPS",
]) {
  if (process.env[key] === "") delete process.env[key];
}

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript source (`./src/index.ts`), so Next must
  // transpile them before bundling.
  transpilePackages: [
    "@buildx/agent",
    "@buildx/sandbox",
    "@buildx/shared",
    "@buildx/db",
    "@buildx/storage",
  ],
};

export default nextConfig;
