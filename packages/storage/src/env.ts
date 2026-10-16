/**
 * Re-export the canonical server-side root-`.env` loader so storage scripts and
 * `packages/db` share a single implementation (`@buildx/shared/node`).
 */
export { loadRootEnv } from "@buildx/shared/node";