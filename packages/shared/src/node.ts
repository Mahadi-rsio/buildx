import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

function loadFrom(startDir: string): boolean {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      // Node's loadEnvFile parses without overriding variables already present
      // in process.env, so an ambient OPENAI_API_KEY etc. still wins.
      process.loadEnvFile(candidate);
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Server-only helper: load the repo-root `.env` into `process.env`.
 *
 * Workspace packages, root scripts and the Better Auth CLI run from different
 * working directories, and Next.js only auto-loads `.env` from the app
 * directory — so env files at the monorepo root are not picked up by default.
 * This walks up from the caller's directory (and, as a fallback, the current
 * working directory) until it finds a `.env` and loads it once. It never
 * overrides already-set variables and is a no-op outside the repo.
 *
 * Import this from server code only (`@buildx/shared/node`); it touches
 * `node:fs` and must never be pulled into a client bundle.
 */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;

  const starts: string[] = [];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // `import.meta.url` is unavailable under some CJS/loader contexts.
  }
  starts.push(process.cwd());

  for (const start of starts) {
    try {
      if (loadFrom(start)) return;
    } catch {
      // Keep trying other roots.
    }
  }
}