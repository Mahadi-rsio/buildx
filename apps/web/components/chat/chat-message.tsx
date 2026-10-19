"use client";

import { useMemo, useState } from "react";
import type { RunStatus } from "@buildx/shared";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Loader2,
  Pencil,
  RefreshCw,
  User,
  type LucideIcon,
} from "lucide-react";
import {
  classifyTool,
  ToolActivityRow,
} from "@/components/agent/tool-activity";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { ThinkingStatus } from "@/components/chat/thinking-trace";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ChatBlock, ChatMessage } from "@/lib/chat-messages";
import { cn } from "@/lib/utils";
import { formatTokens, type TokenUsage } from "@/lib/tokens";
import type { StreamItem } from "@/components/run-events";

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

type Group =
  | { key: string; kind: "single"; block: ChatBlock }
  | { key: string; kind: "activity"; blocks: ChatBlock[] };

/** Collapse consecutive activity blocks into a coherent sequence. */
function groupBlocks(blocks: ChatBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (block.kind === "activity") {
      if (last?.kind === "activity") {
        last.blocks.push(block);
        continue;
      }
      groups.push({ key: block.id, kind: "activity", blocks: [block] });
      continue;
    }
    groups.push({ key: block.id, kind: "single", block });
  }
  return groups;
}

const DONE_UNITS: Record<string, string> = {
  Wrote: "files",
  Edited: "files",
  Created: "files",
  Read: "files",
  Ran: "commands",
  Searched: "items",
  Planned: "items",
  Approved: "requests",
  Used: "steps",
};

function summarizeActivity(blocks: ChatBlock[]): {
  label: string;
  Icon: LucideIcon;
  tone: string;
} {
  type Entry = { verb: string; Icon: LucideIcon; tone: string; count: number };
  const counts = new Map<string, Entry>();

  const verbOf = (
    item: StreamItem,
  ): { verb: string; kind: ReturnType<typeof classifyTool> } | null => {
    if (item.kind === "tool") {
      const kind = classifyTool(item.toolName);
      return { verb: kind.done, kind };
    }
    if (item.kind === "file_change") {
      const verb =
        item.change === "create"
          ? "Created"
          : item.change === "edit"
            ? "Edited"
            : "Wrote";
      return { verb, kind: classifyTool("write_file") };
    }
    if (item.kind === "approval") {
      return { verb: "Approved", kind: classifyTool("approval") };
    }
    if (item.kind === "todo") {
      return { verb: "Planned", kind: classifyTool("todo") };
    }
    return null;
  };

  for (const block of blocks) {
    const item = block.item;
    if (!item) continue;
    const info = verbOf(item);
    if (!info) continue;
    const existing = counts.get(info.verb);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(info.verb, {
        verb: info.verb,
        Icon: info.kind.icon,
        tone: info.kind.tone,
        count: 1,
      });
    }
  }

  let best: Entry | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) {
    return { label: "Agent steps", Icon: Loader2, tone: "text-muted-foreground" };
  }
  const unit = DONE_UNITS[best.verb] ?? "steps";
  const noun = best.count === 1 ? unit.replace(/s$/, "") : unit;
  return {
    label: `${best.verb} ${best.count} ${noun}`,
    Icon: best.Icon,
    tone: best.tone,
  };
}

function rowDataStatus(
  item: StreamItem,
  cancelled: boolean | undefined,
): "running" | "failed" | "done" {
  if (cancelled) return "done";
  if (item.kind === "tool") return item.pending ? "running" : item.isError ? "failed" : "done";
  if (item.kind === "approval")
    return item.status === "pending" ? "running" : item.status === "denied" ? "failed" : "done";
  return "done";
}

