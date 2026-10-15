import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LocalSandbox } from "@buildx/sandbox";
import type { RunEvent } from "@buildx/shared";
import { runTask } from "./index";

type ChatRequest = {
  model?: string;
  messages?: Array<{ role?: string }>;
};

let server: Server;
let baseURL: string;

/**
 * A minimal OpenAI-compatible Chat Completions streaming endpoint. On the first
 * request it asks the model to call `write_file`; once a tool result is present
 * it replies with final text, exercising the full loop + tool execution.
 */
before(async () => {
  server = createServer((req, res) => {
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

test("runTask executes a tool call, writes a file, and streams events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-agent-"));
  const sandbox = new LocalSandbox({ rootDir: dir });
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
