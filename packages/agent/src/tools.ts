import type { Sandbox } from "@buildx/sandbox";
import type { FileChangePayload, TodoItem } from "@buildx/shared";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_READ_LIMIT = 400;
const MAX_OUTPUT_CHARS = 20_000;
/** Applied when the model omits timeoutMs, so an interactive CLI cannot hang the run. */
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_SEARCH_FILES = 300;
const MAX_SEARCH_FILE_CHARS = 200_000;
const SEARCH_CHUNK_LINES = 40;
const SEARCH_CHUNK_OVERLAP = 10;
const IGNORED_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
];

/** Side-channel callbacks so tools can surface durable events. */
export interface ToolHooks {
  /** Called whenever the agent replaces its visible task list. */
  onTodo?: (todos: TodoItem[]) => void | Promise<void>;
  /** Called after a file is written or edited. */
  onFileChange?: (change: FileChangePayload) => void | Promise<void>;
  /** Called for every chunk a bash command streams. */
  onTerminal?: (chunk: {
    stream: "stdout" | "stderr";
    chunk: string;
    toolCallId?: string;
  }) => void | Promise<void>;
}

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

/** Strip the sandbox's synthetic "command exited" trailer from stderr. */
function stripExitMarker(text: string): string {
  return text.replace(/\n?\[buildx: command exited with code \d+\]\n?/g, "").trim();
}

async function execCapture(
  sandbox: Sandbox,
  command: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  for await (const chunk of sandbox.exec(command, { signal })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
    else stderr += chunk.data;
  }
  return { stdout, stderr };
}

function ignorePrune(): string {
  return IGNORED_DIRS.map((name) => `-name ${shellQuote(name)}`).join(" -o ");
}

