import type { NextConfig } from "next";

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
  transpilePackages: ["@buildx/agent", "@buildx/sandbox", "@buildx/shared"],
};

export default nextConfig;
