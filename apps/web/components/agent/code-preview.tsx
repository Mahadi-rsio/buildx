"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsDownUp, Copy, FileCode2, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { guessLanguage } from "@/lib/chat-messages";
import { computeLineDiff, type DiffRow } from "@/lib/diff";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy code",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      className={className}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </Button>
  );
}

const COLLAPSE_AT = 14;

/**
 * A bordered code panel: header row (filename · language · copy), horizontally
 * scrollable body with a non-selectable CSS line-number column, and a "Show
 * more" toggle for long files. The language is loaded lazily once per process.
 */
export function CodePreview({
  code,
  language,
  filename,
  showLineNumbers = true,
}: {
  code: string;
  language?: string;
  filename?: string;
  showLineNumbers?: boolean;
}) {
  const [html, setHtml] = useState<{ key: string; html: string } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const lineCount = useMemo(() => code.split("\n").length, [code]);

  const lang = language || guessLanguage(filename ?? "");
  const key = `${lang}\u0000${code}`;
  // Derive the resolved HTML during render; keep the "resetting to null"
  // out of the effect (a synchronous setState there is flagged as a lint error).
  const rendered = html?.key === key ? html.html : null;

  useEffect(() => {
    let alive = true;
    void highlightCode(code, lang).then((next) => {
      if (!alive) return;
      setHtml({ key, html: next });
    });
    return () => {
      alive = false;
    };
  }, [key, code, lang]);

  const collapsed = !expanded && lineCount > COLLAPSE_AT;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface/60 px-3 py-1.5">
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground/80">
          {filename || "code"}
        </span>
        {language ? (
          <span className="shrink-0 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
            {language}
          </span>
        ) : null}
        <CopyButton value={code} />
      </div>
      <div
        className={cn(
          "relative",
          collapsed ? "max-h-64 overflow-hidden" : "max-h-96 overflow-auto",
        )}
      >
        <div
          className={cn(
            "py-2 pl-3 pr-1",
            showLineNumbers && "code-lines",
          )}
        >
          {rendered ? (
            <div
              className="overflow-x-auto [&_.shiki]:text-xs [&_.shiki]:leading-[1.6]"
              dangerouslySetInnerHTML={{ __html: rendered }}
            />
          ) : (
            <div className="px-3 py-1 font-mono text-xs text-muted-foreground">
              Highlighting…
            </div>
          )}
        </div>
        {collapsed ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-surface-elevated to-transparent" />
        ) : null}
      </div>
      {lineCount > COLLAPSE_AT ? (
        <div className="border-t border-border/70">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full rounded-none text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <ChevronsDownUp className="size-3.5" />
            {expanded ? "Show less" : `Show more (${lineCount - COLLAPSE_AT} more lines)`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Red/green line diff for edit_file old_str → new_str. */
export function DiffCode({
  oldText,
  newText,
  filename,
}: {
  oldText: string;
  newText: string;
  filename?: string;
}) {
  const rows = useMemo(
    () => computeLineDiff(oldText, newText),
    [oldText, newText],
  );
  const removed = rows.filter((r) => r.type === "del").length;
  const added = rows.filter((r) => r.type === "add").length;

  const tone = (row: DiffRow) =>
    row.type === "add"
      ? "text-success"
      : row.type === "del"
        ? "text-danger"
        : "text-muted-foreground";
  const bg = (row: DiffRow) =>
    row.type === "add"
      ? "bg-success/10"
      : row.type === "del"
        ? "bg-danger/10"
        : "";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface/40">
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface/60 px-3 py-1.5">
        <GitCompare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground/80">
          {filename || "edit_file"}
        </span>
        <span className="shrink-0 font-mono text-2xs text-danger">
          −{removed}
        </span>
        <span className="shrink-0 font-mono text-2xs text-success">
          +{added}
        </span>
        <CopyButton value={`${oldText}\n${newText}`} label="Copy diff" />
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-relaxed">
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className={cn("align-top", bg(row))}>
                <td className="w-6 select-none border-r border-border/60 py-0.5 pl-2 pr-1.5 text-center align-top text-muted-foreground/50 [white-space:pre]">
                  {row.type === "add" ? "+" : row.type === "del" ? "−" : ""}
                </td>
                <td className={cn("whitespace-pre-wrap break-words py-0.5 pr-3", tone(row))}>
                  {row.text || " "}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}