/** List workspace files with ripgrep when available, falling back to find. */
async function listWorkspaceFiles(
  sandbox: Sandbox,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const target = path && path.trim().length > 0 ? path.trim() : ".";
  const prune = ignorePrune();
  const command = [
    "if command -v rg >/dev/null 2>&1; then",
    `rg --files ${shellQuote(target)};`,
    "else",
    `find ${shellQuote(target)} -type f \\( ${prune} \\) -prune -o -type f -print;`,
    "fi",
  ].join(" ");
  const { stdout } = await execCapture(sandbox, command, signal);
  return stdout
    .split("\n")
    .map((line) => (line.startsWith("./") ? line.slice(2) : line.trim()))
    .filter((line) => line.length > 0)
    .filter((line) => !line.split("/").some((part) => IGNORED_DIRS.includes(part)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal glob → RegExp (supports `*`, `**`, `?`, `{a,b}`, and literals). */
function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/^\.\//, "");
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end > i) {
        const options = pattern
          .slice(i + 1, end)
          .split(",")
          .map(escapeRegExp);
        out += `(?:${options.join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesGlobs(path: string, globs: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return globs.some((glob) => {
    const regex = globToRegExp(glob);
    return regex.test(normalized) || (!glob.includes("/") && regex.test(base));
  });
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "where",
  "what",
  "when",
  "how",
  "why",
  "does",
  "did",
  "are",
  "was",
  "were",
  "you",
  "your",
  "our",
  "not",
  "but",
  "all",
  "any",
  "can",
  "could",
  "should",
  "would",
  "file",
  "files",
  "code",
  "function",
  "please",
]);

function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ss")) return word;
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Tokenize text, splitting camelCase/snake_case and dropping noise. */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(stem)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** Preserve input order while running at most `limit` promises concurrently. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface SearchChunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
}

function chunkFile(path: string, content: string): SearchChunk[] {
  const lines = content.split("\n");
  const chunks: SearchChunk[] = [];
  const step = SEARCH_CHUNK_LINES - SEARCH_CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + SEARCH_CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length === 0) continue;
    chunks.push({
      path,
      startLine: start + 1,
      endLine: end,
      text,
      tokens: tokenize(`${path}\n${text}`),
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

function rankChunks(
  chunks: SearchChunk[],
  queryTokens: string[],
  limit: number,
): Array<SearchChunk & { score: number }> {
  if (chunks.length === 0 || queryTokens.length === 0) return [];
  const documentFrequency = new Map<string, number>();
  for (const chunk of chunks) {
    for (const token of new Set(chunk.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = chunks.length;
  const scored = chunks.map((chunk) => {
    const counts = new Map<string, number>();
    for (const token of chunk.tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    let score = 0;
    for (const query of queryTokens) {
      const frequency = counts.get(query) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(query) ?? 0;
      const idf = Math.log(1 + total / (1 + df));
      const saturated = frequency / (frequency + 1.2);
      const pathBoost = chunk.path.toLowerCase().includes(query) ? 0.6 : 0;
      score += (saturated + pathBoost) * idf;
    }
    score /= Math.sqrt(Math.max(chunk.tokens.length, 20));
    return { ...chunk, score };
  });
  return scored
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * The core agent tool set: shell, ranged file IO, fast search, and a visible
 * todo list. Every tool runs through the `Sandbox` interface so the harness is
 * backend-agnostic.
 */
export function buildTools(sandbox: Sandbox, hooks: ToolHooks = {}) {
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
        await hooks.onTerminal?.({
          stream: chunk.stream,
          chunk: chunk.data,
          toolCallId: options?.toolCallId,
        });
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
      await hooks.onFileChange?.({ path, change: "write" });
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
      await hooks.onFileChange?.({ path, change: "edit" });
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
      const prune = ignorePrune();
      const command = `find ${shellQuote(dir)} -maxdepth ${maxDepth} \\( ${prune} \\) -prune -o -print`;

      const { stdout, stderr } = await execCapture(
        sandbox,
        command,
        options?.abortSignal,
      );
      const error = stripExitMarker(stderr);
      if (!stdout.trim() && error) {
        throw new Error(error);
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

  const grep = tool({
    description:
      "Search file contents with ripgrep (falls back to grep): regex pattern, " +
      "optional globs, context lines, and content/files/count modes. Prefer this " +
      "over `bash grep` — it already ignores build and VCS directories.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Regular expression to search for"),
      path: z
        .string()
        .optional()
        .describe("Directory or file to search; defaults to '.'"),
      glob: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("One or more file globs, e.g. '*.ts' or 'src/**/*.tsx'"),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Lines of context around each match (default 2)"),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Maximum matches/files to return (default 100)"),
      mode: z
        .enum(["content", "files", "count"])
        .optional()
        .describe("Return matching lines (default), file paths, or per-file counts"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe("Match case; defaults to false (case-insensitive)"),
    }),
    execute: async (input, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      const target = input.path?.trim() || ".";
      const globs = input.glob
        ? Array.isArray(input.glob)
          ? input.glob
          : [input.glob]
        : [];
      const mode = input.mode ?? "content";
      const context = input.contextLines ?? 2;
      const maxResults = input.maxResults ?? 100;
      const caseFlag = input.caseSensitive ? "" : "-i";
      const globFlags = globs.map((glob) => `-g ${shellQuote(glob)}`).join(" ");
      const includeFlags = globs
        .map((glob) => `--include=${shellQuote(glob)}`)
        .join(" ");
      const excludes = IGNORED_DIRS.map(
        (dir) => `--exclude-dir=${shellQuote(dir)}`,
      ).join(" ");
      const modeFlag =
        mode === "files" ? "--files-with-matches" : mode === "count" ? "--count" : "";
      const grepModeFlag =
        mode === "files" ? "-l" : mode === "count" ? "-c" : "";
      const command = [
        "if command -v rg >/dev/null 2>&1; then",
        `rg --color never --no-heading --line-number ${caseFlag} ${modeFlag}`,
        mode === "content" ? `-C ${context} -m ${maxResults}` : "",
        globFlags,
        `-- ${shellQuote(input.pattern)} ${shellQuote(target)};`,
        "else",
        `grep -r -n --color=never ${caseFlag} ${grepModeFlag}`,
        mode === "content" ? `-C ${context} -m ${maxResults}` : "",
        includeFlags,
        excludes,
        `-e ${shellQuote(input.pattern)} -- ${shellQuote(target)};`,
        "fi",
      ]
        .filter(Boolean)
        .join(" ");

      const { stdout, stderr } = await execCapture(
        sandbox,
        command,
        options?.abortSignal,
      );
      const error = stripExitMarker(stderr);
      const output = stdout.trimEnd();
      if (!output && error) throw new Error(error);
      const lines = output.split("\n").filter(Boolean);
      const truncated = lines.length > maxResults;
      return {
        pattern: input.pattern,
        mode,
        matches: truncated
          ? `${lines.slice(0, maxResults).join("\n")}\n… ${lines.length - maxResults} more lines omitted`
          : output || "(no matches)",
        truncated,
      };
    },
  });

  const glob = tool({
    description:
      "Find files by glob pattern(s), e.g. '**/*.test.ts' or 'src/**/*.tsx'. " +
      "Ignores build and VCS directories.",
    inputSchema: z.object({
      pattern: z
        .union([z.string(), z.array(z.string())])
        .describe("One or more globs matched against workspace-relative paths"),
      path: z
        .string()
        .optional()
        .describe("Directory to search from; defaults to '.'"),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe("Maximum files to return (default 500)"),
    }),
    execute: async ({ pattern, path, maxResults }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      const globs = Array.isArray(pattern) ? pattern : [pattern];
      const limit = maxResults ?? 500;
      const files = await listWorkspaceFiles(sandbox, path, options?.abortSignal);
      const matched = files.filter((file) => matchesGlobs(file, globs));
      return {
        patterns: globs,
        files: matched.slice(0, limit),
        count: matched.length,
        truncated: matched.length > limit,
      };
    },
  });

  const semantic_search = tool({
    description:
      "Find the code most relevant to a natural-language query. Ranks file " +
      "chunks with local TF-IDF/BM25-style lexical relevance (no external index) " +
      "and returns path:line snippets. Use for 'where is X handled?' questions " +
      "when you don't know the exact symbol or string; use `grep` for exact matches.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe("Natural-language description of what you are looking for"),
      path: z
        .string()
        .optional()
        .describe("Directory to search from; defaults to '.'"),
      maxResults: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe("Maximum snippets to return (default 8)"),
      maxFiles: z
        .number()
        .int()
        .positive()
        .max(MAX_SEARCH_FILES)
        .optional()
        .describe("Maximum files to scan (default 200)"),
    }),
    execute: async ({ query, path, maxResults, maxFiles }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      const queryTokens = [...new Set(tokenize(query))];
      if (queryTokens.length === 0) {
        throw new Error("Query must contain at least one meaningful word");
      }
      const limit = maxResults ?? 8;
      const fileLimit = maxFiles ?? 200;
      const files = (
        await listWorkspaceFiles(sandbox, path, options?.abortSignal)
      ).slice(0, fileLimit);

      const chunks = (
        await mapLimit(files, 6, async (file) => {
          try {
            const content = await sandbox.readFile(file);
            if (content.length > MAX_SEARCH_FILE_CHARS) return [];
            return chunkFile(file, content);
          } catch {
            return [];
          }
        })
      ).flat();

      const ranked = rankChunks(chunks, queryTokens, limit);
      return {
        query,
        scannedFiles: files.length,
        results: ranked.map((chunk) => ({
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          score: Number(chunk.score.toFixed(3)),
          snippet: numberLines(chunk.text, chunk.startLine - 1),
        })),
      };
    },
  });

  const todo_write = tool({
    description:
      "Create or replace the visible plan/todo list. Call this before starting " +
      "any task with more than one step, then call it again whenever progress or " +
      "the plan changes. Keep exactly one item in_progress and mark items done " +
      "as soon as they are complete.",
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().min(1).max(500).describe("Short task description"),
            status: z
              .enum(["pending", "in_progress", "done"])
              .describe("Current state of this task"),
          }),
        )
        .min(1)
        .max(50)
        .describe("The complete, ordered task list"),
    }),
    execute: async ({ todos }) => {
      const normalized = todos
        .map((todo) => ({ content: todo.content.trim(), status: todo.status }))
        .filter((todo) => todo.content.length > 0);
      if (normalized.length === 0) {
        throw new Error("todos must contain at least one non-empty item");
      }
      await hooks.onTodo?.(normalized);
      return { todos: normalized };
    },
  });

  return {
    bash,
    read_file,
    write_file,
    edit_file,
    list_dir,
    grep,
    glob,
    semantic_search,
    todo_write,
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
