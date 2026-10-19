"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FileArchive,
  FileImage,
  Maximize2,
  Minimize2,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { FileIcon } from "@/components/workspace/file-icon";
import { guessLanguage } from "@/lib/language";
import { formatBytes, formatLines } from "@/lib/format";
import { highlightCode, plainCodeHtml } from "@/lib/highlight";
import { cn } from "@/lib/utils";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label="Copy file contents"
      title="Copy file contents"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

const IS_IMAGE = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
const IS_MARKDOWN = /\.(md|mdx|markdown)$/i;
/** Soft cap at which the code body collapses into a "show all" footer. */
const MAX_CODE_LINES = 1000;
const MAX_CODE_BYTES = 200_000;

/**
 * Read-only file viewer for the Files tab: highlighted code with a CSS line
 * number column, wrap toggle, markdown preview, and a graceful fallback for
 * images and binary files. Scoped to the panel — no page scroll.
 */
export function CodeViewer({ path, content }: { path: string; content: string }) {
  const [html, setHtml] = useState<{ key: string; html: string } | null>(null);
  const [wrap, setWrap] = useState(false);
  const [preview, setPreview] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const lang = guessLanguage(path);
  const markdown = IS_MARKDOWN.test(path);
  const image = IS_IMAGE.test(path);

  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const exceeded = lineCount > MAX_CODE_LINES || content.length > MAX_CODE_BYTES;

  const key = `${lang}\u0000${content}`;
  const rendered = html?.key === key ? html.html : null;

  useEffect(() => {
    let alive = true;
    void highlightCode(content, lang).then((next) => {
      if (!alive) return;
      setHtml({ key, html: next });
    });
    return () => {
      alive = false;
    };
  }, [key, content, lang]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border bg-sidebar/60 px-1.5 py-1">
        <FileIcon path={path} className="size-4" />
        <span className="min-w-0 flex-1 truncate font-mono text-filename font-medium text-foreground/85">
          {path}
        </span>
        <span className="shrink-0 font-mono text-tiny uppercase tracking-wide text-muted-foreground">
          {formatBytes(content.length)}
        </span>
        <span className="shrink-0 font-mono text-tiny tabular-nums text-muted-foreground">
          {formatLines(lineCount)} lines
        </span>

        {markdown ? (
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5"
            role="group"
            aria-label="View mode"
          >
            <button
              type="button"
              onClick={() => setPreview(true)}
              aria-pressed={preview}
              className={cn(
                "rounded px-1.5 py-0.5 text-tiny transition",
                preview
                  ? "bg-muted/70 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setPreview(false)}
              aria-pressed={!preview}
              className={cn(
                "rounded px-1.5 py-0.5 text-tiny transition",
                !preview
                  ? "bg-muted/70 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Code
            </button>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setWrap((v) => !v)}
          aria-pressed={wrap}
          aria-label={wrap ? "Disable line wrapping" : "Wrap long lines"}
          title={wrap ? "Disable line wrapping" : "Wrap long lines"}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/60 hover:text-foreground",
            wrap && "bg-muted/60 text-foreground",
          )}
        >
          <WrapText className="size-3.5" />
        </button>

        {exceeded ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse long file" : "Expand long file"}
            title={expanded ? "Collapse long file" : "Expand long file"}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
          >
            {expanded ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </button>
        ) : null}

        <CopyButton value={content} />
      </header>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {markdown && preview ? (
          <div className="max-w-[52rem] p-4">
            <ChatMarkdown content={content} />
          </div>
        ) : image ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <FileImage className="size-6 text-muted-foreground/60" />
            <p className="font-mono text-secondary text-muted-foreground">
              Binary image — content is not streamed to the browser.
            </p>
          </div>
        ) : content.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <FileArchive className="size-6 text-muted-foreground/60" />
            <p className="font-mono text-secondary text-muted-foreground">
              Empty file.
            </p>
          </div>
        ) : (
          <div
            className="code-lines py-2 pl-3 pr-1"
            style={exceeded && !expanded ? { maxHeight: 420 } : undefined}
          >
            <div
              className={cn(
                "overflow-x-auto",
                wrap && "overflow-x-clip",
                "[&_.shiki]:text-code [&_.shiki]:leading-[1.6]",
                wrap && "[&_.line]:whitespace-pre-wrap [&_.line]:break-words",
              )}
              dangerouslySetInnerHTML={{
                __html: rendered ?? plainCodeHtml(content),
              }}
            />
          </div>
        )}
      </div>

      {exceeded && lineCount > MAX_CODE_LINES && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 border-t border-border bg-sidebar/60 py-1 font-mono text-tiny text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
        >
          Show all {formatLines(lineCount)} lines
        </button>
      ) : null}
    </div>
  );
}