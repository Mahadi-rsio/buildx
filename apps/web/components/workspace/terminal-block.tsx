"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Terminal } from "lucide-react";
import { CopyButton } from "@/components/agent/code-preview";
import { Button } from "@/components/ui/button";
import { ansiToHtml, ansiToText, hasAnsi } from "@/lib/ansi";
import { formatBytes, formatLines } from "@/lib/format";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/**
 * Extract a printable output body from a bash tool result. The agent's tools
 * return `{ output: string }`; accept `stdout`/`stderr`/`output`/`text`
 * object shapes and never render raw JSON or newline escapes as text.
 */
export function bashOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const value =
    typeof record.output === "string" ? record.output : undefined;
  if (value !== undefined) return value;
  if (typeof record.text === "string") return record.text;
  if (typeof record.stdout === "string") {
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const parts = [record.stdout, stderr].filter((part) => part.length > 0);
    return parts.join(parts[0] && parts[1] ? "\n" : "");
  }
  return "";
}

/** Human label for an exit code that isn't zero, or null for success. */
export function exitCodeChip(result: unknown): { code: number; text: string } | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const exitCode = record.exit_code ?? record.exitCode;
  const code = Number(exitCode);
  if (!Number.isFinite(code) || code === 0) return null;
  return { code, text: `exit ${code}` };
}

const MAX_BLOCK_HEIGHT = 240;

/**
 * A terminal-style block for one bash tool execution: the command with a `$`
 * prompt, then the captured stdout/stderr below. Output auto-scrolls while the
 * step is streaming and pauses once the user scrolls up.
 */
export function TerminalBlock({
  command,
  output,
  result,
  streaming = false,
  maxHeight = MAX_BLOCK_HEIGHT,
  className,
}: {
  command?: string;
  output?: string;
  /** Raw tool result, used to surface ANSI + exit code when present. */
  result?: unknown;
  streaming?: boolean;
  maxHeight?: number;
  className?: string;
}) {
  const [commandHtml, setCommandHtml] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const body = output ?? bashOutput(result);
  const exit = exitCodeChip(result);
  const bodyText = hasAnsi(body) ? ansiToText(body) : body;
  const bodyHtml = useMemo(() => ansiToHtml(body), [body]);
  const lineCount = useMemo(
    () => (body.length > 0 ? body.split("\n").length : 0),
    [body],
  );
  const exceeded = lineCount > 60 || body.length > 4000;

  useEffect(() => {
    if (!command) return;
    let alive = true;
    void highlightCode(command, "bash").then((html) => {
      if (!alive) return;
      setCommandHtml(html);
    });
    return () => {
      alive = false;
    };
  }, [command]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      atBottomRef.current =
        el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [body, bodyHtml]);

  const showFrame = Boolean(command) || body.length > 0;

  if (!showFrame) return null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-surface/60",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface/80 px-3 py-1.5">
        <Terminal className="size-3.5 shrink-0 text-warning" />
        <span className="shrink-0 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
          bash
        </span>
        {command ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground/80">
            {command.split("\n")[0]}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {exit ? (
          <span className="shrink-0 rounded-sm border border-danger/30 bg-danger/10 px-1.5 py-px font-mono text-2xs text-danger">
            {exit.text}
          </span>
        ) : null}
        {exceeded ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={expanded ? "Collapse terminal" : "Expand terminal"}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <Minimize2 className="size-3" />
            ) : (
              <Maximize2 className="size-3" />
            )}
          </Button>
        ) : null}
        <CopyButton value={bodyText} label="Copy terminal output" />
      </div>

      <div
        ref={scrollRef}
        style={{ maxHeight: expanded ? "60vh" : maxHeight }}
        className="overflow-auto overscroll-contain p-2.5 font-mono text-[11px] leading-relaxed motion-reduce:transition-none"
      >
        {command ? (
          <div className="flex gap-2">
            <span className="shrink-0 select-none text-success">
              {streaming ? <span className="term-cursor" aria-hidden /> : "$"}
            </span>
            <div
              className={cn(
                "min-w-0 flex-1",
                "[&_.shiki]:m-0 [&_.shiki]:bg-transparent [&_.shiki]:text-foreground/90 [&_.shiki]:text-[11px] [&_.shiki]:leading-relaxed",
              )}
              dangerouslySetInnerHTML={{
                __html: commandHtml ?? `<pre class="shiki"><code>…</code></pre>`,
              }}
            />
          </div>
        ) : null}

        {body.length > 0 ? (
          <div className={cn(command && "mt-1 border-t border-border/50 pt-1.5")}>
            {hasAnsi(body) ? (
              <div
                className="whitespace-pre-wrap break-words text-foreground/85"
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words text-foreground/85">
                {body}
              </pre>
            )}
          </div>
        ) : null}

        {streaming && body.length === 0 && command ? (
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-warning" />
            <span className="text-[11px]">Waiting for output…</span>
          </div>
        ) : null}
      </div>

      {exceeded ? (
        <div className="flex items-center justify-between border-t border-border/70 bg-surface/80 px-3 py-1">
          <span className="font-mono text-2xs text-muted-foreground">
            {formatLines(lineCount)} lines · {formatBytes(new Blob([body]).size)}
          </span>
        </div>
      ) : null}
    </div>
  );
}