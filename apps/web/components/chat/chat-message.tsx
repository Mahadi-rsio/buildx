"use client";

import { useState, type ReactNode } from "react";
import type { RunStatus } from "@buildx/shared";
import { Check, Copy, Pencil, RefreshCw } from "lucide-react";
import { ToolCallRow } from "@/components/tool/tool-row";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { ThinkingStatus } from "@/components/chat/thinking-trace";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { ChatBlock, ChatMessage } from "@/lib/chat-messages";
import { formatTokens, type TokenUsage } from "@/lib/tokens";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function UsageFooter({ usage }: { usage: TokenUsage }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-2xs text-[var(--text-faint)]">
      <span title="Input tokens">in {formatTokens(usage.inputTokens)}</span>
      <span>·</span>
      <span title="Output tokens">out {formatTokens(usage.outputTokens)}</span>
      <span>·</span>
      <span className="tabular-nums" title="Total tokens">
        {formatTokens(usage.totalTokens)} total
      </span>
      {usage.estimated ? (
        <span className="uppercase tracking-wide">EST</span>
      ) : null}
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
    <div className="mt-2 flex items-center gap-0.5 opacity-0 transition group-hover/msg:opacity-100 focus-within:opacity-100">
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

function TextBlock({ block }: { block: ChatBlock }) {
  if (block.kind !== "text" || !block.text) return null;
  return (
    <div className="relative" aria-live={block.streaming ? "polite" : undefined}>
      <ChatMarkdown content={block.text} />
      {block.streaming ? (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-[var(--text-muted)] motion-reduce:animate-none"
        />
      ) : null}
    </div>
  );
}

function ErrorBlock({ block }: { block: ChatBlock }) {
  if (block.kind !== "error" || !block.text) return null;
  return (
    <div role="alert" className="rounded-md bg-[var(--surface)] px-3 py-2">
      <p className="text-[13px] font-medium text-[var(--text)]">Run failed</p>
      <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs text-[var(--text-muted)]">
        {block.text}
      </p>
    </div>
  );
}

function StatusBlock({ block }: { block: ChatBlock }) {
  if (block.kind !== "status" || block.item?.kind !== "status") return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <StatusBadge status={block.item.status as RunStatus} />
      {block.text ? (
        <span className="min-w-0 text-[var(--text-muted)]">{block.text}</span>
      ) : null}
    </div>
  );
}

function AssistantBlocks({
  message,
  showThinking,
  cancelled,
}: {
  message: ChatMessage;
  showThinking?: boolean;
  cancelled?: boolean;
}) {
  const nodes: ReactNode[] = [];
  const blocks = message.blocks;
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];

    if (block.kind === "activity" && block.item) {
      const rows: ReactNode[] = [];
      const groupKey = block.id;
      while (
        index < blocks.length &&
        blocks[index].kind === "activity" &&
        blocks[index].item
      ) {
        const current = blocks[index];
        rows.push(
          <ToolCallRow
            key={current.id}
            item={current.item!}
            cancelled={cancelled}
          />,
        );
        index += 1;
      }
      nodes.push(
        <div key={`group-${groupKey}`} className="flex flex-col">
          {rows}
        </div>,
      );
      continue;
    }

    if (block.kind === "text") {
      nodes.push(<TextBlock key={block.id} block={block} />);
    } else if (block.kind === "error") {
      nodes.push(<ErrorBlock key={block.id} block={block} />);
    } else if (block.kind === "status") {
      nodes.push(<StatusBlock key={block.id} block={block} />);
    }
    index += 1;
  }

  return (
    <div className="flex flex-col gap-3">
      {nodes}
      {showThinking ? <ThinkingStatus blocks={message.blocks} /> : null}
    </div>
  );
}

export function ChatMessageView({
  message,
  showThinking,
  cancelled,
  onRetry,
  onEdit,
}: {
  message: ChatMessage;
  showThinking?: boolean;
  cancelled?: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const isUser = message.role === "user";
  const text = message.blocks
    .filter((b) => b.kind === "text" || b.kind === "error")
    .map((b) => b.text ?? "")
    .join("\n\n");

  if (isUser) {
    return (
      <div className="group/msg flex flex-col items-end">
        <div className="max-w-[85%] rounded-[10px] bg-[var(--surface)] px-3 py-2">
          <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.6] text-[var(--text)] md:text-[16px] md:leading-[1.65]">
            {text}
          </p>
        </div>
        <MessageActions text={text} onEdit={onEdit} />
      </div>
    );
  }

  return (
    <div className="group/msg w-full min-w-0">
      <AssistantBlocks
        message={message}
        showThinking={showThinking}
        cancelled={cancelled}
      />
      {message.usage ? <UsageFooter usage={message.usage} /> : null}
      <MessageActions text={text} onRetry={onRetry} />
    </div>
  );
}
