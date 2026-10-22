import type { NextConfig } from "next";
import { loadRootEnv } from "@buildx/shared/node";

// Next.js only auto-loads `.env` from the app directory, but this monorepo keeps
// a single `.env` at the repo root (shared with docker compose and the CLI
// scripts). Load it here, before any route module (and therefore the AI SDK or
// Better Auth) is evaluated.
loadRootEnv();

// Next loads `KEY=` from `.env` as `""` rather than unset; strip blanks for the
// optional agent vars before any route module (and therefore the AI SDK) loads.
for (const key of ["AGENT_MODEL", "AGENT_MAX_STEPS"]) {
  if (process.env[key] === "") delete process.env[key];
}

const nextConfig: NextConfig = {
  // Keep the dev overlay out of screenshots (and out of the chat surface).
  devIndicators: false,
  // Required for Docker deployment (standalone output produces minimal .next/standalone
  // directory with only necessary runtime files and dependencies).
  output: "standalone",
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
