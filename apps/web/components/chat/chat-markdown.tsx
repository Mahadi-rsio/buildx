"use client";

import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
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

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<{ key: string; html: string } | null>(null);
  const language = /language-(\w+)/.exec(className ?? "")?.[1] ?? "text";
  const code = String(children).replace(/\n$/, "");
  const key = `${language}\u0000${code}`;
  const rendered = html?.key === key ? html.html : null;

  useEffect(() => {
    let alive = true;
    void highlightCode(code, language).then((next) => {
      if (!alive) return;
      setHtml({ key, html: next });
    });
    return () => {
      alive = false;
    };
  }, [key, code, language]);

  return (
    <div className="group relative my-3 overflow-hidden rounded-md bg-[var(--surface)]">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
          {language}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Copy code"
          onClick={() => {
            void copyText(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      <div className="overflow-x-auto px-3 py-2 [&_.shiki]:font-mono [&_.shiki]:text-xs [&_.shiki]:leading-[1.6]">
        {rendered ? (
          <div dangerouslySetInnerHTML={{ __html: rendered }} />
        ) : (
          <pre className="font-mono text-xs leading-[1.6] text-foreground/90">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function ChatMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "prose-buildx max-w-[68ch] [overflow-wrap:anywhere] text-[15px] leading-[1.6] text-[var(--text)] md:text-[16px] md:leading-[1.65]",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--text)] underline underline-offset-2 decoration-[var(--text-faint)] hover:decoration-[var(--text)]"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-3 text-sm font-semibold first:mt-0">
              {children}
            </h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 pl-3 text-[var(--text-muted)]">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-md bg-[var(--surface)]">
              <table className="w-full border-collapse text-left text-sm">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 font-medium text-[var(--text)]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 align-top text-[var(--text-muted)]">
              {children}
            </td>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = Boolean(className?.includes("language-"));
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code
                className="rounded-[4px] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[13px] text-[var(--text)]"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}