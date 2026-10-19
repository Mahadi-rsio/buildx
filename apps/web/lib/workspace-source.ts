import type { BoxSandbox } from "@buildx/sandbox";
import type { StoredRun } from "./store";
import { tryGetWorkspaceBox } from "./sandbox";

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

/** A fully read file (text or binary), mirroring the box `/fs` read. */
export interface WorkspaceFileRead {
  content: string;
  binary: boolean;
  size: number;
  mtime?: number;
}

/**
 * View over a run's persistent Upstash Box workspace. The web app reads file
 * trees, file contents, and diffs through this interface.
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
 * Box source: reads the workspace inside a persistent Upstash Box through the
 * same `BoxSandbox` methods the runner uses to exec.
 */
export class BoxWorkspaceSource implements WorkspaceSource {
  constructor(private readonly box: BoxSandbox) {}

  resolve(rel: string): string {
    const clean = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (clean.startsWith("/") || clean.split("/").includes("..")) {
      throw new Error("path escapes sandbox root");
    }
    return clean;
  }

  async listDir(rel: string): Promise<WorkspaceEntry[]> {
    const clean = rel === "." ? "" : rel.replace(/^\.?\//, "").replace(/\/+$/, "");
    const entries = await this.box.listDir(clean);
    const parent = clean;
    return entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: parent ? `${parent}/${entry.name}` : entry.name,
        type: entry.type,
      }));
  }

  async readFile(rel: string): Promise<WorkspaceFileRead> {
    const info = await this.box.readInfo(rel);
    return {
      content: info.content,
      binary: info.binary,
      size: info.size,
      mtime: info.mtime,
    };
  }

  async stat(rel: string): Promise<{ type: "file" | "dir" } | null> {
    return this.box.stat(rel);
  }

  async listFiles(): Promise<{ path: string; size: number; mtime?: number }[]> {
    const out: { path: string; size: number; mtime?: number }[] = [];
    await walk((rel) => this.listDir(rel), "", out);
    return out;
  }
}

/**
 * Empty source returned for box runs whose box hasn't been provisioned yet.
 * The file browser/diff reads through this until the agent's first sandbox
 * tool call creates the box; nothing here ever creates a box.
 */
class EmptyWorkspaceSource implements WorkspaceSource {
  resolve(rel: string): string {
    if (rel.split("/").includes("..")) throw new Error("path escapes sandbox root");
    return rel.replace(/^\.?\//, "");
  }
  async listDir(_rel: string): Promise<WorkspaceEntry[]> {
    return [];
  }
  async readFile(_rel: string): Promise<WorkspaceFileRead> {
    throw new Error("workspace not provisioned yet");
  }
  async stat(_rel: string): Promise<{ type: "file" | "dir" } | null> {
    return null;
  }
  async listFiles(): Promise<{ path: string; size: number; mtime?: number }[]> {
    return [];
  }
}

/** Read the user's persistent Box workspace for a run. */
export function sourceForRun(run: StoredRun): WorkspaceSource {
  return {
    resolve(rel: string): string {
      const clean = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
      if (clean.startsWith("/") || clean.split("/").includes("..")) {
        throw new Error("path escapes sandbox root");
      }
      return clean;
    },
    async listDir(rel: string) {
      const box = await tryGetWorkspaceBox(run.userId);
      if (!box) return new EmptyWorkspaceSource().listDir(rel);
      return new BoxWorkspaceSource(box).listDir(rel);
    },
    async readFile(rel: string) {
      const box = await tryGetWorkspaceBox(run.userId);
      if (!box) return new EmptyWorkspaceSource().readFile(rel);
      return new BoxWorkspaceSource(box).readFile(rel);
    },
    async stat(rel: string) {
      const box = await tryGetWorkspaceBox(run.userId);
      if (!box) return new EmptyWorkspaceSource().stat(rel);
      return new BoxWorkspaceSource(box).stat(rel);
    },
    async listFiles() {
      const box = await tryGetWorkspaceBox(run.userId);
      if (!box) return new EmptyWorkspaceSource().listFiles();
      return new BoxWorkspaceSource(box).listFiles();
    },
  };
}
