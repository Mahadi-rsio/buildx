import type { Sandbox } from "@buildx/sandbox";
import type { FileChangePayload, TodoItem } from "@buildx/shared";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_READ_LIMIT = 400;
/** Applied when the model omits timeoutMs, so an interactive CLI cannot hang the run. */
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_STDOUT_CHARS = 12_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_TOTAL_OUTPUT_CHARS = 16_000;
const MAX_LIST_DIR_ENTRIES = 500;
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
  /**
   * Called before every workspace mutation so the harness can ensure a task
   * branch exists. Returning a branch name records it on the checkpoint;
   * `undefined` means the workspace is not a git repository.
   */
  onBeforeMutate?: () => void | string | Promise<void | string>;
  /**
   * Pause for a structured user question. Resolves with the answer when the
   * user has already responded in this process; otherwise throws
   * `WaitingForUserError` so the run can checkpoint and wait.
   */
  onAskUser?: (request: {
    toolCallId: string;
    question: string;
    options?: Array<{ id: string; label: string }>;
  }) => Promise<{ answer: string }>;
}

/** Thrown by `ask_user` when the run must pause for a durable user answer. */
export class WaitingForUserError extends Error {
  readonly question: string;
  readonly options?: Array<{ id: string; label: string }>;
  readonly toolCallId: string;

  constructor(input: {
    toolCallId: string;
    question: string;
    options?: Array<{ id: string; label: string }>;
  }) {
    super("waiting_input");
    this.name = "WaitingForUserError";
    this.toolCallId = input.toolCallId;
    this.question = input.question;
    this.options = input.options;
  }
}

interface TruncatedText {
  text: string;
  truncated: boolean;
  omitted: number;
}

/**
 * Keep a bounded head+tail view. `tailShare` decides how much of the budget is
 * reserved for the end of the text, so stderr can preserve the actual failure.
 */
function truncateMiddle(
  text: string,
  maxChars: number,
  tailShare = 0.5,
): TruncatedText {
  if (text.length <= maxChars) {
    return { text, truncated: false, omitted: 0 };
  }
  const roughNotice = "\n\n… [truncated 000000000 chars; kept head and tail] …\n\n";
  let budget = Math.max(0, maxChars - roughNotice.length);
  let headLen = Math.floor(budget * (1 - tailShare));
  let tailLen = Math.max(0, budget - headLen);
  let omitted = text.length - headLen - tailLen;
  let notice = `\n\n… [truncated ${omitted} chars; kept first ${headLen} and last ${tailLen}] …\n\n`;
  budget = Math.max(0, maxChars - notice.length);
  headLen = Math.floor(budget * (1 - tailShare));
  tailLen = Math.max(0, budget - headLen);
  omitted = text.length - headLen - tailLen;
  notice = `\n\n… [truncated ${omitted} chars; kept first ${headLen} and last ${tailLen}] …\n\n`;
  return {
    text: text.slice(0, headLen) + notice + text.slice(text.length - tailLen),
    truncated: true,
    omitted,
  };
}

/** Strip CSI / OSC ANSI sequences so model summaries stay readable. */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "");
}

/**
 * Collapse repetitive progress noise (identical consecutive lines, spinner
 * frames, bare percent counters) without dropping error context.
 */
