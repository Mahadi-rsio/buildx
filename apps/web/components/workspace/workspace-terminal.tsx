"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Eraser,
  Play,
  Square,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ansiToHtml } from "@/lib/ansi";
import {
  pushTerminalHistory,
  readTerminalHistory,
  takeNdjsonRecords,
  terminalCellSize,
} from "@/lib/terminal-client";
import type { TerminalRecord } from "@/lib/terminal";
import { cn } from "@/lib/utils";

type Phase = "idle" | "starting" | "running" | "done" | "error";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function errorFromResponse(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: unknown };
    if (typeof data.message === "string" && data.message.length > 0) {
      return data.message;
    }
  } catch {
    // Fall through to the status line.
  }
  return `Terminal request failed (${response.status}).`;
}

/**
 * A real PTY-backed terminal for the secondary workspace panel. The first
 * submitted line starts a persistent shell session; subsequent lines are piped
 * to that shell. There is no separate command/cwd form — the prompt lives in
 * the terminal surface, and shell builtins (cd, export, …) persist.
 */
export function WorkspaceTerminal({ workspaceId }: { workspaceId: string }) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(() =>
    readTerminalHistory(workspaceId),
  );
  const [showJump, setShowJump] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const runSeqRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const pendingCommandRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stickToBottomRef = useRef(true);
  const historyIndexRef = useRef(-1);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [output, phase]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const id = sessionRef.current;
        if (!id || pane.clientWidth < 20 || pane.clientHeight < 20) return;
        const { cols, rows } = terminalCellSize(
          pane.clientWidth,
          pane.clientHeight,
        );
        void fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(id)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "resize", rows, cols }),
          },
        ).catch(() => undefined);
      }, 250);
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      if (timer) window.clearTimeout(timer);
    };
  }, [workspaceId]);

  async function sendToSession(
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        setError(await errorFromResponse(response));
      }
    } catch (caught) {
      setError(message(caught));
    }
  }

  function applyRecord(record: TerminalRecord) {
    switch (record.type) {
      case "start":
        setPhase("running");
        break;
      case "session": {
        sessionRef.current = record.id;
        setSessionId(record.id);
        const pending = pendingCommandRef.current;
        pendingCommandRef.current = null;
        if (pending) {
          void sendToSession(record.id, {
            type: "stdin",
            data: `${pending}\n`,
          }).then(() => inputRef.current?.focus());
        }
        break;
      }
      case "stdout":
      case "stderr":
        setOutput((current) => current + record.data);
        break;
      case "truncated":
        setNotice(record.message);
        break;
      case "exit":
        setExitCode(record.exitCode);
        setPhase("done");
        break;
      case "error":
        setError(record.message);
        setPhase("error");
        break;
    }
  }

  async function start(initialCommand?: string) {
    if (phase === "starting" || phase === "running") return;
    const pane = paneRef.current;
    const size = pane
      ? terminalCellSize(pane.clientWidth, pane.clientHeight)
      : { cols: 80, rows: 24 };

    abortRef.current?.abort();
    const runId = ++runSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    sessionRef.current = null;
    pendingCommandRef.current = initialCommand ?? null;
    setSessionId(null);
    setPhase("starting");
    setError(null);
    setNotice(null);
    setExitCode(null);
    setOutput("");
    historyIndexRef.current = -1;

    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: "bash",
            tty: true,
            rows: size.rows,
            cols: size.cols,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(await errorFromResponse(response));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = takeNdjsonRecords(buffer);
        buffer = parsed.rest;
        for (const record of parsed.records) applyRecord(record);
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const record of takeNdjsonRecords(`${buffer}\n`).records) {
          applyRecord(record);
        }
      }
      setPhase((current) => (current === "running" ? "done" : current));
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(message(caught));
        setPhase("error");
      }
    } finally {
      if (runSeqRef.current === runId) {
        abortRef.current = null;
        sessionRef.current = null;
        pendingCommandRef.current = null;
        setSessionId(null);
      }
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const line = input;
    setInput("");
    historyIndexRef.current = -1;
    if (!line.trim()) return;

    setHistory((current) =>
      pushTerminalHistory(workspaceId, line.trim(), current),
    );

    const id = sessionRef.current;
    if (id) {
      stickToBottomRef.current = true;
      await sendToSession(id, { type: "stdin", data: `${line}\n` });
      inputRef.current?.focus();
      return;
    }
    if (phase === "starting") return;
    if (phase === "running") {
      pendingCommandRef.current = line;
      return;
    }
    await start(line);
    inputRef.current?.focus();
  }

  async function stop() {
    runSeqRef.current += 1;
    const id = sessionRef.current;
    if (id) {
      await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    abortRef.current?.abort();
    sessionRef.current = null;
    pendingCommandRef.current = null;
    setSessionId(null);
    setPhase("idle");
  }

  function recallHistory(direction: -1 | 1) {
    if (history.length === 0) return;
    const nextIndex =
      direction === -1
        ? historyIndexRef.current === -1
          ? 0
          : Math.min(history.length - 1, historyIndexRef.current + 1)
        : historyIndexRef.current <= 0
          ? -1
          : historyIndexRef.current - 1;
    historyIndexRef.current = nextIndex;
    setInput(nextIndex === -1 ? "" : history[nextIndex]);
  }

  const showPrompt = phase !== "starting";
  const prompt = phase === "starting" ? "starting shell…" : "$";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-sidebar/60 px-2 py-1.5">
        <TerminalSquare className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-secondary text-foreground/85">
          {sessionId ? `bash · session/${sessionId.slice(0, 8)}` : "workspace terminal"}
        </span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
            phase === "running" &&
              "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            phase === "starting" &&
              "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            phase === "error" && "bg-destructive/10 text-destructive",
            (phase === "idle" || phase === "done") &&
              "bg-muted/60 text-muted-foreground",
          )}
        >
          {phase}
        </span>
        {exitCode !== null ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            exit {exitCode}
          </span>
        ) : null}
        {phase === "running" || phase === "starting" ? (
          <Button
            type="button"
            size="icon-xs"
            variant="destructive"
            aria-label="Stop terminal session"
            title="Stop session"
            onClick={() => void stop()}
          >
            <Square className="size-3" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Start a new shell session"
            title="Start shell"
            onClick={() => void start()}
          >
            <Play className="size-3" />
          </Button>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Clear terminal output"
          title="Clear output"
          onClick={() => {
            setOutput("");
            setNotice(null);
            setError(null);
            setExitCode(null);
            inputRef.current?.focus();
          }}
        >
          <Eraser className="size-3" />
        </Button>
      </div>

      <div
        ref={paneRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-[var(--surface)]"
      >
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const nearBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              40;
            stickToBottomRef.current = nearBottom;
            setShowJump(
              !nearBottom && element.scrollHeight > element.clientHeight,
            );
          }}
          onClick={() => inputRef.current?.focus()}
          className="h-full touch-pan-y overflow-y-auto overscroll-contain p-2.5 font-mono text-[11px] leading-[18px] text-[var(--text)] [scrollbar-width:thin]"
        >
          {output ? (
            <pre
              className="m-0 whitespace-pre-wrap break-words font-mono"
              aria-live="polite"
              aria-label="Terminal output"
            >
              <span dangerouslySetInnerHTML={{ __html: ansiToHtml(output) }} />
            </pre>
          ) : (
            <div className="space-y-1 text-muted-foreground">
              <p>
                {phase === "starting"
                  ? "Starting a live shell in your workspace…"
                  : "Interactive shell in your Upstash Box."}
              </p>
              <p className="text-[10px] text-[var(--text-faint)]">
                Type a command below and press Enter. The shell keeps state
                between commands.
              </p>
            </div>
          )}

          {showPrompt ? (
            <form
              onSubmit={(event) => void submit(event)}
              className="mt-1 flex items-center gap-1.5"
            >
              <span
                className={cn(
                  "shrink-0 select-none font-mono text-[var(--ansi-green)]",
                  !input && "term-cursor",
                )}
                aria-hidden="true"
              >
                {prompt}
              </span>
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    recallHistory(-1);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    recallHistory(1);
                  } else if (event.key === "c" && event.ctrlKey) {
                    event.preventDefault();
                    setInput("");
                    const id = sessionRef.current;
                    if (id) {
                      void sendToSession(id, {
                        type: "signal",
                        signal: "INT",
                      });
                    }
                  } else if (event.key === "l" && event.ctrlKey) {
                    event.preventDefault();
                    setInput("");
                    setOutput("");
                    setNotice(null);
                    setError(null);
                  }
                }}
                onFocus={() => {
                  stickToBottomRef.current = true;
                  const element = scrollRef.current;
                  if (element) element.scrollTop = element.scrollHeight;
                }}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Terminal input"
                className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[11px] leading-[18px] text-[var(--text)] caret-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
              />
              {phase === "running" ? (
                <button
                  type="submit"
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                  aria-label="Send command"
                >
                  enter
                </button>
              ) : null}
            </form>
          ) : null}
        </div>

        {showJump && output ? (
          <button
            type="button"
            onClick={() => {
              stickToBottomRef.current = true;
              setShowJump(false);
              const element = scrollRef.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
            className="absolute bottom-2 right-2 rounded-md border border-border bg-background/90 px-2 py-1 font-mono text-[10px] text-muted-foreground shadow-sm hover:text-foreground"
          >
            jump to output
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="shrink-0 border-t border-border bg-destructive/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
          {error}
        </p>
      ) : notice ? (
        <p className="shrink-0 border-t border-border bg-muted/30 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
