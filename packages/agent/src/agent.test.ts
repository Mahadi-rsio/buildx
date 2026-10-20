import assert from "node:assert/strict";
import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { TestSandbox } from "./test-sandbox";
import type { RunEvent } from "@buildx/shared";
import { runTask } from "./index";
import { buildTools } from "./tools";

type ChatRequest = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
};

let server: Server;
let baseURL: string;
let modelRequests = 0;

/**
 * A minimal OpenAI-compatible Chat Completions streaming endpoint. On the first
 * request it asks the model to call `write_file`; once a tool result is present
 * it replies with final text, exercising the full loop + tool execution.
 */
before(async () => {
  server = createServer((req, res) => {
    modelRequests += 1;
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: ChatRequest;
      try {
        body = JSON.parse(raw || "{}") as ChatRequest;
      } catch {
        body = {};
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = messages.some((m) => m.role === "tool");
      const model = body.model ?? "gpt-4o-mini";
      const userMsg = messages.find((m) => m.role === "user");
      const userText = typeof userMsg?.content === "string" ? userMsg.content : "";

      if (userText === "bad-tool-name") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Tool call validation failed: attempted to call tool 'repo_browser.print_tree' which was not in request.tools",
              type: "invalid_request_error",
              code: "bad_request",
            },
          }),
        );
        return;
      }

      if (userText === "tool-use-failed") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            message: "invalid literal for int() with base 10: 'tool_use_failed'",
            type: "None",
            param: "None",
            code: "500",
          }),
        );
        return;
      }

      if (userText === "paid-model-blocked") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Free tier users do not have access to this model. Upgrade to paid credits for unrestricted access.",
              type: "no_providers_available",
            },
          }),
        );
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const chunk = (delta: unknown, finishReason: string | null) => ({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      const send = (payload: unknown) =>
        res.write(`data: ${JSON.stringify(payload)}\n\n`);

      if (userText === "slow-generation") {
        send(chunk({ role: "assistant", content: "first chunk" }, null));
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(timer);
            return;
          }
          send(chunk({ role: "assistant", content: " more text" }, null));
        }, 80);
        req.on("close", () => clearInterval(timer));
        return;
      }

      if (userText === "mcp-call") {
        if (!hasToolResult) {
          send(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mcp",
                    type: "function",
                    function: {
                      name: "mcp_test__echo",
                      arguments: JSON.stringify({ text: "hello mcp" }),
                    },
                  },
                ],
              },
              null,
            ),
          );
          send(chunk({}, "tool_calls"));
        } else {
          send(chunk({ role: "assistant", content: "MCP echo done" }, null));
          send(chunk({}, "stop"));
        }
        send({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const compacted = messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.includes("compacted to stay within"),
      );
      if (userText.startsWith("compact") || compacted) {
        if (!compacted) {
          send(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_summarize",
                    type: "function",
                    function: {
                      name: "summarize_context",
                      arguments: "{}",
                    },
                  },
                ],
              },
              null,
            ),
          );
          send(chunk({}, "tool_calls"));
        } else {
          send(
            chunk({ role: "assistant", content: "Compacted and finished" }, null),
          );
          send(chunk({}, "stop"));
        }
        send({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (userText === "slow-tool") {
        if (!hasToolResult) {
          send(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_slow",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({ command: "slow-command" }),
                    },
                  },
                ],
              },
              null,
            ),
          );
          send(chunk({}, "tool_calls"));
          send({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
      }

      if (userText === "read-dir-task") {
        if (!hasToolResult) {
          send(
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read_dir",
                    type: "function",
                    function: {
                      name: "list_dir",
                      arguments: JSON.stringify({ path: ".", depth: 2 }),
                    },
                  },
                ],
              },
              null,
            ),
          );
          send(chunk({}, "tool_calls"));
          send({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        } else {
          send(chunk({ role: "assistant", content: "Listed directory entries successfully" }, null));
          send(chunk({}, "stop"));
          send({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
      }

      if (!hasToolResult) {
        send(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "write_file", arguments: "" },
                },
              ],
            },
            null,
          ),
        );
        send(
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: JSON.stringify({
                      path: "hello.txt",
                      content: "hi from agent",
                    }),
                  },
                },
              ],
            },
            null,
          ),
        );
        send(chunk({}, "tool_calls"));
      } else {
        send(chunk({ role: "assistant", content: "Created hello.txt" }, null));
        send(chunk({}, "stop"));
      }

      send({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let mcpServer: Server;
let mcpURL: string;

/**
 * A minimal Streamable HTTP MCP server (JSON responses, one fixed session).
 * It exposes `echo` (read-only) and `destroy_all` (destructive) so the run loop
 * can be tested end to end without a real MCP vendor.
 */
before(async () => {
  mcpServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }
      let message: {
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      res.setHeader("Mcp-Session-Id", "test-session");
      if (message.method?.startsWith("notifications/")) {
        res.writeHead(202);
        res.end();
        return;
      }
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
        );
      };
      switch (message.method) {
        case "initialize":
          reply({
            protocolVersion:
              (message.params?.protocolVersion as string | undefined) ??
              "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "test-mcp", version: "1.0.0" },
          });
          return;
        case "tools/list":
          reply({
            tools: [
              {
                name: "echo",
                description: "Echo the provided text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
                annotations: { readOnlyHint: true },
              },
              {
                name: "destroy_all",
                description: "Delete everything",
                inputSchema: { type: "object", properties: {} },
                annotations: { destructiveHint: true },
              },
            ],
          });
          return;
        case "tools/call": {
          const name = message.params?.name as string;
          const args = (message.params?.arguments ?? {}) as {
            text?: string;
          };
          reply({
            content: [
              {
                type: "text",
                text:
                  name === "echo"
                    ? `echo: ${args.text ?? ""}`
                    : "destroyed",
              },
            ],
          });
          return;
        }
        default:
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "method not found" },
            }),
          );
      }
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const address = mcpServer.address() as AddressInfo;
  mcpURL = `http://127.0.0.1:${address.port}/mcp`;
});

