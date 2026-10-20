"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  CornerDownLeft,
  Eraser,
  Play,
  Send,
  Square,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export function WorkspaceTerminal({ workspaceId }: { workspaceId: string }) {
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [output, setOutput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stdin, setStdin] = useState("");
  const [history, setHistory] = useState<string[]>(() =>
    readTerminalHistory(workspaceId),
  );
  const [showJump, setShowJump] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const commandRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const element = outputRef.current;
    if (element && stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [output]);

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

  function applyRecord(record: TerminalRecord) {
    switch (record.type) {
      case "start":
        setPhase("running");
        break;
      case "session":
        sessionRef.current = record.id;
        setSessionId(record.id);
        break;
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

  async function start() {
    const nextCommand = command.trim();
    if (!nextCommand || phase === "starting" || phase === "running") return;

    const controller = new AbortController();
    abortRef.current = controller;
    sessionRef.current = null;
    setSessionId(null);
    setPhase("starting");
    setError(null);
    setNotice(null);
    setExitCode(null);
    setOutput("");
    setHistory((current) =>
      pushTerminalHistory(workspaceId, nextCommand, current),
    );

    const pane = paneRef.current;
    const size = pane
      ? terminalCellSize(pane.clientWidth, pane.clientHeight)
      : { cols: 80, rows: 24 };

    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: nextCommand,
            tty: true,
            rows: size.rows,
            cols: size.cols,
            ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(await errorFromResponse(response));
      }

      setPhase("running");
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
      abortRef.current = null;
      sessionRef.current = null;
      setSessionId(null);
    }
  }

  async function sendSession(body: Record<string, unknown>) {
    const id = sessionRef.current;
    if (!id) return;
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

  async function sendInput(event: FormEvent) {
    event.preventDefault();
    if (!sessionRef.current) return;
    const data = stdin;
    setStdin("");
    await sendSession({ type: "stdin", data: `${data}\n` });
    commandRef.current?.focus();
  }

  async function stop() {
    const id = sessionRef.current;
    if (id) {
      await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    abortRef.current?.abort();
    sessionRef.current = null;
    setSessionId(null);
    setPhase("idle");
  }

  const running = phase === "starting" || phase === "running";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-sidebar/60 px-2 py-1.5">
        <TerminalSquare className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-secondary text-foreground/85">
          {sessionId ? `session/${sessionId.slice(0, 8)}` : "box terminal"}
        </span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
            phase === "running" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            phase === "starting" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            phase === "error" && "bg-destructive/10 text-destructive",
            (phase === "idle" || phase === "done") && "bg-muted/60 text-muted-foreground",
          )}
        >
          {phase}
        </span>
        {exitCode !== null ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            exit {exitCode}
          </span>
        ) : null}
      </div>

      <div className="grid shrink-0 gap-1.5 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-[var(--text-faint)]">$</span>
          <Input
            ref={commandRef}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void start();
              }
            }}
            list="buildx-terminal-history"
            placeholder="npm test"
            spellCheck={false}
            disabled={running}
            className="h-7 min-w-0 flex-1 font-mono text-xs"
            aria-label="Terminal command"
          />
          <datalist id="buildx-terminal-history">
            {history.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
          {running ? (
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
              aria-label="Run terminal command"
              title="Run command"
              disabled={command.trim().length === 0}
              onClick={() => void start()}
            >
              <Play className="size-3" />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] text-[var(--text-faint)]">cwd</span>
          <Input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="workspace root"
            spellCheck={false}
            disabled={running}
            className="h-6 min-w-0 flex-1 font-mono text-[11px]"
            aria-label="Working directory"
          />
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
            }}
          >
            <Eraser className="size-3" />
          </Button>
        </div>
      </div>

      <div
        ref={paneRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-[var(--surface)]"
      >
        <pre
          ref={outputRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const nearBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            stickToBottomRef.current = nearBottom;
            setShowJump(!nearBottom && element.scrollHeight > element.clientHeight);
          }}
          className="h-full overflow-auto whitespace-pre-wrap break-words p-2.5 font-mono text-[11px] leading-[18px] text-[var(--text)]"
          aria-live="polite"
          aria-label="Terminal output"
        >
          {output ? (
            <span dangerouslySetInnerHTML={{ __html: ansiToHtml(output) }} />
          ) : (
            <span className="text-muted-foreground">
              {phase === "starting"
                ? "Starting a live session in your workspace…"
                : "Run a command in your Upstash Box. TTY sessions merge stderr into stdout."}
            </span>
          )}
        </pre>
        {showJump && output ? (
          <button
            type="button"
            onClick={() => {
              stickToBottomRef.current = true;
              setShowJump(false);
              const element = outputRef.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
            className="absolute bottom-2 right-2 rounded-md border border-border bg-background/90 px-2 py-1 font-mono text-[10px] text-muted-foreground shadow-sm hover:text-foreground"
          >
            jump to output
          </button>
        ) : null}
      </div>

      {sessionId ? (
        <form
          onSubmit={(event) => void sendInput(event)}
          className="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1.5"
        >
          <CornerDownLeft className="size-3 shrink-0 text-[var(--text-faint)]" />
          <Input
            value={stdin}
            onChange={(event) => setStdin(event.target.value)}
            placeholder="send input / answer a prompt"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 font-mono text-xs"
            aria-label="Terminal input"
          />
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            aria-label="Send Ctrl-C"
            title="Send Ctrl-C (SIGINT)"
            onClick={() => void sendSession({ type: "signal", signal: "INT" })}
          >
            ^C
          </Button>
          <Button
            type="submit"
            size="icon-xs"
            variant="secondary"
            aria-label="Send input"
            title="Send input"
          >
            <Send className="size-3" />
          </Button>
        </form>
      ) : null}

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
