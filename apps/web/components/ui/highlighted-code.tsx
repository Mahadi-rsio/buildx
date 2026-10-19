"use client";

import { useEffect, useState } from "react";
import { highlightCode, plainCodeHtml } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/**
 * Shiki-rendered code with a plain, escaped first paint. Highlighting happens
 * after mount so opening a large tool result never blocks the thread.
 */
export function HighlightedCode({
  code,
  lang = "text",
  wrap = false,
  className,
}: {
  code: string;
  lang?: string;
  wrap?: boolean;
  className?: string;
}) {
  const [html, setHtml] = useState<{ key: string; html: string } | null>(null);
  const key = `${lang}\u0000${code}`;
  const rendered = html?.key === key ? html.html : null;

  useEffect(() => {
    let alive = true;
    void highlightCode(code, lang).then((next) => {
      if (alive) setHtml({ key, html: next });
    });
    return () => {
      alive = false;
    };
  }, [key, code, lang]);

  return (
    <div
      className={cn(
        "overflow-x-auto font-mono text-xs leading-5",
        "[&_.shiki]:m-0 [&_.shiki]:bg-transparent [&_.shiki]:p-0",
        wrap && "[&_.line]:whitespace-pre-wrap [&_.line]:break-words",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: rendered ?? plainCodeHtml(code) }}
    />
  );
}
