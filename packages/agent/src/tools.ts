import type { Sandbox } from "@buildx/sandbox";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_READ_LIMIT = 400;
const MAX_OUTPUT_CHARS = 20_000;
/** Applied when the model omits timeoutMs, so an interactive CLI cannot hang the run. */
const DEFAULT_TIMEOUT_MS = 180_000;
const IGNORED_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
];

/** Keep the head and tail of long output, eliding the middle. */
function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n… ${omitted} characters omitted — narrow the command …\n\n${tail}`;
}

/** Prefix each line with its 1-based number, starting at `startLine`. */
function numberLines(content: string, startLine: number): string {
  return content
    .split("\n")
    .map((line, index) => `${String(startLine + index + 1).padStart(5)}\t${line}`)
    .join("\n");
}

/** POSIX single-quote a string for safe interpolation into a shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The Phase 2 core tool set (arcetecture.md §3.1): bash, read_file, write_file,
 * edit_file, list_dir. Every tool runs through the `Sandbox` interface so the
 * harness is backend-agnostic.
 */
export function buildTools(sandbox: Sandbox) {
  const bash = tool({
    description:
      "Run a shell command in the workspace and return combined stdout/stderr. " +
      "Long output is truncated. Commands are non-interactive (stdin is closed) and " +
      "are killed after 3 minutes unless timeoutMs is set. Scaffolding tools such as " +
      "`npm create vue` must be given non-interactive flags (`--yes`, `--default`).",
    inputSchema: z.object({
      command: z.string().describe("The shell command to run"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory relative to the workspace root"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Kill the command after this many milliseconds"),
    }),
    execute: async ({ command, cwd, timeoutMs }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      let output = "";
      for await (const chunk of sandbox.exec(command, {
        cwd,
        timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options?.abortSignal,
      })) {
        output += chunk.data;
      }
      return { output: truncate(output.trimEnd() || "(no output)") };
    },
  });

  const read_file = tool({
    description:
      "Read a file, optionally restricted to a line range, with line numbers.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the workspace root"),
      offset: z.number().int().min(0).optional().describe("0-based first line"),
      limit: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe("Number of lines to read"),
    }),
    execute: async ({ path, offset, limit }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      const startLine = offset ?? 0;
      const content = await sandbox.readFile(path, {
        offset: startLine,
        limit: limit ?? DEFAULT_READ_LIMIT,
      });
      return {
        path,
        startLine: startLine + 1,
        content: numberLines(content, startLine),
      };
    },
  });

  const write_file = tool({
    description: "Create or overwrite a file with the given content.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the workspace root"),
      content: z.string().describe("Full file content"),
    }),
    execute: async ({ path, content }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      await sandbox.writeFile(path, content);
      return { path, bytes: Buffer.byteLength(content, "utf8") };
    },
  });

  const edit_file = tool({
    description:
      "Replace an exact string in a file. `old_str` must match exactly and " +
      "uniquely, unless `replace_all` is true.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the workspace root"),
      old_str: z.string().describe("Exact text to find"),
      new_str: z.string().describe("Replacement text"),
      replace_all: z
        .boolean()
        .optional()
        .describe("Replace every occurrence instead of requiring a unique match"),
    }),
    execute: async ({ path, old_str, new_str, replace_all }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      const content = await sandbox.readFile(path);
      const count = content.split(old_str).length - 1;
      if (old_str.length === 0) {
        throw new Error("old_str must not be empty");
      }
      if (count === 0) {
        throw new Error(`old_str not found in ${path}`);
      }
      if (count > 1 && !replace_all) {
        throw new Error(
          `old_str matched ${count} times in ${path}; pass replace_all or add more context`,
        );
      }
      const next = replace_all
        ? content.split(old_str).join(new_str)
        : content.replace(old_str, new_str);
      await sandbox.writeFile(path, next);
      return { path, replacements: replace_all ? count : 1 };
    },
  });

  const list_dir = tool({
    description:
      "List files and directories up to a depth, ignoring common build and VCS directories.",
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe("Directory relative to the workspace root; defaults to '.'"),
      depth: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe("Maximum directory depth; defaults to 2"),
    }),
    execute: async ({ path, depth }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      const dir = path && path.length > 0 ? path : ".";
      const maxDepth = depth ?? 2;
      const prune = IGNORED_DIRS.map((name) => `-name ${shellQuote(name)}`).join(
        " -o ",
      );
      const command = `find ${shellQuote(dir)} -maxdepth ${maxDepth} \\( ${prune} \\) -prune -o -print`;

      let stdout = "";
      let stderr = "";
      for await (const chunk of sandbox.exec(command, {
        signal: options?.abortSignal,
      })) {
        if (chunk.stream === "stdout") stdout += chunk.data;
        else stderr += chunk.data;
      }
      if (!stdout.trim() && stderr.trim()) {
        throw new Error(stderr.trim());
      }
      const entries = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => (line.startsWith("./") ? line.slice(2) : line))
        .filter((line) => line.length > 0)
        .sort();
      return { path: dir, entries };
    },
  });

  return { bash, read_file, write_file, edit_file, list_dir };
}

export type AgentTools = ReturnType<typeof buildTools>;