after(async () => {
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
});

test("runTask executes a tool call, writes a file, and streams events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();

  const events: RunEvent[] = [];
  try {
    const result = await runTask({
      task: "Create hello.txt",
      sandbox,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL,
      onEvent: (event) => {
        events.push({ ...event, id: events.length + 1, runId: "run-1" });
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.steps, 2);
    assert.equal(await readFile(join(dir, "hello.txt"), "utf8"), "hi from agent");

    const toolCall = events.find((event) => event.type === "tool_call");
    assert.ok(toolCall, "expected a tool_call event");
    if (toolCall?.type === "tool_call") {
      assert.equal(toolCall.data.toolName, "write_file");
      assert.deepEqual(toolCall.data.input, {
        path: "hello.txt",
        content: "hi from agent",
      });
    }

    assert.ok(events.some((event) => event.type === "tool_result"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "file_change" &&
          event.data.path === "hello.txt" &&
          event.data.change === "write",
      ),
      "expected a file_change event for the written file",
    );

    const text = events
      .map((event) => (event.type === "text" ? event.data.text : ""))
      .join("");
    assert.match(text, /Created hello\.txt/);

    const first = events[0];
    assert.equal(first.type, "status");
    const last = events.at(-1);
    assert.ok(last && last.type === "status");
    if (last?.type === "status") {
      assert.equal(last.data.status, "completed");
    }
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("onBeforeModelStep fires before every upstream model request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-quota-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  const steps: number[] = [];

  try {
    const result = await runTask({
      task: "Create hello.txt",
      sandbox,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL,
      onBeforeModelStep: ({ stepNumber }) => {
        steps.push(stepNumber);
      },
      onEvent: () => undefined,
    });

    assert.equal(result.status, "completed");
    // First request decides to call the tool; second produces the final text.
    assert.equal(steps.length, 2);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("throwing in onBeforeModelStep aborts before the request is sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-quota-abort-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  modelRequests = 0;
  // The quota error must surface without any model request being issued.
  try {
    const result = await runTask({
      task: "Create hello.txt",
      sandbox,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL,
      onBeforeModelStep: () => {
        throw new Error("Daily AI request limit reached (50/50)");
      },
      onEvent: () => undefined,
    });

    assert.equal(modelRequests, 0);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Daily AI request limit/);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

// Helper to construct a mock Box using HTTP SSE exec.stream() (no ws dependency)
function makeMockBox(options: {
  storage?: Map<string, string>;
  onExec?: (cmd: string, signal?: AbortSignal) => AsyncIterable<{ type: "output"; data: string } | { type: "exit"; exitCode: number; cpuNs: number }>;
} = {}) {
  const storage = options.storage ?? new Map<string, string>();
  return {
    exec: {
      stream: (cmd: string, streamOptions?: { signal?: AbortSignal }) => {
        if (options.onExec) {
          return options.onExec(cmd, streamOptions?.signal);
        }
        let emittedOutput = false;
        let emittedExit = false;
        return {
          async cancel() {},
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (streamOptions?.signal?.aborted) {
                  return { done: true, value: undefined };
                }
                if (!emittedOutput) {
                  emittedOutput = true;
                  return { done: false, value: { type: "output" as const, data: "ok\n" } };
                }
                if (!emittedExit) {
                  emittedExit = true;
                  return { done: false, value: { type: "exit" as const, exitCode: 0, cpuNs: 0 } };
                }
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    },
    files: {
      stat: async (p: string) => {
        const val = storage.get(p);
        if (val === undefined) {
          return { type: "directory" as const, mod_time: new Date().toISOString() };
        }
        return { type: "file" as const, size: val.length, mod_time: new Date().toISOString() };
      },
      read: async (p: string) => {
        const val = storage.get(p);
        if (val === undefined) throw new Error(`File not found: ${p}`);
        return Buffer.from(val).toString("base64");
      },
      write: async (params: { path: string; content: string } | string, maybeContent?: string) => {
        if (typeof params === "object") {
          storage.set(params.path, params.content);
        } else {
          storage.set(params, maybeContent ?? "");
        }
      },
    },
  };
}

test("tools regression: list_dir (Read) on '.' with depth 2 succeeds on BoxSandbox without browser WebSocket error", async () => {
  const { BoxSandbox } = await import("@buildx/sandbox");
  const { buildTools } = await import("./tools");

  const storage = new Map<string, string>([
    ["/workspace/home/README.md", "# Hello BuildX"],
    ["/workspace/home/src/index.ts", "console.log('hi');"],
    ["/workspace/home/package.json", '{"name":"app"}'],
  ]);

  let commandExecuted = "";
  const mockBox = makeMockBox({
    storage,
    onExec: (cmd) => {
      commandExecuted = cmd;
      let emittedOutput = false;
      let emittedExit = false;
      return {
        async cancel() {},
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (!emittedOutput) {
                emittedOutput = true;
                // find output on . with depth 2
                const findOutput = ".\n./package.json\n./README.md\n./src\n./src/index.ts\n";
                return { done: false, value: { type: "output" as const, data: findOutput } };
              }
              if (!emittedExit) {
                emittedExit = true;
                return { done: false, value: { type: "exit" as const, exitCode: 0, cpuNs: 0 } };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });

  const sandbox = new BoxSandbox({
    name: "test-box",
    apiKey: "test-key",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    box: mockBox as any,
  });
  await sandbox.start();

  const tools = buildTools(sandbox);
  // Execute list_dir ("Read" tool in UI) on "." with depth 2
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await tools.list_dir.execute({ path: ".", depth: 2 }, { messages: [], toolCallId: "call_1" } as any)) as { path: string; entries: string[] };

  assert.ok(commandExecuted.includes("find '.' -maxdepth 2"));
  assert.equal(result.path, ".");
  assert.deepEqual(result.entries, [".", "README.md", "package.json", "src", "src/index.ts"]);
});

test("tools regression: filesystem and shell tools (read_file, write_file, edit_file, bash) on BoxSandbox", async () => {
  const { BoxSandbox } = await import("@buildx/sandbox");
  const { buildTools } = await import("./tools");

  const storage = new Map<string, string>([
    ["/workspace/home/sample.txt", "line 1\nline 2\nline 3\n"],
  ]);

  const mockBox = makeMockBox({
    storage,
    onExec: (cmd) => {
      let emitted = false;
      let exited = false;
      return {
        async cancel() {},
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (!emitted) {
                emitted = true;
                return { done: false, value: { type: "output" as const, data: `output of: ${cmd}\n` } };
              }
              if (!exited) {
                exited = true;
                return { done: false, value: { type: "exit" as const, exitCode: 0, cpuNs: 0 } };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  });

  const sandbox = new BoxSandbox({
    name: "test-box",
    apiKey: "test-key",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    box: mockBox as any,
  });
  await sandbox.start();

  const terminalChunks: Array<{
    stream: "stdout" | "stderr";
    chunk: string;
    toolCallId?: string;
  }> = [];
  const tools = buildTools(sandbox, {
    onTerminal: (chunk) => {
      terminalChunks.push(chunk);
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dummyOpts: any = { messages: [], toolCallId: "c1" };

  // 1. read_file
  const readRes = (await tools.read_file.execute({ path: "sample.txt", offset: 0, limit: 2 }, dummyOpts)) as { path: string; startLine: number; content: string };
  assert.equal(readRes.path, "sample.txt");
  assert.equal(readRes.startLine, 1);
  assert.ok(readRes.content.includes("line 1"));

  // 2. write_file
  const writeRes = (await tools.write_file.execute({ path: "created.txt", content: "created content" }, dummyOpts)) as { path: string; bytes: number };
  assert.equal(writeRes.path, "created.txt");
  assert.equal(writeRes.bytes, 15);
  assert.equal(storage.get("/workspace/home/created.txt"), "created content");

  // 3. edit_file
  const editRes = (await tools.edit_file.execute({ path: "sample.txt", old_str: "line 2", new_str: "edited line 2" }, dummyOpts)) as { path: string; replacements: number };
  assert.equal(editRes.path, "sample.txt");
  assert.equal(editRes.replacements, 1);
  assert.ok(storage.get("/workspace/home/sample.txt")?.includes("edited line 2"));

  // 4. bash
  const bashRes = (await tools.bash.execute({ command: "echo hello" }, dummyOpts)) as {
    command: string;
    cwd: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  };
  assert.equal(bashRes.command, "echo hello");
  assert.equal(bashRes.cwd, ".");
  assert.equal(bashRes.exitCode, 0);
  assert.ok(bashRes.stdout.includes("output of: echo hello"));
  assert.equal(bashRes.truncated, false);
  assert.ok(
    terminalChunks.some(
      (chunk) =>
        chunk.toolCallId === "c1" &&
        chunk.stream === "stdout" &&
        chunk.chunk.includes("output of: echo hello"),
    ),
    "bash streams stdout chunks tagged with the tool call id",
  );

  // 5. abortSignal check: pre-aborted signal immediately throws
  const abortedController = new AbortController();
  abortedController.abort();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const abortedOpts: any = { messages: [], toolCallId: "c2", abortSignal: abortedController.signal };
  await assert.rejects(
    async () => { await tools.read_file.execute({ path: "sample.txt" }, abortedOpts); },
    /Tool execution aborted: run cancelled/,
  );
  await assert.rejects(
    async () => { await tools.write_file.execute({ path: "x.txt", content: "x" }, abortedOpts); },
    /Tool execution aborted: run cancelled/,
  );
  await assert.rejects(
    async () => { await tools.edit_file.execute({ path: "sample.txt", old_str: "a", new_str: "b" }, abortedOpts); },
    /Tool execution aborted: run cancelled/,
  );
  await assert.rejects(
    async () => { await tools.bash.execute({ command: "echo" }, abortedOpts); },
    /Tool execution aborted: run cancelled/,
  );
  await assert.rejects(
    async () => { await tools.list_dir.execute({ path: "." }, abortedOpts); },
    /Tool execution aborted: run cancelled/,
  );
});

test("search, todo, and file-change tools work on TestSandbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-tools-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(dir, "src", "auth.ts"),
      [
        "export function validateSessionToken(token: string) {",
        "  if (!token) throw new Error('missing token');",
        "  return token.length > 10;",
        "}",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "src", "render.ts"),
      "export function renderButton(label: string) { return `<button>${label}</button>`; }\n",
    );
    await writeFile(
      join(dir, "node_modules", "pkg", "index.js"),
      "needle should be ignored\n",
    );

    const todos: unknown[] = [];
    const changes: unknown[] = [];
    const tools = buildTools(sandbox, {
      onTodo: (items) => {
        todos.push(items);
      },
      onFileChange: (change) => {
        changes.push(change);
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = { messages: [], toolCallId: "call-tools" };

    const globbed = (await tools.glob.execute(
      { pattern: "**/*.ts" },
      opts,
    )) as { files: string[]; count: number };
    assert.deepEqual(globbed.files.sort(), ["src/auth.ts", "src/render.ts"]);

    const grepped = (await tools.grep.execute(
      { pattern: "validateSession", glob: "*.ts" },
      opts,
    )) as { matches: string };
    assert.match(grepped.matches, /src\/auth\.ts:1/);
    assert.doesNotMatch(grepped.matches, /node_modules/);

    const semantic = (await tools.semantic_search.execute(
      { query: "where do we validate a session token" },
      opts,
    )) as { results: Array<{ path: string; startLine: number }> };
    assert.equal(semantic.results[0]?.path, "src/auth.ts");

    const plan = (await tools.todo_write.execute(
      {
        todos: [
          { content: "Inspect auth flow", status: "in_progress" },
          { content: "Add tests", status: "pending" },
        ],
      },
      opts,
    )) as { todos: Array<{ content: string; status: string }> };
    assert.equal(plan.todos.length, 2);
    assert.equal(todos.length, 1);

    await tools.write_file.execute(
      { path: "src/new.ts", content: "export const x = 1;\n" },
      opts,
    );
    assert.deepEqual(changes, [{ path: "src/new.ts", change: "write" }]);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash bounds stdout and preserves the stderr tail with an explicit notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-bash-bounds-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    const tools = buildTools(sandbox);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = { messages: [], toolCallId: "bash-bounds" };

    const largeStdout = (await tools.bash.execute(
      {
        command: `node -e "process.stdout.write('A'.repeat(50000))"`,
        timeoutMs: 10_000,
      },
      opts,
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      truncated: boolean;
    };
    assert.equal(largeStdout.exitCode, 0);
    assert.equal(largeStdout.truncated, true);
    assert.ok(largeStdout.stdout.startsWith("A"));
    assert.match(largeStdout.stdout, /truncated \d+ chars/);
    assert.ok(largeStdout.stdout.length <= 12_000 + 200);

    const largeStderr = (await tools.bash.execute(
      {
        command: `node -e "for (let i = 0; i < 4000; i++) process.stderr.write('err ' + i + '\\n')"`,
        timeoutMs: 10_000,
      },
      opts,
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      truncated: boolean;
    };
    assert.equal(largeStderr.exitCode, 0);
    assert.equal(largeStderr.truncated, true);
    assert.match(largeStderr.stderr, /truncated \d+ chars/);
    assert.match(largeStderr.stderr, /err 0/);
    assert.match(largeStderr.stderr, /err 3999/);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash treats non-zero exits as results and removes the exit marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-bash-exit-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    const tools = buildTools(sandbox);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = { messages: [], toolCallId: "bash-exit" };
    const result = (await tools.bash.execute(
      { command: "printf 'out\n'; printf 'err\n' >&2; exit 7" },
      opts,
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      truncated: boolean;
      timedOut?: boolean;
    };
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.truncated, false);
    assert.equal(result.timedOut, undefined);
    assert.doesNotMatch(result.stderr, /\[buildx: command exited/);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash returns exitCode 124 and timedOut for a timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-bash-timeout-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    const tools = buildTools(sandbox);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = { messages: [], toolCallId: "bash-timeout" };
    const result = (await tools.bash.execute(
      { command: "sleep 5", timeoutMs: 100 },
      opts,
    )) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut?: boolean;
    };
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /timed out after 100ms/);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash streams raw chunks (including the exit trailer) to onTerminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-bash-raw-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string; toolCallId?: string }> = [];
    const tools = buildTools(sandbox, {
      onTerminal: (chunk) => {
        chunks.push(chunk);
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = { messages: [], toolCallId: "bash-raw" };
    await tools.bash.execute(
      { command: "printf 'one\n'; printf 'two\n' >&2; exit 3" },
      opts,
    );
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.toolCallId === "bash-raw" &&
          chunk.stream === "stdout" &&
          chunk.chunk.includes("one"),
      ),
    );
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.toolCallId === "bash-raw" &&
          chunk.stream === "stderr" &&
          chunk.chunk.includes("two"),
      ),
    );
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.stream === "stderr" &&
          chunk.chunk.includes("[buildx: command exited with code 3]"),
      ),
      "raw terminal keeps the exit trailer",
    );
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider tool-name validation errors become actionable messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-bad-tool-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    const events: RunEvent[] = [];
    const result = await runTask({
      task: "bad-tool-name",
      sandbox,
      model: "auto",
      apiKey: "test",
      baseURL,
      maxSteps: 2,
      onEvent: (event) => {
        events.push(event as RunEvent);
      },
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /unknown tool "repo_browser\.print_tree"/);
    assert.match(result.error ?? "", /router picked an upstream/);
    const errorEvent = events.find((event) => event.type === "error");
    assert.match(
      String((errorEvent?.data as { message?: string }).message),
      /unknown tool/,
    );
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("LiteLLM's wrapped tool_use_failed error becomes actionable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-tool-use-failed-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    const result = await runTask({
      task: "tool-use-failed",
      sandbox,
      model: "auto",
      apiKey: "test",
      baseURL,
      maxSteps: 2,
      onEvent: () => {},
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /tried to call a tool Buildx does not provide/);
    assert.match(result.error ?? "", /Settings/);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("paid-model restriction becomes an actionable message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-free-tier-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();
  try {
    const result = await runTask({
      task: "paid-model-blocked",
      sandbox,
      model: "deepseek/deepseek-v4-flash-0731",
      apiKey: "test",
      baseURL,
      maxSteps: 2,
      onEvent: () => {},
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /restricted to paid credits/);
    assert.match(result.error ?? "", /`auto`/);
    assert.match(result.error ?? "", /OpenRouter/);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation regression: Stop during model generation aborts and transitions to cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-cancel-gen-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();

  const controller = new AbortController();
  const events: RunEvent[] = [];

  try {
    const resultPromise = runTask({
      task: "slow-generation",
      sandbox,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL,
      abortSignal: controller.signal,
      onEvent: (event) => {
        events.push({ ...event, id: events.length + 1, runId: "run-cancel-gen" });
        if (event.type === "text" && event.data.text.includes("first chunk")) {
          // Trigger stop mid-stream
          controller.abort();
        }
      },
    });

    const result = await resultPromise;
    assert.equal(result.status, "cancelled");

    const terminalStatus = events.filter((e) => e.type === "status").at(-1);
    assert.ok(terminalStatus && terminalStatus.type === "status");
    assert.equal(terminalStatus.data.status, "cancelled");

    // Must NOT have emitted an error event
    assert.equal(events.some((e) => e.type === "error"), false, "Cancellation must not emit an error event");
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation regression: Stop during long-running tool call aborts cleanly", async () => {
  const { BoxSandbox } = await import("@buildx/sandbox");

  const controller = new AbortController();
  const events: RunEvent[] = [];

  let toolStarted = false;
  let _toolCancelled = false;

  const mockBox = makeMockBox({
    onExec: (_cmd, signal) => {
      toolStarted = true;
      // Trigger abort while tool is running
      setTimeout(() => controller.abort(), 10);

      return {
        async cancel() {
          _toolCancelled = true;
        },
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<{ type: "output"; data: string } | { type: "exit"; exitCode: number; cpuNs: number }>> {
              // Wait until signal aborts
              while (!signal?.aborted && !controller.signal.aborted) {
                await new Promise((r) => setTimeout(r, 10));
              }
              return { done: true, value: undefined as never };
            },
          };
        },
      };
    },
  });

  const sandbox = new BoxSandbox({
    name: "test-box-cancel",
    apiKey: "test-key",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    box: mockBox as any,
  });
  await sandbox.start();

  const result = await runTask({
    task: "slow-tool",
    sandbox,
    model: "gpt-4o-mini",
    apiKey: "test-key",
    baseURL,
    abortSignal: controller.signal,
    onEvent: (event) => {
      events.push({ ...event, id: events.length + 1, runId: "run-cancel-tool" });
    },
  });

  assert.equal(toolStarted, true);
  assert.equal(result.status, "cancelled");

  const terminalStatus = events.filter((e) => e.type === "status").at(-1);
  assert.ok(terminalStatus && terminalStatus.type === "status");
  assert.equal(terminalStatus.data.status, "cancelled");
  assert.equal(events.some((e) => e.type === "error"), false);
});

test("end-to-end regression: runTask executes list_dir (Read) on '.' with depth 2 and completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-read-dir-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();

  const events: RunEvent[] = [];
  try {
    const result = await runTask({
      task: "read-dir-task",
      sandbox,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL,
      onEvent: (event) => {
        events.push({ ...event, id: events.length + 1, runId: "run-read-dir" });
      },
    });

    assert.equal(result.status, "completed");
    const toolCall = events.find((e) => e.type === "tool_call");
    assert.ok(toolCall && toolCall.type === "tool_call");
    assert.equal(toolCall.data.toolName, "list_dir");
    assert.deepEqual(toolCall.data.input, { path: ".", depth: 2 });

    const toolResult = events.find((e) => e.type === "tool_result");
    assert.ok(toolResult && toolResult.type === "tool_result");
    assert.equal(toolResult.data.isError, undefined);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});


test("runTask connects to a Streamable HTTP MCP server and namespaces its tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-mcp-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();

  const events: RunEvent[] = [];
  try {
    const result = await runTask({
      task: "mcp-call",
      sandbox,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL,
      mcpServers: [
        { id: "mcp-1", name: "mcp test", url: mcpURL, allowPrivate: true },
      ],
      onEvent: (event) => {
        events.push({ ...event, id: events.length + 1, runId: "run-mcp" });
      },
    });

    assert.equal(result.status, "completed");
    const call = events.find(
      (event) =>
        event.type === "tool_call" &&
        event.data.toolName === "mcp_test__echo",
    );
    assert.ok(call && call.type === "tool_call");
    assert.equal(call.data.mcpServer, "mcp test");
    assert.deepEqual(call.data.input, { text: "hello mcp" });

    const toolResult = events.find(
      (event) =>
        event.type === "tool_result" &&
        event.data.toolName === "mcp_test__echo",
    );
    assert.ok(toolResult && toolResult.type === "tool_result");
    assert.equal(toolResult.data.output, "echo: hello mcp");
    assert.equal(toolResult.data.mcpServer, "mcp test");
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("context budget summarizes and replaces an over-budget transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-compact-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  await sandbox.start();

  const events: RunEvent[] = [];
  try {
    const result = await runTask({
      task: `compact ${"detail ".repeat(400)}`,
      sandbox,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL,
      contextBudget: { limitTokens: 200 },
      onEvent: (event) => {
        events.push({ ...event, id: events.length + 1, runId: "run-compact" });
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.text, "Compacted and finished");

    const summarizeCall = events.find(
      (event) =>
        event.type === "tool_call" &&
        event.data.toolName === "summarize_context",
    );
    assert.ok(summarizeCall, "expected the forced summarize_context call");

    const contextEvent = events.find((event) => event.type === "context");
    assert.ok(contextEvent && contextEvent.type === "context");
    assert.match(contextEvent.data.summary, /compact/);
    assert.ok(contextEvent.data.estimatedTokens > 200);
  } finally {
    await sandbox.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP SSRF guard blocks loopback and local hostnames unless allowed", async () => {
  const { assertSafeMcpUrl, McpSecurityError } = await import("./index");
  await assert.rejects(
    () => assertSafeMcpUrl("http://127.0.0.1:9000/mcp"),
    McpSecurityError,
  );
  await assert.rejects(
    () => assertSafeMcpUrl("http://localhost:9000/mcp"),
    McpSecurityError,
  );
  await assert.rejects(
    () => assertSafeMcpUrl("file:///etc/passwd"),
    McpSecurityError,
  );
  await assert.doesNotReject(() =>
    assertSafeMcpUrl("http://127.0.0.1:9000/mcp", { allowPrivate: true }),
  );
});
