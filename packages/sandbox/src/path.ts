import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve `path` inside `root`, rejecting anything that would escape the
 * workspace (`../` or absolute paths). Used by sandbox adapters and by API
 * handlers that touch workspace files. Lives in its own module so both the
 * package index and the adapters can import it without a cycle.
 */
export function resolveWorkspacePath(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes sandbox root: ${path}`);
  }
  return resolved;
}