function scrubProgressNoise(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prev = "";
  let repeat = 0;
  for (const line of lines) {
    const normalized = line
      .replace(/[\u2800-\u28ff]/g, "")
      .replace(/[\\|/-]\s*$/g, "")
      .replace(/\s+/g, " ")
      .trimEnd();
    const isProgress =
      /^\s*(?:\d{1,3}%|download|downloading|progress|eta\b)/i.test(normalized) ||
      /^[\s.*=#\-_|/\\]+$/.test(normalized);
    if (normalized === prev) {
      repeat += 1;
      continue;
    }
    if (repeat > 0) {
      out.push(`… [repeated previous line ${repeat} more times]`);
      repeat = 0;
    }
    if (isProgress && out.length > 0 && out[out.length - 1] === normalized) {
      continue;
    }
    out.push(line);
    prev = normalized;
  }
  if (repeat > 0) out.push(`… [repeated previous line ${repeat} more times]`);
  return out.join("\n");
}

function cleanBashStream(text: string): string {
  return scrubProgressNoise(stripAnsi(text));
}

/** Bound each stream and the combined result without dropping stderr's tail. */
function boundBashOutput(
  rawStdout: string,
  rawStderr: string,
): { stdout: string; stderr: string; truncated: boolean } {
  const cleanedStdout = cleanBashStream(rawStdout);
  const cleanedStderr = cleanBashStream(rawStderr);
  const stdout = truncateMiddle(cleanedStdout, MAX_STDOUT_CHARS);
  const stderr = truncateMiddle(cleanedStderr, MAX_STDERR_CHARS, 0.75);
  let boundedStdout = stdout.text;
  const boundedStderr = stderr.text;
  let truncated =
    stdout.truncated ||
    stderr.truncated ||
    cleanedStdout.length !== rawStdout.length ||
    cleanedStderr.length !== rawStderr.length;

  if (boundedStdout.length + boundedStderr.length > MAX_TOTAL_OUTPUT_CHARS) {
    const stdoutBudget = Math.max(
      0,
      MAX_TOTAL_OUTPUT_CHARS - boundedStderr.length,
    );
    const total = truncateMiddle(boundedStdout, stdoutBudget, 0.4);
    boundedStdout = total.text;
    truncated = truncated || total.truncated;
  }

  return { stdout: boundedStdout, stderr: boundedStderr, truncated };
}

/** Persist the full raw command transcript in the durable sandbox filesystem. */
async function writeBashLog(
  sandbox: Sandbox,
  toolCallId: string | undefined,
  payload: {
    command: string;
    cwd: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  },
): Promise<string | undefined> {
  if (!toolCallId) return undefined;
  const safeId = toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const logPath = `.buildx/logs/${safeId}.log`;
  const body = [
    `# buildx bash log`,
    `command: ${payload.command}`,
    `cwd: ${payload.cwd}`,
    `exitCode: ${payload.exitCode}`,
    `durationMs: ${payload.durationMs}`,
    ``,
    `--- stdout ---`,
    payload.stdout,
    ``,
    `--- stderr ---`,
    payload.stderr,
    ``,
  ].join("\n");
  try {
    await sandbox.writeFile(logPath, body);
    return logPath;
  } catch {
    return undefined;
  }
}

/**
 * On failure, surface a short durable-log tail for targeted debugging. Reads
 * only the last lines of the log instead of loading a potentially huge file.
 */
async function readLogTail(
  sandbox: Sandbox,
  logPath: string | undefined,
  maxChars = 2_000,
): Promise<string | undefined> {
  if (!logPath) return undefined;
  try {
    const { stdout } = await execCapture(
      sandbox,
      `tail -n 80 -- ${shellQuote(logPath)} 2>/dev/null`,
    );
    const content = stdout.trim();
    if (!content) return undefined;
    if (content.length <= maxChars) return content;
    return truncateMiddle(content, maxChars, 0.8).text;
  } catch {
    return undefined;
  }
}

/** Build a short unified-diff style snippet around the first changed region. */
function summarizeEditDiff(
  before: string,
  after: string,
  path: string,
): string {
  if (before === after) return `(no content change in ${path})`;
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    beforeLines[endBefore] === afterLines[endAfter]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const ctx = 2;
  const from = Math.max(0, start - ctx);
  const removed = beforeLines.slice(from, endBefore + 1 + ctx);
  const added = afterLines.slice(from, endAfter + 1 + ctx);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${removed.length} +${from + 1},${added.length} @@`,
    ...removed.slice(0, 40).map((line) => `- ${line}`),
    ...added.slice(0, 40).map((line) => `+ ${line}`),
  ];
  return lines.join("\n");
}

/** Suggest nearby context when an exact `old_str` miss happens. */
function suggestEditContext(content: string, oldStr: string): string {
  const needle = oldStr.trim().split("\n")[0]?.trim() ?? "";
  if (!needle || needle.length < 4) {
    return "Reread a narrow range around the intended edit and retry with exact surrounding context.";
  }
  const lines = content.split("\n");
  const hits: string[] = [];
  const lower = needle.toLowerCase();
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    if (lines[i].toLowerCase().includes(lower.slice(0, Math.min(48, lower.length)))) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length, i + 2);
      hits.push(
        numberLines(lines.slice(from, to).join("\n"), from),
      );
    }
  }
  if (hits.length === 0) {
    return "old_str not found; use grep to locate the symbol, then read_file a small range and retry.";
  }
  return `old_str not found. Nearby candidates:\n${hits.join("\n---\n")}`;
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

const EXIT_MARKER = /\n?\[buildx: command exited with code (-?\d+)\]\n?/g;

/** Extract the sandbox's synthetic exit trailer and remove it from the text. */
function extractExitMarker(text: string): { text: string; exitCode?: number } {
  let exitCode: number | undefined;
  const cleaned = text.replace(EXIT_MARKER, (_match, code: string) => {
    exitCode = Number(code);
    return "";
  });
  return { text: cleaned, exitCode };
}

/** Strip the sandbox's synthetic "command exited" trailer from stderr. */
function stripExitMarker(text: string): string {
  return extractExitMarker(text).text.trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(message = "Tool execution aborted: run cancelled"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
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
      "Run a shell command in the workspace. Returns structured stdout, stderr, " +
      "exitCode, and a truncation flag; stdout and stderr are bounded separately and " +
      "non-zero exits are normal results. Commands are non-interactive (stdin is " +
      "closed) and are killed after 3 minutes unless timeoutMs is set. Prefer " +
      "targeted commands (grep/sed, head, test runners) over dumping whole files or " +
      "directories, and do not repeat a command whose output you already have. " +
      "Scaffolding tools such as `npm create vue` must be given non-interactive flags " +
      "(`--yes`, `--default`).",
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
      if (options?.abortSignal?.aborted) throw abortError();

      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
      const onAbort = (): void => controller.abort();
      options?.abortSignal?.addEventListener("abort", onAbort, { once: true });

      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      try {
        for await (const chunk of sandbox.exec(command, {
          cwd,
          signal: controller.signal,
        })) {
          if (chunk.stream === "stdout") stdout += chunk.data;
          else stderr += chunk.data;
          await hooks.onTerminal?.({
            stream: chunk.stream,
            chunk: chunk.data,
            toolCallId: options?.toolCallId,
          });
        }
      } catch (error) {
        const cancelled =
          options?.abortSignal?.aborted === true ||
          (!timedOut && isAbortError(error));
        if (cancelled || !timedOut) throw error;
      } finally {
        clearTimeout(timer);
        options?.abortSignal?.removeEventListener("abort", onAbort);
      }

      if (options?.abortSignal?.aborted && !timedOut) throw abortError();

      const parsed = extractExitMarker(stderr);
      stderr = parsed.text;
      if (timedOut) {
        stderr += `\n[buildx: command timed out after ${timeout}ms]\n`;
      }
      const exitCode = timedOut ? 124 : (parsed.exitCode ?? 0);
      const durationMs = Date.now() - startedAt;
      const rawStdout = stdout.trimEnd();
      const rawStderr = stderr.trimEnd();
      const logPath = await writeBashLog(sandbox, options?.toolCallId, {
        command,
        cwd: cwd ?? ".",
        exitCode,
        stdout: rawStdout,
        stderr: rawStderr,
        durationMs,
      });
      const bounded = boundBashOutput(rawStdout, rawStderr);
      const failureTail =
        exitCode !== 0
          ? await readLogTail(sandbox, logPath)
          : undefined;
      const errorLine = bounded.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      const summary = timedOut
        ? `Command timed out after ${timeout}ms`
        : exitCode !== 0
          ? `Command failed with exit code ${exitCode}${errorLine ? `: ${errorLine.slice(0, 300)}` : ""}`
          : "Command completed successfully";
      const result = {
        command,
        cwd: cwd ?? ".",
        exitCode,
        summary,
        stdout: bounded.stdout,
        stderr: bounded.stderr,
        truncated: bounded.truncated,
        durationMs,
        ...(logPath
          ? {
              logPath,
              logDurable: true as const,
              ...(failureTail ? { logTail: failureTail } : {}),
            }
          : {}),
        ...(timedOut ? { timedOut: true } : {}),
      };
      return result;
    },
  });

  const read_file = tool({
    description:
      "Read a file with line numbers, optionally restricted to a line range. " +
      "Prefer narrow ranges (offset/limit) and `sed -n`/`grep` over rereading " +
      "entire files.",
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
    description:
      "Create a new file with the given content. Refuses to replace an existing " +
      "file unless `overwrite` is true; use `edit_file` for focused patches to " +
      "existing sources instead of rewriting the whole file.",
    inputSchema: z.object({
      path: z.string().describe("File path relative to the workspace root"),
      content: z.string().describe("Full file content"),
      overwrite: z
        .boolean()
        .optional()
        .describe("Allow replacing an existing file; only for intentional rewrites"),
    }),
    execute: async ({ path, content, overwrite }, options) => {
      if (options?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      let existing: string | undefined;
      try {
        existing = await sandbox.readFile(path);
      } catch {
        existing = undefined;
      }
      if (existing !== undefined && !overwrite) {
        throw new Error(
          `${path} already exists. Use edit_file for a focused patch, or pass overwrite: true only when the whole file must change.`,
        );
      }
      await hooks.onBeforeMutate?.();
      await sandbox.writeFile(path, content);
      await hooks.onFileChange?.({
        path,
        change: existing === undefined ? "create" : "write",
      });
      return { path, bytes: Buffer.byteLength(content, "utf8") };
    },
  });

  const edit_file = tool({
    description:
      "Apply a focused patch to an existing file by replacing an exact string. " +
      "`old_str` must match the current file exactly and uniquely unless " +
      "`replace_all` is true. Prefer this over rewrite-via-write_file. On " +
      "mismatch, reread only the affected range and retry with more context.",
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
      if (old_str.length === 0) {
        throw new Error("old_str must not be empty");
      }
      const content = await sandbox.readFile(path);
      const count = content.split(old_str).length - 1;
      if (count === 0) {
        throw new Error(suggestEditContext(content, old_str));
      }
      if (count > 1 && !replace_all) {
        throw new Error(
          `old_str matched ${count} times in ${path}; pass replace_all or add more context`,
        );
      }
      const next = replace_all
        ? content.split(old_str).join(new_str)
        : content.replace(old_str, new_str);
      await hooks.onBeforeMutate?.();
      // Re-read immediately before write to catch concurrent drift.
      const latest = await sandbox.readFile(path);
      if (latest !== content) {
        throw new Error(
          `File ${path} changed while preparing the patch; reread the affected range and retry.`,
        );
      }
      await sandbox.writeFile(path, next);
      await hooks.onFileChange?.({ path, change: "edit" });
      return {
        path,
        replacements: replace_all ? count : 1,
        diff: summarizeEditDiff(content, next, path),
      };
    },
  });

  const ask_user = tool({
    description:
      "Ask the user a concise clarifying question with optional multiple-choice " +
      "answers, then wait for their reply. Use before destructive actions, " +
      "significant overwrites, unapproved publishing, production changes, or " +
      "irreversible operations. Do not ask before routine file edits or safe tests.",
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(2_000)
        .describe("Concise question shown to the user"),
      options: z
        .array(
          z.object({
            id: z.string().min(1).max(64),
            label: z.string().min(1).max(200),
          }),
        )
        .min(1)
        .max(8)
        .optional()
        .describe("Optional structured answer choices"),
    }),
    execute: async ({ question, options: answerOptions }, toolOptions) => {
      if (toolOptions?.abortSignal?.aborted) {
        throw new Error("Tool execution aborted: run cancelled");
      }
      const toolCallId = toolOptions?.toolCallId ?? `ask-${Date.now()}`;
      const deduped = answerOptions
        ? [
            ...new Map(
              answerOptions.map((option) => [option.id.trim(), option] as const),
            ).values(),
          ].filter((option) => option.id.length > 0 && option.label.trim().length > 0)
        : undefined;
      if (!hooks.onAskUser) {
        throw new WaitingForUserError({
          toolCallId,
          question: question.trim(),
          options: deduped,
        });
      }
      const result = await hooks.onAskUser({
        toolCallId,
        question: question.trim(),
        options: deduped,
      });
      return { question: question.trim(), answer: result.answer, options: deduped };
    },
  });

  const list_dir = tool({
    description:
      "List files and directories up to a depth, ignoring common build and VCS " +
      "directories. Entries are capped; use glob/grep or read_file ranges instead " +
      "of repeatedly dumping large trees.",
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
      const truncated = entries.length > MAX_LIST_DIR_ENTRIES;
      return {
        path: dir,
        entries: entries.slice(0, MAX_LIST_DIR_ENTRIES),
        truncated,
      };
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
    ask_user,
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
