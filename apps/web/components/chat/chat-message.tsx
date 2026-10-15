"use client";

import { useState } from "react";
import type { RunStatus } from "@buildx/shared";
import {
  Bot,
  Check,
  Copy,
  Pencil,
  RefreshCw,
  User,
} from "lucide-react";
import { ActivityCard } from "@/components/agent/activity-timeline";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/lib/chat-messages";
import { cn } from "@/lib/utils";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function ThinkingIndicator() {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span className="flex gap-1">
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.2s] motion-reduce:animate-none" />
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.1s] motion-reduce:animate-none" />
        <span className="size-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
      </span>
      Thinking…
    </div>
  );
}

function MessageActions({
  text,
  onRetry,
  onEdit,
}: {
  text?: string;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!text && !onRetry && !onEdit) return null;

  return (
    <div className="mt-2 flex items-center gap-1 opacity-0 transition group-hover/msg:opacity-100 focus-within:opacity-100">
      {text ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Copy message"
          onClick={() => {
            void copyText(text).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      ) : null}
      {onRetry ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Retry"
          onClick={onRetry}
        >
          <RefreshCw className="size-3" />
        </Button>
      ) : null}
      {onEdit ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Edit and resubmit"
          onClick={onEdit}
        >
          <Pencil className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}

export function ChatMessageView({
  message,
  showThinking,
  onRetry,
  onEdit,
}: {
  message: ChatMessage;
  showThinking?: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const isUser = message.role === "user";
  const text = message.blocks
    .filter((b) => b.kind === "text" || b.kind === "error")
    .map((b) => b.text ?? "")
    .join("\n\n");

  return (
    <div
      className={cn(
        "group/msg flex gap-3",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
          <Bot className="size-4 text-muted-foreground" />
        </div>
      ) : null}

      <div className={cn("min-w-0 max-w-[min(100%,42rem)]", isUser && "order-first")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-3",
            isUser
              ? "bg-secondary text-secondary-foreground"
              : "border border-border bg-card/40",
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
          ) : (
            <div className="space-y-3">
              {message.blocks.map((block) => {
                if (block.kind === "text" && block.text) {
                  return (
                    <div key={block.id} className="relative">
                      <ChatMarkdown content={block.text} />
                      {block.streaming ? (
                        <span
                          aria-hidden
                          className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-foreground/80 motion-reduce:animate-none"
                        />
                      ) : null}
                    </div>
                  );
                }
                if (block.kind === "error" && block.text) {
                  return (
                    <p
                      key={block.id}
                      className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300"
                    >
                      {block.text}
                    </p>
                  );
                }
                if (block.kind === "status" && block.item?.kind === "status") {
                  return (
                    <div key={block.id} className="flex items-center gap-2">
                      <StatusBadge status={block.item.status as RunStatus} />
                      {block.text ? (
                        <span className="text-xs text-muted-foreground">
                          {block.text}
                        </span>
                      ) : null}
                    </div>
                  );
                }
                if (block.kind === "activity" && block.item) {
                  return <ActivityCard key={block.id} item={block.item} />;
                }
                return null;
              })}
              {showThinking ? <ThinkingIndicator /> : null}
            </div>
          )}
        </div>
        <MessageActions
          text={text}
          onRetry={isUser ? undefined : onRetry}
          onEdit={isUser ? onEdit : undefined}
        />
      </div>

      {isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
          <User className="size-4 text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}