/** Collapsible sequence of tool steps on a shared timeline rail. */
function ActivityGroup({
  blocks,
  cancelled,
}: {
  blocks: ChatBlock[];
  cancelled?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const running = blocks.some((b) => {
    const item = b.item;
    if (!item) return false;
    return (
      (item.kind === "tool" && item.pending) ||
      (item.kind === "approval" && item.status === "pending")
    );
  });
  const failed = blocks.some((b) => {
    const item = b.item;
    if (!item) return false;
    return (
      (item.kind === "tool" && Boolean(item.isError)) ||
      (item.kind === "approval" && item.status === "denied")
    );
  });
  const effectiveOpen = open || running || failed;
  const { label, Icon, tone } = summarizeActivity(blocks);

  return (
    <Collapsible open={effectiveOpen} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-lg border border-border bg-surface/30">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40">
          <Icon className={cn("size-3.5 shrink-0", tone)} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
            {label}
          </span>
          {running ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground/70 motion-reduce:animate-none" />
          ) : failed ? (
            <AlertCircle className="size-3.5 shrink-0 text-danger" />
          ) : (
            <CheckCircle2 className="size-3.5 shrink-0 text-success/70" />
          )}
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              effectiveOpen && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="timeline-rail space-y-1 border-t border-border/60 px-3 py-2">
            {blocks.map((block) =>
              block.item ? (
                <div
                  key={block.id}
                  data-status={rowDataStatus(block.item, cancelled)}
                >
                  <ToolActivityRow item={block.item} cancelled={cancelled} />
                </div>
              ) : null,
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function UsageFooter({ usage }: { usage: TokenUsage }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-2xs text-muted-foreground/80">
      <span title="Input tokens">in {formatTokens(usage.inputTokens)}</span>
      <span className="text-muted-foreground/40">·</span>
      <span title="Output tokens">out {formatTokens(usage.outputTokens)}</span>
      <span className="text-muted-foreground/40">·</span>
      <span className="tabular-nums" title="Total tokens">
        {formatTokens(usage.totalTokens)} total
      </span>
      <span
        className={cn(
          "rounded px-1 py-px uppercase tracking-wide text-2xs",
          usage.estimated
            ? "bg-muted/70 text-muted-foreground"
            : "bg-success/10 text-success",
        )}
      >
        {usage.estimated ? "est" : "usage"}
      </span>
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

export function ChatMessageView({
  message,
  showThinking,
  cancelled,
  onRetry,
  onEdit,
}: {
  message: ChatMessage;
  showThinking?: boolean;
  /** Run was cancelled/stopped — render pending steps as cancelled. */
  cancelled?: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const isUser = message.role === "user";
  const text = message.blocks
    .filter((b) => b.kind === "text" || b.kind === "error")
    .map((b) => b.text ?? "")
    .join("\n\n");
  const groups = useMemo(() => groupBlocks(message.blocks), [message.blocks]);

  const body = isUser ? (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
      {text}
    </p>
  ) : (
    <div className="space-y-3">
      {groups.map((group) => {
        if (group.kind === "activity") {
          return (
            <ActivityGroup
              key={group.key}
              blocks={group.blocks}
              cancelled={cancelled}
            />
          );
        }

        const { block } = group;
        if (block.kind === "text" && block.text) {
          return (
            <div
              key={block.id}
              className="relative"
              aria-live={block.streaming ? "polite" : undefined}
            >
              <ChatMarkdown content={block.text} />
              {block.streaming ? (
                <span
                  aria-hidden
                  className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-foreground/70 motion-reduce:animate-none"
                />
              ) : null}
            </div>
          );
        }
        if (block.kind === "error" && block.text) {
          return (
            <div
              key={block.id}
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2"
            >
              <p className="text-xs font-medium text-danger">Run failed</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs text-danger/90">
                {block.text}
              </p>
            </div>
          );
        }
        if (block.kind === "status" && block.item?.kind === "status") {
          return (
            <div key={block.id} className="flex items-center gap-2 text-xs">
              <StatusBadge status={block.item.status as RunStatus} />
              {block.text ? (
                <span className="min-w-0 text-muted-foreground">{block.text}</span>
              ) : null}
            </div>
          );
        }
        return null;
      })}
      {showThinking ? <ThinkingStatus blocks={message.blocks} /> : null}
    </div>
  );

  return (
    <div className="group/msg flex items-start gap-3">
      <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface/60">
        {isUser ? (
          <User className="size-4 text-muted-foreground" />
        ) : (
          <Bot className="size-4 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1 max-w-[min(100%,46rem)]">
        {body}

        {!isUser && message.usage ? (
          <UsageFooter usage={message.usage} />
        ) : null}

        <MessageActions
          text={text}
          onRetry={isUser ? undefined : onRetry}
          onEdit={isUser ? onEdit : undefined}
        />
      </div>
    </div>
  );
}