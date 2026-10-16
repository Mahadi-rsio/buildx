import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspacePath } from "@buildx/sandbox";
import { DaemonSandbox } from "@buildx/sandbox";
import type { StoredRun } from "./store";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "build",
  ".turbo",
]);

/** An entry inside a listed directory. */
export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  /** Set for files where the backend can see it without reading. */
  size?: number;
  mtime?: number;
}

/** A fully read file (text or binary), mirroring the daemon's /fs read. */
export interface WorkspaceFileRead {
  content: string;
  binary: boolean;
  size: number;
  mtime?: number;
}

/**
 * Backend-agnostic view over a run's workspace. The web app reads file trees,
 * file contents, and diffs through this so it works identically whether the
 * run lives on the local disk or on a Fly Machine daemon.
 */
export interface WorkspaceSource {
  /** List one directory (relative path); throws on missing dirs. */
  listDir(rel: string): Promise<WorkspaceEntry[]>;
  /** Read one file fully; binary files come back with `binary: true`. */
  readFile(rel: string): Promise<WorkspaceFileRead>;
  /** Discover whether a path is a file or directory; null when missing. */
  stat(rel: string): Promise<{ type: "file" | "dir" } | null>;
  /** Recursively list every file, skipping ignored dirs (for snapshots). */
  listFiles(): Promise<{ path: string; size: number; mtime?: number }[]>;
  /** Resolve a user-supplied relative path, rejecting traversal. */
  resolve(rel: string): string;
}

/** Read a directory recursively, skipping ignored directories. */
async function walk(
  list: (rel: string) => Promise<WorkspaceEntry[]>,
  rel: string,
  out: { path: string; size: number; mtime?: number }[],
): Promise<void> {
  let entries: WorkspaceEntry[];
  try {
    entries = await list(rel);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.type === "dir") {
      await walk(list, entry.path, out);
      continue;
    }
    out.push({ path: entry.path, size: entry.size ?? 0, mtime: entry.mtime });
  }
}

/**
 * Local source: reads the workspace directly off the run's scratch directory.
 * Used in development and tests (no Fly machine configured).
 */
export class LocalWorkspaceSource implements WorkspaceSource {
  constructor(private readonly rootDir: string) {}

  resolve(rel: string): string {
    return resolveWorkspacePath(this.rootDir, rel);
  }

  async listDir(rel: string): Promise<WorkspaceEntry[]> {
    const key = (rel === "" || rel === ".") ? "" : rel.replace(/\/+$/, "");
    const target = this.resolve(key);
    const dirents = await readdir(target, { withFileTypes: true });
    const parent = key;
    const entries: WorkspaceEntry[] = [];
    for (const entry of dirents) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const entryPath = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push({
          name: entry.name,
          path: entryPath,
          type: "dir",
        });
        continue;
      }
      let info;
      try {
        info = await stat(join(target, entry.name));
      } catch {
        continue;
      }
      entries.push({
        name: entry.name,
        path: entryPath,
        type: "file",
        size: info.size,
        mtime: info.mtimeMs,
      });
    }
    return entries.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
  }

  async readFile(rel: string): Promise<WorkspaceFileRead> {
    const target = this.resolve(rel);
    const buffer = await readFile(target);
    return {
      content: buffer.toString("utf8"),
      binary: buffer.includes(0),
      size: buffer.byteLength,
    };
  }

  async stat(rel: string): Promise<{ type: "file" | "dir" } | null> {
    const target = this.resolve(rel);
    try {
      return { type: (await stat(target)).isDirectory() ? "dir" : "file" };
    } catch {
      return null;
    }
  }

  async listFiles(): Promise<{ path: string; size: number; mtime?: number }[]> {
    const out: { path: string; size: number; mtime?: number }[] = [];
    await walk((rel) => this.listDir(rel), "", out);
    return out;
  }
}

/**
 * Remote source: reads the workspace through the sandbox daemon on a Fly
 * Machine via the shared HTTP API (`/fs`), same paths the runner uses to exec.
 */
export class DaemonWorkspaceSource implements WorkspaceSource {
  constructor(private readonly daemon: DaemonSandbox) {}

  resolve(rel: string): string {
    // The daemon resolves paths itself against /workspace; nothing to do here.
    return rel;
  }

  async listDir(rel: string): Promise<WorkspaceEntry[]> {
    const clean = rel === "." ? "" : rel.replace(/^\.?\//, "").replace(/\/+$/, "");
    const entries = await this.daemon.listDir(clean);
    const parent = clean;
    return entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: parent ? `${parent}/${entry.name}` : entry.name,
        type: entry.type,
        size: (entry as WorkspaceEntry).size,
        mtime: (entry as WorkspaceEntry).mtime,
      }));
  }

  async readFile(rel: string): Promise<WorkspaceFileRead> {
    const info = await this.daemon.readInfo(rel);
    if (info.type === "dir") {
      throw new Error(`not a file: ${rel}`);
    }
    return {
      content: info.content,
      binary: info.binary,
      size: info.size,
      mtime: info.mtime,
    };
  }

  async stat(rel: string): Promise<{ type: "file" | "dir" } | null> {
    try {
      const info = await this.daemon.readInfo(rel);
      return { type: info.type === "dir" ? "dir" : "file" };
    } catch {
      return null;
    }
  }

  async listFiles(): Promise<{ path: string; size: number; mtime?: number }[]> {
    const out: { path: string; size: number; mtime?: number }[] = [];
    await walk((rel) => this.listDir(rel), "", out);
    return out;
  }
}

/** Build the right source for a run based on the sandbox mode. */
export function sourceForRun(run: StoredRun): WorkspaceSource {
  const baseUrl = (process.env.SANDBOX_BASE_URL ?? "").trim();
  const token = (process.env.SANDBOX_TOKEN ?? "").trim();
  if (baseUrl && token) {
    return new DaemonWorkspaceSource(
      new DaemonSandbox({ baseUrl, token }),
    );
  }
  return new LocalWorkspaceSource(run.workspaceDir);
}