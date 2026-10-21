"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  ChevronDown,
  ChevronUp,
  Eraser,
  Plus,
  RotateCcw,
  Search,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { takeNdjsonRecords } from "@/lib/terminal-client";
import type { TerminalRecord } from "@/lib/terminal";
import { cn } from "@/lib/utils";

type Phase = "idle" | "starting" | "running" | "done" | "error";

interface PaneStatus {
  phase: Phase;
  sessionId: string | null;
  exitCode: number | null;
  error: string | null;
}

const MAX_TABS = 4;

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

function readTerminalTheme(element: HTMLElement) {
  const styles = getComputedStyle(element);
  const value = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--surface", "#0b0b0b"),
    foreground: value("--text", "#e6e6e6"),
    cursor: value("--text", "#e6e6e6"),
    cursorAccent: value("--surface", "#0b0b0b"),
    selectionBackground: value("--surface-hover", "#2a2a2a"),
    black: value("--ansi-black", "#484f58"),
    red: value("--ansi-red", "#ff7b72"),
    green: value("--ansi-green", "#3fb950"),
    yellow: value("--ansi-yellow", "#d29922"),
    blue: value("--ansi-blue", "#79c0ff"),
    magenta: value("--ansi-magenta", "#d2a8ff"),
    cyan: value("--ansi-cyan", "#56d4dd"),
    white: value("--ansi-white", "#b1bac4"),
    brightBlack: value("--ansi-bright-black", "#6e7681"),
    brightRed: value("--ansi-bright-red", "#ffa198"),
    brightGreen: value("--ansi-bright-green", "#56d364"),
    brightYellow: value("--ansi-bright-yellow", "#e3b341"),
    brightBlue: value("--ansi-bright-blue", "#a5d6ff"),
    brightMagenta: value("--ansi-bright-magenta", "#e2c5ff"),
    brightCyan: value("--ansi-bright-cyan", "#76e3ea"),
    brightWhite: value("--ansi-bright-white", "#f0f6fc"),
  };
}

function newTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function TerminalPane({
  workspaceId,
  index,
  active,
  onStatus,
}: {
  workspaceId: string;
  index: number;
  active: boolean;
  onStatus: (status: PaneStatus) => void;
}) {
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const disposedRef = useRef(false);
  const pendingInputRef = useRef("");
  const writeTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const onStatusRef = useRef(onStatus);
  const sendInputRef = useRef<(data: string) => void>(() => undefined);
  const resizeRef = useRef<(cols: number, rows: number) => void>(() => undefined);

  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    onStatusRef.current = onStatus;
    onStatusRef.current({ phase, sessionId, exitCode, error });
  }, [onStatus, phase, sessionId, exitCode, error]);

  const postSession = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(id)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!response.ok) setError(await errorFromResponse(response));
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setError(message(caught));
        }
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      abortRef.current?.abort();
      const id = sessionRef.current;
      if (id) {
        void fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(id)}`,
          { method: "DELETE", keepalive: true },
        ).catch(() => undefined);
      }
    };
  }, [workspaceId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"JetBrains Mono", "SFMono-Regular", "SF Mono", ui-monospace, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      scrollback: 5_000,
      theme: readTerminalTheme(host),
      convertEol: false,
      macOptionIsMeta: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const fitPane = () => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        // Hidden panes can have zero dimensions while the tab is inactive.
      }
    };

    term.onData((data) => sendInputRef.current(data));
    term.onResize(({ cols, rows }) => resizeRef.current(cols, rows));
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.ctrlKey && event.key === "f") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      return true;
    });

    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(fitPane, 50);
    });
    observer.observe(host);
    const frame = window.requestAnimationFrame(fitPane);

    return () => {
      window.cancelAnimationFrame(frame);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const term = termRef.current;
    if (!host || !term) return;
    term.options.theme = readTerminalTheme(host);
  }, [resolvedTheme]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const frame = window.requestAnimationFrame(() => {
      try {
        fit?.fit();
      } catch {
        // Ignore a zero-sized measurement.
      }
      term?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (searchOpen) window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [searchOpen]);

  useEffect(() => {
    sendInputRef.current = (data: string) => {
      pendingInputRef.current += data;
      if (writeTimerRef.current) return;
      writeTimerRef.current = window.setTimeout(() => {
        writeTimerRef.current = null;
        const chunk = pendingInputRef.current;
        pendingInputRef.current = "";
        const id = sessionRef.current;
        if (!id || chunk.length === 0) return;
        void postSession(id, { type: "stdin", data: chunk });
      }, 16);
    };
    resizeRef.current = (cols: number, rows: number) => {
      const id = sessionRef.current;
      if (!id) return;
      void postSession(id, { type: "resize", rows, cols });
    };
  }, [postSession]);

  const start = useCallback(async () => {
    if (phase === "starting" || phase === "running") return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;

    try {
      fit?.fit();
    } catch {
      // Keep the previous dimensions if the pane is not measurable yet.
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    sessionRef.current = null;
    setSessionId(null);
    setPhase("starting");
    setError(null);
    setExitCode(null);
    term.reset();

    const applyRecord = (record: TerminalRecord) => {
      const activeTerminal = termRef.current;
      switch (record.type) {
        case "start":
          setPhase("running");
          break;
        case "session": {
          sessionRef.current = record.id;
          setSessionId(record.id);
          const queued = pendingInputRef.current;
          pendingInputRef.current = "";
          void postSession(record.id, {
            type: "resize",
            rows: Math.max(1, activeTerminal?.rows ?? 24),
            cols: Math.max(1, activeTerminal?.cols ?? 80),
          });
          if (queued) {
            void postSession(record.id, { type: "stdin", data: queued });
          }
          break;
        }
        case "stdout":
        case "stderr":
          activeTerminal?.write(record.data);
          break;
        case "truncated":
          activeTerminal?.writeln(`\r\n[${record.message}]`);
          break;
        case "exit":
          setExitCode(record.exitCode);
          setPhase("done");
          activeTerminal?.writeln(`\r\n[process exited ${record.exitCode}]`);
          break;
        case "error":
          setError(record.message);
          setPhase("error");
          activeTerminal?.writeln(`\r\n[error: ${record.message}]`);
          break;
      }
    };

    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/terminal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: "bash",
            tty: true,
            rows: Math.max(1, term.rows),
            cols: Math.max(1, term.cols),
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
      while (!disposedRef.current) {
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
      if (!controller.signal.aborted) {
        setPhase((current) =>
          current === "running" || current === "starting" ? "done" : current,
        );
      }
    } catch (caught) {
      if (!controller.signal.aborted && !disposedRef.current) {
        setError(message(caught));
        setPhase("error");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      sessionRef.current = null;
      setSessionId(null);
    }
  }, [phase, postSession, workspaceId]);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [active, start]);

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

  const tone =
    phase === "running"
      ? "bg-emerald-500"
      : phase === "starting"
        ? "bg-amber-500"
        : phase === "error"
          ? "bg-red-500"
          : "bg-muted-foreground/40";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface)]">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-sidebar/50 px-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", tone)} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          bash · tab {index}
          {sessionId ? ` · ${sessionId.slice(0, 6)}` : ""}
        </span>
        {exitCode !== null ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
            exit {exitCode}
          </span>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Search terminal"
          title="Search (Ctrl+F)"
          onClick={() => setSearchOpen((open) => !open)}
        >
          <Search className="size-3" />
        </Button>
        {phase === "running" || phase === "starting" ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Stop shell"
            title="Stop shell"
            onClick={() => void stop()}
          >
            <Square className="size-3" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Restart shell"
            title="Restart shell"
            onClick={() => {
              startedRef.current = true;
              void start();
            }}
          >
            <RotateCcw className="size-3" />
          </Button>
        )}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Clear terminal"
          title="Clear"
          onClick={() => {
            termRef.current?.clear();
            setError(null);
            termRef.current?.focus();
          }}
        >
          <Eraser className="size-3" />
        </Button>
      </div>

      {searchOpen ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border bg-sidebar/40 px-2 py-1">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value) {
                searchRef.current?.findNext(event.target.value, {
                  incremental: true,
                  caseSensitive: false,
                });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) {
                  searchRef.current?.findPrevious(query, {
                    caseSensitive: false,
                  });
                } else {
                  searchRef.current?.findNext(query, {
                    caseSensitive: false,
                  });
                }
              } else if (event.key === "Escape") {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
            placeholder="Find in terminal"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground/60"
            aria-label="Find in terminal"
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            onClick={() => searchRef.current?.findPrevious(query, { caseSensitive: false })}
          >
            <ChevronUp className="size-3" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            onClick={() => searchRef.current?.findNext(query, { caseSensitive: false })}
          >
            <ChevronDown className="size-3" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Close search"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}

      <div
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        className="min-h-0 flex-1 overflow-hidden px-2 py-1.5"
      />

      {error ? (
        <p className="shrink-0 border-t border-border bg-destructive/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Workspace terminal with independent xterm.js tabs over the Box PTY. */
export function WorkspaceTerminal({ workspaceId }: { workspaceId: string }) {
  const [tabs, setTabs] = useState(() => [{ id: newTabId(), index: 1 }]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [status, setStatus] = useState<PaneStatus>({
    phase: "idle",
    sessionId: null,
    exitCode: null,
    error: null,
  });
  const nextIndexRef = useRef(2);

  function addTab() {
    if (tabs.length >= MAX_TABS) return;
    const tab = { id: newTabId(), index: nextIndexRef.current++ };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }

  function closeTab(id: string) {
    const closingIndex = tabs.findIndex((tab) => tab.id === id);
    if (tabs.length === 1) {
      const tab = { id: newTabId(), index: nextIndexRef.current++ };
      setTabs([tab]);
      setActiveId(tab.id);
      return;
    }
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (id === activeId) {
      setActiveId(next[Math.min(closingIndex, next.length - 1)].id);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-sidebar/60 px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-7 shrink-0 items-center rounded-md border text-[10px] transition",
                  selected
                    ? "border-border bg-surface text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/40",
                )}
              >
                <button
                  type="button"
                  onClick={() => setActiveId(tab.id)}
                  className="flex h-full items-center gap-1.5 px-2 font-mono"
                >
                  <TerminalSquare className="size-3" />
                  bash {tab.index}
                </button>
                {selected && tabs.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => closeTab(tab.id)}
                    aria-label={`Close terminal tab ${tab.index}`}
                    className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            onClick={addTab}
            disabled={tabs.length >= MAX_TABS}
            aria-label="New terminal tab"
            title={tabs.length >= MAX_TABS ? "Maximum 4 tabs" : "New tab"}
            className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <span className="hidden shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/60 sm:inline">
          {status.phase}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn("h-full min-h-0", tab.id !== activeId && "hidden")}
          >
            <TerminalPane
              workspaceId={workspaceId}
              index={tab.index}
              active={tab.id === activeId}
              onStatus={setStatus}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
